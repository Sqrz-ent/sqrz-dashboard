import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { finishRun, sandboxSql, startRun } from "../_shared/outlets/sandbox-db.ts";
import { primeOutletSecrets, scrubSecrets } from "../_shared/outlets/outlet-secrets.ts";
import { OUTLET_ADAPTERS } from "../_shared/outlets/registry.ts";
import { ConfigError, OutletError, type OutletName, ParamError } from "../_shared/outlets/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// sandbox-admin — backend for the iOS "sandbox sheet": see each outlet's setup status, paste API
// keys, test connections.   ISOLATED SANDBOX — not used by the live app's features.
//
// !! ACCESS = accounts.is_lab. Anyone with is_lab can see setup status and REPLACE API KEYS.
// !! Before adding external Lab testers, switch this check to a dedicated admin flag.
//
// Unlike the other sandbox-* functions this one uses NORMAL JWT verification (deploy WITHOUT
// --no-verify-jwt) and, on top of it, checks the caller server-side via the caller's own JWT:
// the public.caller_account_is_lab() RPC (from 20261101_lab_outlet_templates.sql). Not lab → 403.
//
// POST { action, params } with  Authorization: Bearer <user access token>:
//   list_outlets                                      → status, checklist, notes, secrets set? (+ last 4 chars)
//   update_outlet        { outlet, status?, checklist?, notes? }
//   set_secret           { outlet, name, value }      → Vault (name must be in that outlet's secrets)
//   delete_secret        { outlet, name }
//   test_connection      { outlet }                   → adapter.ping(); success sets status "connected"
//   list_manual_campaigns{ outlet, status?, limit? }
//   list_runs            { outlet, limit? }           → last 20 outlet_runs of that outlet
// Secret VALUES are never returned or logged — only "set" and the last 4 characters (and only when
// the value is ≥12 chars). Mutating actions are logged to outlet_sandbox.outlet_runs (action admin_*).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ACTIONS = ["list_outlets", "update_outlet", "set_secret", "delete_secret", "test_connection", "list_manual_campaigns", "list_runs"] as const;
type Action = typeof ACTIONS[number];
type Params = Record<string, unknown>;
const STATUSES = ["not_started", "account_created", "applied", "approved", "keys_set", "connected"] as const;
const rank = (s: string) => (STATUSES as readonly string[]).indexOf(s);

class NotFound extends Error {}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── auth: verified JWT + server-side is_lab check with the caller's own token ────────────────────
async function authorize(req: Request): Promise<{ userId: string } | Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "unauthorized" }, 401);
  const { data: isLab, error: rpcErr } = await client.rpc("caller_account_is_lab");
  if (rpcErr) {
    console.error("[sandbox-admin] is_lab check failed:", rpcErr.message);
    return json({ error: "authorization check failed" }, 500);
  }
  if (isLab !== true) return json({ error: "forbidden" }, 403);
  return { userId: data.user.id };
}

// ── param helpers ───────────────────────────────────────────────────────────────────────────────
function outletParam(p: Params): string {
  const v = p.outlet;
  if (typeof v !== "string" || !/^[a-z0-9_]{1,40}$/.test(v.trim().toLowerCase())) throw new ParamError("params.outlet must be an outlet token, e.g. tiktok");
  return v.trim().toLowerCase();
}
function secretName(p: Params): string {
  const v = p.name;
  if (typeof v !== "string" || !/^[A-Z][A-Z0-9_]{2,80}$/.test(v)) throw new ParamError("params.name must be a secret name like TIKTOK_ADS_ACCESS_TOKEN");
  return v;
}
function limitParam(p: Params, def: number, max: number): number {
  const n = p.limit === undefined ? def : Number(p.limit);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ParamError(`params.limit must be an integer 1–${max}`);
  return n;
}
function checklistParam(v: unknown): { key: string; label: string; done: boolean }[] {
  if (!Array.isArray(v) || v.length > 30) throw new ParamError("params.checklist must be an array of at most 30 steps");
  const seen = new Set<string>();
  return v.map((s, i) => {
    const o = s as Record<string, unknown>;
    if (!o || typeof o !== "object" || typeof o.key !== "string" || !/^[a-z0-9_-]{1,40}$/.test(o.key) ||
        typeof o.label !== "string" || !o.label.trim() || o.label.length > 300 || typeof o.done !== "boolean") {
      throw new ParamError(`params.checklist[${i}] must be { key: a-z0-9_-, label: 1–300 chars, done: boolean }`);
    }
    if (seen.has(o.key)) throw new ParamError(`params.checklist has a duplicate key "${o.key}"`);
    seen.add(o.key);
    return { key: o.key, label: o.label.trim(), done: o.done };
  });
}

// ── data access ─────────────────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const sql = () => sandboxSql();

