import { requireSandboxKey } from "./sandbox-guard.ts";
import { finishRun, recordObjects, startRun } from "./sandbox-db.ts";
import {
  ConfigError,
  OutletError,
  type OutletAdapter,
  type OutletName,
  type OutletObject,
  ParamError,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Generic request handler for the sandbox-<outlet> edge functions
// (microsoft / snapchat / openai / spotify). Same behavior as
// sandbox-google-ads/index.ts — guard → log run first → call adapter → log
// objects → finalize run — with the generic action set:
//   ping | upload_asset | create_campaign | insights | pause
// Everything an adapter creates is paused/draft; final URLs are always
// https://<slug>.sqrz.com.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = ["ping", "upload_asset", "create_campaign", "insights", "pause"] as const;
type Action = typeof ACTIONS[number];
type Params = Record<string, unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function str(p: Params, key: string, required = true): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ParamError(`params.${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ParamError(`params.${key} must be a string`);
  return v.trim();
}

function strList(p: Params, key: string, required = true): string[] {
  const v = p[key];
  if (v === undefined || v === null) {
    if (required) throw new ParamError(`params.${key} is required`);
    return [];
  }
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

/** Same slug validation as sandbox-google-ads: only SQRZ profiles can be advertised. */
function landingUrlFromSlug(slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new ParamError("params.slug must be a lowercase profile slug (a-z, 0-9, -)");
  }
  return `https://${slug}.sqrz.com`;
}

/** Optional params.extra — an object of outlet-specific variant inputs (see CreateCampaignInput.extra). */
function extraObject(p: Params): Record<string, unknown> | undefined {
  const v = p.extra;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ParamError("params.extra must be an object");
  return v as Record<string, unknown>;
}

export async function handleSandboxRequest(
  req: Request,
  cfg: { outlet: OutletName; makeAdapter: () => OutletAdapter },
): Promise<Response> {
  const tag = `[sandbox-${cfg.outlet}]`;
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

  // Log first: nothing may hit the outlet untracked.
  let runId: string;
  try {
    runId = await startRun(cfg.outlet, action, params);
  } catch (e) {
    console.error(`${tag} could not write outlet_runs:`, e);
    return json({ error: "sandbox logging unavailable (is the outlet_sandbox migration applied?)" }, 500);
  }

  let created: OutletObject[] = [];
  try {
    const adapter = cfg.makeAdapter();
    let result: unknown;

    switch (action) {
      case "ping":
        result = await adapter.ping();
        break;

      case "upload_asset": {
        const up = await adapter.uploadAsset({
          sourceUrl: httpsUrl(str(params, "asset_url")!, "asset_url"),
          title: str(params, "title")!,
          description: str(params, "description", false),
          tags: params.tags === undefined ? undefined : strList(params, "tags"),
          visibility: str(params, "visibility", false),
          contentType: str(params, "content_type", false),
        });
        created = up.objects;
        result = up;
        break;
      }

      case "create_campaign": {
        const geo = params.geo as { latitude?: number; longitude?: number; radius_km?: number } | undefined;
        const logo = str(params, "logo_url", false);
        const out = await adapter.createCampaign({
          name: str(params, "name")!,
          assetId: str(params, "asset_id", false) ?? "",
          landingUrl: landingUrlFromSlug(str(params, "slug")!),
          businessName: str(params, "business_name")!,
          headlines: strList(params, "headlines"),
          longHeadlines: strList(params, "long_headlines", false),
          descriptions: strList(params, "descriptions"),
          logoUrl: logo ? httpsUrl(logo, "logo_url") : "",
          callToAction: str(params, "cta", false),
          dailyBudgetCents: Number(params.daily_budget_cents),
          geo: geo
            ? { latitude: Number(geo.latitude), longitude: Number(geo.longitude), radiusKm: Number(geo.radius_km) }
            : undefined,
          validateOnly: params.validate_only === true,
          extra: extraObject(params),
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

    if (created.length) await recordObjects(cfg.outlet, runId, created);
    await finishRun(runId, "ok", result);
    return json({ ok: true, run_id: runId, action, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`${tag} ${action} (${runId}) failed:`, message);
    // Objects created before a later step failed still exist (paused/draft) — log them.
    if (e instanceof OutletError) created = [...created, ...e.created];
    try {
      if (created.length) await recordObjects(cfg.outlet, runId, created);
      await finishRun(runId, "error", e instanceof OutletError ? e.detail ?? null : null, message);
    } catch (logErr) {
      console.error(`${tag} failed to finalize run log:`, logErr);
    }
    const status = e instanceof ParamError ? 400 : e instanceof ConfigError ? 500 : e instanceof OutletError ? 502 : 500;
    return json({ ok: false, run_id: runId, action, error: message }, status);
  }
}
