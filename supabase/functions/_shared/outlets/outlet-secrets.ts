// Outlet API keys: Supabase Vault first, then Deno.env (function secrets).
//
// Keys pasted in the admin sheet (sandbox-admin set_secret) live in Vault as outlet_<NAME>.
// Adapter config loading stays synchronous — requireEnv()/optionalEnv() in sandbox-common call
// getOutletSecret() — so each request first PRIMES a snapshot of that outlet's Vault values
// (primeOutletSecrets, one query via the service-role-only outlet_sandbox.get_outlet_secrets
// function, called over the direct Postgres connection). Lookup order per name:
//   1. Vault snapshot (fresh for this request)   2. Deno.env  (the old function-secret way)
// so existing `supabase secrets set …` setups keep working until a Vault value overrides them.
// If the Vault read fails (migration not applied yet) it logs a warning and falls back to env only.

import { sandboxSql } from "./sandbox-db.ts";

const snapshot = new Map<string, string>();
// Values of secret-looking names we have handed out, so error text can be scrubbed before it is returned/logged.
const handedOut = new Set<string>();
const SECRETISH = /KEY|SECRET|TOKEN|PASSWORD/;

/** One outlet secret by its plain name (e.g. "TIKTOK_ADS_ACCESS_TOKEN"). Vault snapshot first, then env. Never throws. */
export function getOutletSecret(name: string): string | undefined {
  const raw = snapshot.get(name) ?? Deno.env.get(name);
  const v = raw?.trim();
  if (!v) return undefined;
  if (SECRETISH.test(name) && v.length >= 8) handedOut.add(v);
  return v;
}

/** Loads this outlet's Vault secrets into the snapshot (replacing earlier values, including removing deleted ones). */
export async function primeOutletSecrets(outlet: string): Promise<void> {
  try {
    const sql = sandboxSql();
    const [o] = await sql`select required_secrets || optional_secrets as names from outlet_sandbox.outlets where outlet = ${outlet}`;
    for (const n of (o?.names ?? []) as string[]) snapshot.delete(n);
    const rows = await sql`select name, secret from outlet_sandbox.get_outlet_secrets(${outlet})`;
    for (const r of rows as unknown as { name: string; secret: string }[]) snapshot.set(r.name, r.secret);
  } catch (e) {
    console.warn(`[outlet-secrets] Vault read failed for "${outlet}", using function secrets only:`, e instanceof Error ? e.message : e);
  }
}

/** Replaces any secret value this isolate has handed out with [redacted] — use on error text before returning or logging it. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const v of handedOut) if (out.includes(v)) out = out.split(v).join("[redacted]");
  return out;
}