async function outletRow(outlet: string): Promise<Row> {
  const [row] = await sql()`select * from outlet_sandbox.outlets where outlet = ${outlet}`;
  if (!row) throw new NotFound(`unknown outlet "${outlet}"`);
  return row;
}

async function secretStatus(outlet: string): Promise<{ name: string; required: boolean; set: boolean; last4: string | null }[]> {
  const rows = await sql()`select name, required, is_set, last4 from outlet_sandbox.outlet_secret_status(${outlet})`;
  return (rows as unknown as Row[]).map((r) => ({ name: r.name, required: r.required, set: r.is_set, last4: r.last4 }));
}

const sheetRow = (r: Row) => {
  const cl = (r.checklist ?? []) as { done?: boolean }[];
  return { ...r, progress: { done: cl.filter((s) => s.done).length, total: cl.length } };
};

/** keys_set bump / demotion based on whether all REQUIRED secrets are set. Returns the (possibly new) status. */
async function reconcileStatus(row: Row): Promise<string> {
  const secrets = await secretStatus(row.outlet);
  const allRequired = secrets.filter((s) => s.required).every((s) => s.set) && secrets.some((s) => s.required);
  let next = row.status as string;
  if (allRequired && rank(next) < rank("keys_set")) next = "keys_set";
  else if (!allRequired && rank(next) >= rank("keys_set")) next = "approved";
  if (next !== row.status) await sql()`update outlet_sandbox.outlets set status = ${next} where outlet = ${row.outlet}`;
  return next;
}

