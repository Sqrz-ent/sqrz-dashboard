// Logging for sandbox functions → outlet_sandbox.outlet_runs / outlet_objects.
//
// The schema is deliberately NOT exposed via PostgREST, so supabase-js can't
// reach it. We use a direct Postgres connection with SUPABASE_DB_URL (injected
// automatically into every edge function). `prepare: false` keeps it compatible
// with the transaction pooler.

import postgres from "npm:postgres@3.4.4";
import type { ClientLinks, OutletObject } from "./types.ts";

let _sql: ReturnType<typeof postgres> | null = null;

function sql() {
  if (!_sql) {
    const url = Deno.env.get("SUPABASE_DB_URL");
    if (!url) throw new Error("SUPABASE_DB_URL is not set");
    _sql = postgres(url, { prepare: false, max: 1, idle_timeout: 5 });
  }
  return _sql;
}

/** Shared connection for sandbox functions that query their own outlet_sandbox tables (e.g. sandbox-manual). */
export function sandboxSql() {
  return sql();
}

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|^key$/i;

/** Deep-copy with secret-looking keys masked, so params never leak into the log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redact(v),
      ]),
    );
  }
  return value;
}

// postgres.js wants JSON params wrapped; cast keeps the generics out of the way.
// deno-lint-ignore no-explicit-any
const asJson = (v: unknown): any => sql().json((v ?? null) as never);

/** Insert the run row BEFORE calling the outlet, so nothing happens untracked. */
export async function startRun(outlet: string, action: string, request: unknown, links?: ClientLinks): Promise<string> {
  const [row] = await sql()`
    insert into outlet_sandbox.outlet_runs (outlet, action, request, status, profile_id, hubspot_deal_id)
    values (${outlet}, ${action}, ${asJson(redact(request))}, 'running', ${links?.profileId ?? null}, ${links?.hubspotDealId ?? null})
    returning id`;
  return row.id as string;
}

export async function finishRun(
  runId: string,
  status: "ok" | "error",
  response: unknown,
  error?: string,
): Promise<void> {
  await sql()`
    update outlet_sandbox.outlet_runs
       set status = ${status},
           response = ${asJson(response)},
           error = ${error ? error.slice(0, 2000) : null}
     where id = ${runId}`;
}

export async function recordObjects(
  outlet: string,
  runId: string,
  objects: OutletObject[],
  links?: ClientLinks,
): Promise<void> {
  for (const o of objects) {
    await sql()`
      insert into outlet_sandbox.outlet_objects
        (outlet, object_type, external_id, parent_external_id, raw, run_id, profile_id, hubspot_deal_id)
      values (${outlet}, ${o.objectType}, ${o.externalId}, ${o.parentExternalId ?? null},
              ${asJson(o.raw)}, ${runId}, ${links?.profileId ?? null}, ${links?.hubspotDealId ?? null})`;
  }
}

/** Read-only check that a profile exists (the only touch of the live schema), so a bad profile_id is a clean 400, not an FK error. */
export async function profileExists(profileId: string): Promise<boolean> {
  const rows = await sql()`select 1 from public.profiles where id = ${profileId} limit 1`;
  return rows.length > 0;
}
