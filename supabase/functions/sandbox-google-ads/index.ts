import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireSandboxKey } from "../_shared/outlets/sandbox-guard.ts";
import { finishRun, profileExists, recordObjects, startRun } from "../_shared/outlets/sandbox-db.ts";
import { parseClientLinks } from "../_shared/outlets/sandbox-common.ts";
import { primeOutletSecrets } from "../_shared/outlets/outlet-secrets.ts";
import { GoogleAdsAdapter, googleConfigFromEnv } from "../_shared/outlets/google.ts";
import { type ClientLinks, ConfigError, OutletError, type OutletObject, ParamError } from "../_shared/outlets/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// sandbox-google-ads
//
// ISOLATED SANDBOX — not called by the app, no triggers, no cron, reads/writes
// nothing in the live schema. Only touches outlet_sandbox.* (via a direct
// Postgres connection) and Google's APIs.
//
// POST { action: "ping" | "upload_video" | "create_demand_gen" | "insights" | "pause",
//        params: {...} }
// Auth: header x-sandbox-key must equal secret SANDBOX_ADMIN_KEY, else 401.
// Deploy with verify_jwt:false (custom auth, same as the meta-* functions).
//
// Every call is logged to outlet_sandbox.outlet_runs BEFORE the outlet is hit
// (if logging fails, the call is refused); created objects go to
// outlet_sandbox.outlet_objects. Everything created on Google is PAUSED.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = ["ping", "upload_video", "create_demand_gen", "insights", "pause"] as const;
type Action = typeof ACTIONS[number];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── param helpers ─────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

function str(p: Params, key: string, required = true): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ParamError(`params.${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ParamError(`params.${key} must be a string`);
  return v.trim();
}

function strList(p: Params, key: string): string[] {
  const v = p[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ParamError(`params.${key} must be an array of strings`);
  }
  return v.map((x) => x.trim());
}

function httpsUrl(value: string, key: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ParamError(`params.${key} must be a valid URL`);
  }
  if (u.protocol !== "https:") throw new ParamError(`params.${key} must be https`);
  return u.toString();
}

/** Landing URL = https://[slug].sqrz.com — slug restricted so only SQRZ profiles can be advertised. */
function landingUrlFromSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new ParamError("params.slug must be a lowercase profile slug (a-z, 0-9, -)");
  }
  return `https://${slug}.sqrz.com`;
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

  // Optional client linkage (profile_id / hubspot_deal_id), validated before anything is logged or sent.
  let links: ClientLinks;
  try {
    links = parseClientLinks(params);
    if (links.profileId && !(await profileExists(links.profileId))) throw new ParamError("params.profile_id does not match any profile");
  } catch (e) {
    if (e instanceof ParamError) return json({ ok: false, action, error: e.message }, 400);
    console.error("[sandbox-google-ads] client link check failed:", e);
    return json({ error: "sandbox database unavailable" }, 500);
  }

  // Log first: nothing may hit Google untracked.
  let runId: string;
  try {
    runId = await startRun("google", action, params, links);
  } catch (e) {
    console.error("[sandbox-google-ads] could not write outlet_runs:", e);
    return json({ error: "sandbox logging unavailable (is the outlet_sandbox migration applied?)" }, 500);
  }

  let created: OutletObject[] = [];
  try {
    await primeOutletSecrets("google"); // Vault values first, then function secrets
    const adapter = new GoogleAdsAdapter(googleConfigFromEnv());
    let result: unknown;

    switch (action) {
      case "ping":
        result = await adapter.ping();
        break;

      case "upload_video": {
        const up = await adapter.uploadAsset({
          sourceUrl: httpsUrl(str(params, "video_url")!, "video_url"),
          title: str(params, "title")!,
          description: str(params, "description", false),
          tags: params.tags === undefined ? undefined : strList(params, "tags"),
          visibility: str(params, "privacy", false),
        });
        created = up.objects;
        result = up;
        break;
      }

      case "create_demand_gen": {
        const geo = params.geo as { latitude?: number; longitude?: number; radius_km?: number } | undefined;
        const out = await adapter.createCampaign({
          name: str(params, "name")!,
          assetId: str(params, "video_id")!,
          landingUrl: landingUrlFromSlug(str(params, "slug")!),
          businessName: str(params, "business_name")!,
          headlines: strList(params, "headlines"),
          longHeadlines: strList(params, "long_headlines"),
          descriptions: strList(params, "descriptions"),
          logoUrl: httpsUrl(str(params, "logo_url")!, "logo_url"),
          callToAction: str(params, "cta", false),
          dailyBudgetCents: Number(params.daily_budget_cents),
          geo: geo
            ? {
              latitude: Number(geo.latitude),
              longitude: Number(geo.longitude),
              radiusKm: Number(geo.radius_km),
            }
            : undefined,
          validateOnly: params.validate_only === true,
        });
        created = out.objects;
        result = out;
        break;
      }

      case "insights":
        result = await adapter.getInsights({
          campaignIds: params.campaign_ids === undefined ? undefined : strList(params, "campaign_ids"),
          datePreset: str(params, "date_preset", false),
          from: str(params, "from", false),
          to: str(params, "to", false),
        });
        break;

      case "pause":
        result = await adapter.pauseCampaign(str(params, "campaign_id")!);
        break;
    }

    if (created.length) await recordObjects("google", runId, created, links);
    await finishRun(runId, "ok", result);
    return json({ ok: true, run_id: runId, action, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[sandbox-google-ads] ${action} (${runId}) failed:`, message);
    if (e instanceof OutletError) created = [...created, ...e.created];

    // Best effort: still log whatever exists on Google's side despite the failure.
    try {
      if (created.length) await recordObjects("google", runId, created, links);
      await finishRun(runId, "error", e instanceof OutletError ? e.detail ?? null : null, message);
    } catch (logErr) {
      console.error("[sandbox-google-ads] failed to finalize run log:", logErr);
    }

    const status = e instanceof ParamError ? 400 : e instanceof ConfigError ? 500 : e instanceof OutletError ? 502 : 500;
    return json({ ok: false, run_id: runId, action, error: message }, status);
  }
});
