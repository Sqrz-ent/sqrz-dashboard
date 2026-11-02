import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireSandboxKey } from "../_shared/outlets/sandbox-guard.ts";
import { finishRun, profileExists, sandboxSql, startRun } from "../_shared/outlets/sandbox-db.ts";
import { parseClientLinks } from "../_shared/outlets/sandbox-common.ts";
import { type ClientLinks, ParamError } from "../_shared/outlets/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// sandbox-manual
//
// ISOLATED SANDBOX — not called by the app, no triggers, no cron. Logs campaigns
// booked BY HAND on platforms without an API (AudioGO, Blip, Acast, iHeart AdBuilder,
// Bandsintown, Audiomack Sponsored Songs, SoundCloud Promote, AppLovin, …) into
// outlet_sandbox.manual_campaigns, so a Claude Code session can log and update them
// via curl. Nothing is sent to any platform.
//
// POST { action: "create" | "update" | "list" | "get", params: {...} }
// Client linkage: optional params.profile_id (UUID of a public.profiles row) and params.hubspot_deal_id
// (numeric HubSpot deal id) — stored on create/update (null clears on update), usable as list filters.
// Auth: header x-sandbox-key must equal secret SANDBOX_ADMIN_KEY, else 401.
// Deploy with verify_jwt:false. Every call is also logged to outlet_sandbox.outlet_runs
// (outlet = "manual"), before it runs — if logging fails the call is refused.
// See docs/outlets/manual.md.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = ["create", "update", "list", "get"] as const;
type Action = typeof ACTIONS[number];
type Params = Record<string, unknown>;
const STATUSES = ["planned", "booked", "running", "done", "cancelled"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class NotFound extends Error {}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── validators (each returns the normalized value) ───────────────────────────

function text(p: Params, key: string, max: number, required = false): string | null | undefined {
  if (!(key in p)) { if (required) throw new ParamError(`params.${key} is required`); return undefined; }
  const v = p[key];
  if (v === null) { if (required) throw new ParamError(`params.${key} is required`); return null; }
  if (typeof v !== "string") throw new ParamError(`params.${key} must be a string`);
  const t = v.trim();
  if (!t) { if (required) throw new ParamError(`params.${key} is required`); return null; }
  if (t.length > max) throw new ParamError(`params.${key} must be ≤${max} chars`);
  return t;
}

function outletName(p: Params, required: boolean): string | undefined {
  const v = text(p, "outlet", 40, required);
  if (v === undefined || v === null) return undefined;
  const o = v.toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(o)) throw new ParamError("params.outlet must be a lowercase token (a-z, 0-9, _), e.g. audiogo");
  return o;
}

function status(p: Params): string | undefined {
  if (!("status" in p)) return undefined;
  if (typeof p.status !== "string" || !(STATUSES as readonly string[]).includes(p.status)) {
    throw new ParamError(`params.status must be one of ${STATUSES.join(", ")}`);
  }
  return p.status;
}

function when(p: Params, key: string): string | null | undefined {
  if (!(key in p)) return undefined;
  if (p[key] === null || p[key] === "") return null;
  if (typeof p[key] !== "string") throw new ParamError(`params.${key} must be an ISO date/time string`);
  const t = Date.parse(p[key] as string);
  if (Number.isNaN(t)) throw new ParamError(`params.${key} is not a valid date/time`);
  return new Date(t).toISOString();
}

function money(p: Params, key: string): number | null | undefined {
  if (!(key in p)) return undefined;
  if (p[key] === null) return null;
  const n = typeof p[key] === "string" ? Number(p[key]) : p[key];
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e9) throw new ParamError(`params.${key} must be a number between 0 and 1e9`);
  return Math.round(n * 100) / 100;
}

function currency(p: Params): string | undefined {
  if (!("currency" in p)) return undefined;
  if (typeof p.currency !== "string" || !/^[A-Za-z]{3}$/.test(p.currency)) throw new ParamError("params.currency must be a 3-letter code");
  return p.currency.toUpperCase();
}