/** Log a mutating admin action to outlet_runs (request is sanitized by the caller — never a secret value). */
async function audited<T>(
  outlet: string, action: string, request: Record<string, unknown>, fn: () => Promise<T>,
  failed?: (out: T) => string | null, // a result that is a failure (e.g. a connection test) is logged as status "error"
): Promise<T> {
  let runId: string;
  try {
    runId = await startRun(outlet, `admin_${action}`, request);
  } catch (e) {
    console.error("[sandbox-admin] could not write outlet_runs:", e);
    throw new Error("sandbox logging unavailable (is the outlet_sandbox migration applied?)");
  }
  try {
    const out = await fn();
    const failure = failed?.(out) ?? null;
    if (failure) await finishRun(runId, "error", out as unknown, scrubSecrets(failure));
    else await finishRun(runId, "ok", out as unknown);
    return out;
  } catch (e) {
    const msg = scrubSecrets(e instanceof Error ? e.message : String(e));
    try { await finishRun(runId, "error", null, msg); } catch (le) { console.error("[sandbox-admin] failed to finalize run log:", le); }
    throw e;
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const who = await authorize(req);
  if (who instanceof Response) return who;

  let action: Action;
  let params: Params;
  try {
    const body = await req.json();
    if (!ACTIONS.includes(body?.action)) throw new Error();
    action = body.action;
    params = (body.params ?? {}) as Params;
    if (typeof params !== "object" || Array.isArray(params)) throw new Error();
  } catch {
    return json({ error: `body must be { action: ${ACTIONS.join(" | ")}, params?: {} }` }, 400);
  }

  try {
    let result: unknown;

    switch (action) {
      case "list_outlets": {
        const rows = await sql()`
          select o.outlet, o.display_name, o.kind, o.status, o.checklist, o.docs_path, o.notes, o.updated_at,
            coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'required', s.required, 'set', s.is_set, 'last4', s.last4)
                                       order by s.required desc, s.name)
                      from outlet_sandbox.outlet_secret_status(o.outlet) s), '[]'::jsonb) as secrets
          from outlet_sandbox.outlets o
          order by o.kind, o.display_name`;
        result = { outlets: (rows as unknown as Row[]).map(sheetRow) };
        break;
      }

      case "update_outlet": {
        const outlet = outletParam(params);
        const row = await outletRow(outlet);
        let status: string | undefined;
        if ("status" in params) {
          if (typeof params.status !== "string" || !(STATUSES as readonly string[]).includes(params.status)) {
            throw new ParamError(`params.status must be one of ${STATUSES.join(", ")}`);
          }
          status = params.status;
        }
        const checklist = "checklist" in params ? checklistParam(params.checklist) : undefined;
        let notes: string | null | undefined;
        if ("notes" in params) {
          if (params.notes !== null && typeof params.notes !== "string") throw new ParamError("params.notes must be a string or null");
          if (typeof params.notes === "string" && params.notes.length > 5000) throw new ParamError("params.notes must be ≤5000 chars");
          notes = typeof params.notes === "string" && params.notes.trim() ? params.notes : null;
        }
        if (status === undefined && checklist === undefined && notes === undefined) throw new ParamError("nothing to update: pass status, checklist and/or notes");
        if (checklist && row.kind === "api" && checklist.length === 0) throw new ParamError("params.checklist cannot be empty");

        result = await audited(outlet, "update_outlet", { outlet, by: who.userId, status, checklist: checklist ? `${checklist.length} steps` : undefined, notes: notes === undefined ? undefined : "(changed)" }, async () => {
          const [u] = await sql()`
            update outlet_sandbox.outlets set updated_at = now()
              ${status !== undefined ? sql()`, status = ${status}` : sql()``}
              ${checklist !== undefined ? sql()`, checklist = ${sql().json(checklist as never)}` : sql()``}
              ${notes !== undefined ? sql()`, notes = ${notes}` : sql()``}
            where outlet = ${outlet}
            returning *`;
          return { outlet: sheetRow({ ...u, secrets: await secretStatus(outlet) }) };
        });
        break;
      }

      case "set_secret": {
        const outlet = outletParam(params);
        const name = secretName(params);
        const row = await outletRow(outlet);
        if (![...row.required_secrets, ...row.optional_secrets].includes(name)) {
          throw new ParamError(`${name} is not one of ${outlet}'s secrets`);
        }
        if (typeof params.value !== "string") throw new ParamError("params.value must be a string");
        const value = params.value.trim();
        if (!value || value.length > 8192 || value.includes("\u0000")) throw new ParamError("params.value must be 1–8192 characters");

        result = await audited(outlet, "set_secret", { outlet, name, by: who.userId }, async () => {
          await sql()`select outlet_sandbox.set_outlet_secret(${name}, ${value})`;
          const status = await reconcileStatus(row);
          const s = (await secretStatus(outlet)).find((x) => x.name === name);
          return { outlet, name, set: true, last4: s?.last4 ?? null, status };
        });
        break;
      }

      case "delete_secret": {
        const outlet = outletParam(params);
        const name = secretName(params);
        const row = await outletRow(outlet);
        if (![...row.required_secrets, ...row.optional_secrets].includes(name)) {
          throw new ParamError(`${name} is not one of ${outlet}'s secrets`);
        }
        result = await audited(outlet, "delete_secret", { outlet, name, by: who.userId }, async () => {
          const [d] = await sql()`select outlet_sandbox.delete_outlet_secret(${name}) as deleted`;
          const status = await reconcileStatus(row);
          return { outlet, name, set: false, deleted: d.deleted === true, status };
        });
        break;
      }

      case "test_connection": {
        const outlet = outletParam(params);
        const row = await outletRow(outlet);
        if (row.kind !== "api" || !(outlet in OUTLET_ADAPTERS)) throw new ParamError(`"${outlet}" is a manual outlet — there is no connection to test`);
        // Always HTTP 200: a failed test is a result, not a server error.
        result = await audited(outlet, "test_connection", { outlet, via: "sandbox-admin", by: who.userId }, async () => {
          try {
            await primeOutletSecrets(outlet);
            const ping = await OUTLET_ADAPTERS[outlet as OutletName]().ping();
            if (!ping.ok) return { outlet, connected: false, detail: ping.detail, checks: ping.checks ?? null, status: row.status };
            await sql()`update outlet_sandbox.outlets set status = 'connected' where outlet = ${outlet}`;
            return { outlet, connected: true, detail: ping.detail, checks: ping.checks ?? null, status: "connected" };
          } catch (e) {
            if (!(e instanceof ConfigError || e instanceof OutletError || e instanceof ParamError)) throw e;
            return { outlet, connected: false, error: scrubSecrets(e.message), missing_config: e instanceof ConfigError, status: row.status };
          }
        }, (out) => (out.connected ? null : ("error" in out ? String(out.error) : "detail" in out ? String(out.detail) : "connection test failed")));
        break;
      }

      case "list_manual_campaigns": {
        const outlet = outletParam(params);
        await outletRow(outlet);
        const st = params.status;
        if (st !== undefined && (typeof st !== "string" || !["planned", "booked", "running", "done", "cancelled"].includes(st))) {
          throw new ParamError("params.status must be planned, booked, running, done or cancelled");
        }
        const rows = await sql()`
          select * from outlet_sandbox.manual_campaigns
          where outlet = ${outlet} ${st ? sql()`and status = ${st as string}` : sql()``}
          order by created_at desc limit ${limitParam(params, 50, 200)}`;
        result = { outlet, campaigns: rows };
        break;
      }

      case "list_runs": {
        const outlet = outletParam(params);
        await outletRow(outlet);
        const rows = await sql()`
          select id, action, status, error, profile_id, hubspot_deal_id, created_at
          from outlet_sandbox.outlet_runs where outlet = ${outlet}
          order by created_at desc limit ${limitParam(params, 20, 20)}`;
        result = { outlet, runs: rows };
        break;
      }
    }

    return json({ ok: true, action, result });
  } catch (e) {
    const message = scrubSecrets(e instanceof Error ? e.message : String(e));
    console.error(`[sandbox-admin] ${action} failed:`, message);
    const status = e instanceof ParamError ? 400 : e instanceof NotFound ? 404 : 500;
    return json({ ok: false, action, error: message }, status);
  }
});