function obj(p: Params, key: string): Record<string, unknown> | undefined {
  if (!(key in p)) return undefined;
  const v = p[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParamError(`params.${key} must be an object`);
  if (JSON.stringify(v).length > 20_000) throw new ParamError(`params.${key} is too large (max 20KB)`);
  return v as Record<string, unknown>;
}

function landing(p: Params): string | null | undefined {
  const v = text(p, "landing_url", 500);
  if (v === undefined || v === null) return v;
  let u: URL;
  try { u = new URL(v); } catch { throw new ParamError("params.landing_url must be a valid URL"); }
  if (u.protocol !== "https:" || !/^[a-z0-9-]+\.sqrz\.com$/.test(u.hostname)) {
    throw new ParamError("params.landing_url must be https://<slug>.sqrz.com[/path]");
  }
  return u.toString();
}

function idParam(p: Params): string {
  const id = text(p, "id", 36, true) as string;
  if (!UUID.test(id)) throw new ParamError("params.id must be a UUID");
  return id;
}

function checkFlight(starts: string | null | undefined, ends: string | null | undefined) {
  if (starts && ends && Date.parse(ends) < Date.parse(starts)) throw new ParamError("ends_at must be >= starts_at");
}

// ── main ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const denied = requireSandboxKey(req);
  if (denied) return denied;

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

  // Optional client linkage: profile_id (public.profiles.id) and hubspot_deal_id. On create/update they are
  // stored on the campaign; on list they are filters; on every action they also tag the outlet_runs row.
  let links: ClientLinks;
  try {
    links = parseClientLinks(params);
    if (links.profileId && !(await profileExists(links.profileId))) throw new ParamError("params.profile_id does not match any profile");
  } catch (e) {
    if (e instanceof ParamError) return json({ ok: false, action, error: e.message }, 400);
    console.error("[sandbox-manual] client link check failed:", e);
    return json({ error: "sandbox database unavailable" }, 500);
  }

  let runId: string;
  try {
    runId = await startRun("manual", action, params, links);
  } catch (e) {
    console.error("[sandbox-manual] could not write outlet_runs:", e);
    return json({ error: "sandbox logging unavailable (is the outlet_sandbox migration applied?)" }, 500);
  }

  try {
    const sql = sandboxSql();
    let result: unknown;

    switch (action) {
      case "create": {
        const outlet = outletName(params, true)!;
        const name = text(params, "name", 200, true) as string;
        const st = status(params) ?? "planned";
        const startsAt = when(params, "starts_at") ?? null;
        const endsAt = when(params, "ends_at") ?? null;
        checkFlight(startsAt, endsAt);
        // booked_at defaults to now() when created already booked/running/done
        const bookedAt = when(params, "booked_at") ?? (["booked", "running", "done"].includes(st) ? new Date().toISOString() : null);
        const [row] = await sql`
          insert into outlet_sandbox.manual_campaigns
            (outlet, name, status, booked_at, starts_at, ends_at, budget, currency, spend, targeting, creative_ref, landing_url, results, notes, profile_id, hubspot_deal_id)
          values
            (${outlet}, ${name}, ${st}, ${bookedAt}, ${startsAt}, ${endsAt}, ${money(params, "budget") ?? null}, ${currency(params) ?? "USD"},
             ${money(params, "spend") ?? 0}, ${sql.json((obj(params, "targeting") ?? {}) as never)}, ${text(params, "creative_ref", 500) ?? null},
             ${landing(params) ?? null}, ${sql.json((obj(params, "results") ?? {}) as never)}, ${text(params, "notes", 5000) ?? null},
             ${links.profileId}, ${links.hubspotDealId})
          returning *`;
        result = { campaign: row };
        break;
      }

      case "update": {
        const id = idParam(params);
        const st = status(params);
        const startsAt = when(params, "starts_at");
        const endsAt = when(params, "ends_at");
        const bookedAt = when(params, "booked_at");
        const name = text(params, "name", 200);
        if (name === null) throw new ParamError("params.name cannot be empty");
        const outlet = outletName(params, false);
        const budget = money(params, "budget");
        const spend = money(params, "spend");
        if (spend === null) throw new ParamError("params.spend cannot be null");
        const cur = currency(params);
        const targeting = obj(params, "targeting");
        const creativeRef = text(params, "creative_ref", 500);
        const landingUrl = landing(params);
        const results = obj(params, "results");
        const notes = text(params, "notes", 5000);
        const notesAppend = text(params, "notes_append", 2000);
        const mode = params.results_mode === undefined ? "merge" : params.results_mode;
        if (mode !== "merge" && mode !== "replace") throw new ParamError('params.results_mode must be "merge" or "replace"');
        checkFlight(startsAt, endsAt);
        if (notes !== undefined && notesAppend) throw new ParamError("pass either params.notes (replace) or params.notes_append, not both");

        // present-but-null clears the link; absent leaves it unchanged
        const setProfile = "profile_id" in params;
        const setDeal = "hubspot_deal_id" in params;

        const touched = [st, startsAt, endsAt, bookedAt, name, outlet, budget, spend, cur, targeting, creativeRef, landingUrl, results, notes, notesAppend,
          setProfile || undefined, setDeal || undefined];
        if (touched.every((v) => v === undefined)) throw new ParamError("nothing to update: pass at least one field");

        const [row] = await sql`
          update outlet_sandbox.manual_campaigns set
            updated_at = now()
            ${name !== undefined ? sql`, name = ${name}` : sql``}
            ${outlet !== undefined ? sql`, outlet = ${outlet}` : sql``}
            ${st !== undefined ? sql`, status = ${st}` : sql``}
            ${bookedAt !== undefined ? sql`, booked_at = ${bookedAt}` : st === "booked" ? sql`, booked_at = coalesce(booked_at, now())` : sql``}
            ${startsAt !== undefined ? sql`, starts_at = ${startsAt}` : sql``}
            ${endsAt !== undefined ? sql`, ends_at = ${endsAt}` : sql``}
            ${budget !== undefined ? sql`, budget = ${budget}` : sql``}
            ${cur !== undefined ? sql`, currency = ${cur}` : sql``}
            ${spend !== undefined ? sql`, spend = ${spend}` : sql``}
            ${targeting !== undefined ? sql`, targeting = ${sql.json(targeting as never)}` : sql``}
            ${creativeRef !== undefined ? sql`, creative_ref = ${creativeRef}` : sql``}
            ${landingUrl !== undefined ? sql`, landing_url = ${landingUrl}` : sql``}
            ${results !== undefined
              ? (mode === "replace"
                ? sql`, results = ${sql.json(results as never)}`
                // shallow merge; a null value removes that key
                : sql`, results = jsonb_strip_nulls(coalesce(results, '{}'::jsonb) || ${sql.json(results as never)})`)
              : sql``}
            ${setProfile ? sql`, profile_id = ${links.profileId}` : sql``}
            ${setDeal ? sql`, hubspot_deal_id = ${links.hubspotDealId}` : sql``}
            ${notes !== undefined ? sql`, notes = ${notes}` : sql``}
            ${notesAppend ? sql`, notes = coalesce(notes || E'\n', '') || ${`[${new Date().toISOString().slice(0, 16).replace("T", " ")}Z] ${notesAppend}`}` : sql``}
          where id = ${id}
          returning *`;
        if (!row) throw new NotFound(`no manual campaign with id ${id}`);
        result = { campaign: row };
        break;
      }

      case "get": {
        const id = idParam(params);
        const [row] = await sql`select * from outlet_sandbox.manual_campaigns where id = ${id}`;
        if (!row) throw new NotFound(`no manual campaign with id ${id}`);
        result = { campaign: row };
        break;
      }

      case "list": {
        const outlet = outletName(params, false);
        const st = status(params);
        const lim = params.limit === undefined ? 50 : Number(params.limit);
        const off = params.offset === undefined ? 0 : Number(params.offset);
        if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw new ParamError("params.limit must be an integer 1–200");
        if (!Number.isInteger(off) || off < 0) throw new ParamError("params.offset must be an integer >= 0");
        const rows = await sql`
          select *, count(*) over () as total
          from outlet_sandbox.manual_campaigns
          where true
            ${outlet !== undefined ? sql`and outlet = ${outlet}` : sql``}
            ${st !== undefined ? sql`and status = ${st}` : sql``}
            ${links.profileId ? sql`and profile_id = ${links.profileId}` : sql``}
            ${links.hubspotDealId ? sql`and hubspot_deal_id = ${links.hubspotDealId}` : sql``}
          order by created_at desc
          limit ${lim} offset ${off}`;
        const total = rows.length ? Number(rows[0].total) : 0;
        result = { total, count: rows.length, campaigns: rows.map(({ total: _t, ...r }: Record<string, unknown>) => r) };
        break;
      }
    }

    // outlet_runs keeps a summary for list (the rows themselves live in manual_campaigns).
    const logged = action === "list" ? { total: (result as { total: number }).total, count: (result as { count: number }).count } : result;
    await finishRun(runId, "ok", logged);
    return json({ ok: true, run_id: runId, action, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[sandbox-manual] ${action} (${runId}) failed:`, message);
    try { await finishRun(runId, "error", null, message); } catch (logErr) { console.error("[sandbox-manual] failed to finalize run log:", logErr); }
    const status = e instanceof ParamError ? 400 : e instanceof NotFound ? 404 : 500;
    return json({ ok: false, run_id: runId, action, error: message }, status);
  }
});
