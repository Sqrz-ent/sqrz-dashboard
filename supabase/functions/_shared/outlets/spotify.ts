import {
  assertSqrzLandingUrl, cachedToken, centsToMicros, checkBudget, checkNumericIds, checkTexts, DRY_RUN_ID, fetchAsBlob,
  fileNameFor, httpJson, num, optionalEnv, rejectGeo, requireEnv, resolveDateRange,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult,
  OutletError, type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult,
  type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Spotify Ads API v3 outlet adapter — SANDBOX ONLY.
//
// SPOTIFY_ADS_ENV = "sandbox" (default) | "production":
//   sandbox    → https://api-partner.spotify.com/ads-sandbox/v3
//   production → https://api-partner.spotify.com/ads/v3
//
// Everything is created as a DRAFT (drafts/campaigns → drafts/ad_sets →
// drafts/ads under the ad account): drafts never deliver, and nothing here
// submits/publishes them. Audio/video ads: the primary asset is an audio or
// video file (upload_asset); logo_url, if given, is uploaded as a companion
// image.
//
// VERIFIED (Spotify docs / spotify/ads-agentic-tools, via search snippets):
// the two base URLs; the draft-first flow and its three collections;
// optional Idempotency-Key header on POSTs; `objective` is deprecated on
// campaign create (use delivery_goal_group / delivery_goal on ad sets);
// ad-set fields campaign_id, name, asset_format (AUDIO|VIDEO|IMAGE|CATALOG),
// delivery ON/OFF, targets (required), start_time (≥15 min in the future);
// assets are created first, then POST …/upload as multipart/form-data, then
// GET to check; budgets are in micro-units.
// UNVERIFIED (could not be checked — the OAuth token endpoint/auth style,
// the `targets` and budget object shapes, the ad body, exact asset paths and
// the upload size cap, the reporting endpoint/response, and how a published
// entity is paused). `validate_only: true` sends NOTHING and returns the
// request bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_URL = "https://accounts.spotify.com/api/token"; // unverified for the Ads API

export type SpotifyConfig = {
  env: "sandbox" | "production"; clientId: string; clientSecret: string; refreshToken: string;
  adAccountId: string; country: string;
};

export function spotifyConfigFromEnv(): SpotifyConfig {
  const env = optionalEnv("SPOTIFY_ADS_ENV", "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "production") throw new ConfigError(`SPOTIFY_ADS_ENV must be "sandbox" or "production", got "${env}"`);
  const s = requireEnv(["SPOTIFY_ADS_CLIENT_ID", "SPOTIFY_ADS_CLIENT_SECRET", "SPOTIFY_ADS_REFRESH_TOKEN", "SPOTIFY_ADS_AD_ACCOUNT_ID"] as const);
  return {
    env, clientId: s.SPOTIFY_ADS_CLIENT_ID, clientSecret: s.SPOTIFY_ADS_CLIENT_SECRET, refreshToken: s.SPOTIFY_ADS_REFRESH_TOKEN,
    adAccountId: s.SPOTIFY_ADS_AD_ACCOUNT_ID, country: optionalEnv("SPOTIFY_ADS_TARGET_COUNTRY", "US").toUpperCase(),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => {
  const e = b?.error ?? b;
  const parts = [typeof e === "string" ? e : e?.message, b?.error_description, b?.message].filter(Boolean);
  if (Array.isArray(b?.errors)) for (const x of b.errors) parts.push(x?.message ?? JSON.stringify(x).slice(0, 200));
  return [...new Set(parts)].join(" — ");
};

export class SpotifyAdsAdapter implements OutletAdapter {
  readonly name = "spotify" as const;
  constructor(private readonly cfg: SpotifyConfig) {}

  private get base() {
    return this.cfg.env === "sandbox" ? "https://api-partner.spotify.com/ads-sandbox/v3" : "https://api-partner.spotify.com/ads/v3";
  }
  private get acct() {
    return `/ad_accounts/${this.cfg.adAccountId}`;
  }

  private accessToken(): Promise<string> {
    const c = this.cfg;
    return cachedToken(`spotify:${c.clientId}:${c.refreshToken}`, async () => {
      const b = await httpJson("OAuth refresh", TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken }).toString(),
      }, fmtErr);
      if (!b.access_token) throw new OutletError("OAuth refresh returned no access_token", b);
      return { token: b.access_token, expiresInSec: Number(b.expires_in ?? 3600) };
    });
  }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown, form?: FormData, idem?: string): Promise<any> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (!form) headers["Content-Type"] = "application/json";
    if (idem) headers["Idempotency-Key"] = idem;
    return httpJson(`${method} ${path}`, `${this.base}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) }, fmtErr);
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", this.acct);
    return { ok: true, detail: `${this.cfg.env}: ad account ${this.cfg.adAccountId}${b?.name ? ` (${b.name})` : ""}`, raw: b };
  }

  /** Audio / video / image → asset id. Create asset, then multipart upload. ≤50MB (unverified cap). */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 50 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    const type = ct.startsWith("audio/") ? "AUDIO" : ct.startsWith("video/") ? "VIDEO" : ct.startsWith("image/") ? "IMAGE" : "";
    if (!type) throw new ParamError(`spotify upload_asset needs audio/*, video/* or image/*, got ${ct}`);

    const created = await this.api("POST", `${this.acct}/assets`, { name: input.title.slice(0, 100), asset_type: type }, undefined, crypto.randomUUID());
    const id = String(created?.id ?? created?.asset_id ?? "");
    if (!id) throw new OutletError("create asset returned no id", created);
    const objects: OutletObject[] = [{ objectType: "asset", externalId: id, raw: { type } }];
    try {
      const form = new FormData();
      form.set("file", f.blob, fileNameFor(input.title, ct));
      const up = await this.api("POST", `${this.acct}/assets/${id}/upload`, undefined, form);
      return { externalId: id, visibility: "ad-account-asset", objects, raw: { created, up } };
    } catch (e) {
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "spotify");
    assertSqrzLandingUrl(input.landingUrl);
    if (!input.assetId) throw new ParamError("spotify create_campaign needs asset_id (an audio/video asset id from upload_asset)");
    checkTexts("headlines", input.headlines, { max: 40, maxCount: 1 }); // tagline; length is unverified
    if (input.businessName.length > 25) throw new ParamError("business_name (advertiser_name) must be ≤25 chars");
    checkBudget(input.dailyBudgetCents, 1);
    const name = `[SANDBOX] ${input.name}`.slice(0, 100);
    const start = new Date(Date.now() + 60 * 60_000).toISOString(); // ≥15 min ahead

    // asset_format follows the primary asset type; resolved from the asset unless dry-run.
    const adSet = (campaignId: string, format: string) => ({
      campaign_id: campaignId, name: `${name} ad set`, asset_format: format, delivery: "OFF", start_time: start,
      budget: { type: "DAILY", micro_amount: centsToMicros(input.dailyBudgetCents) },
      targets: { geo_targets: { country_code: this.cfg.country } },
    });
    const ad = (adSetId: string, companionId?: string) => ({
      ad_set_id: adSetId, name: `${name} ad`, advertiser_name: input.businessName, tagline: input.headlines[0],
      landing_page_url: input.landingUrl, asset_id: input.assetId,
      ...(companionId ? { companion_asset_id: companionId } : {}),
      ...(input.callToAction ? { cta_text: input.callToAction } : {}),
    });

    if (input.validateOnly) {
      return {
        status: "PAUSED", campaignId: DRY_RUN_ID, adGroupId: DRY_RUN_ID, adId: DRY_RUN_ID, budgetId: DRY_RUN_ID,
        validateOnly: true, objects: [],
        raw: { dryRun: true, env: this.cfg.env, requests: [
          { POST: `${this.acct}/drafts/campaigns`, body: { name } },
          { POST: `${this.acct}/drafts/ad_sets`, body: adSet("<draftCampaignId>", "<AUDIO|VIDEO from asset>") },
          { POST: `${this.acct}/drafts/ads`, body: ad("<draftAdSetId>", input.logoUrl ? "<companionAssetId>" : undefined) },
        ] },
      };
    }

    const asset = await this.api("GET", `${this.acct}/assets/${input.assetId}`);
    const format = String(asset?.asset_type ?? asset?.type ?? "").toUpperCase();
    if (format !== "AUDIO" && format !== "VIDEO") throw new ParamError(`asset ${input.assetId} must be AUDIO or VIDEO (got "${format || "unknown"}")`);

    const objects: OutletObject[] = [];
    try {
      let companionId: string | undefined;
      if (input.logoUrl) {
        const up = await this.uploadAsset({ sourceUrl: input.logoUrl, title: `${name} companion` });
        companionId = up.externalId;
        objects.push(...up.objects);
      }
      const c = await this.api("POST", `${this.acct}/drafts/campaigns`, { name }, undefined, crypto.randomUUID());
      const cid = String(c?.id ?? "");
      if (!cid) throw new OutletError("create draft campaign returned no id", c);
      objects.push({ objectType: "draft_campaign", externalId: cid, raw: { landingUrl: input.landingUrl } });
      const s = await this.api("POST", `${this.acct}/drafts/ad_sets`, adSet(cid, format), undefined, crypto.randomUUID());
      const sid = String(s?.id ?? "");
      if (!sid) throw new OutletError("create draft ad set returned no id", s);
      objects.push({ objectType: "draft_ad_set", externalId: sid, parentExternalId: cid });
      const a = await this.api("POST", `${this.acct}/drafts/ads`, ad(sid, companionId), undefined, crypto.randomUUID());
      const aid = String(a?.id ?? "");
      if (!aid) throw new OutletError("create draft ad returned no id", a);
      objects.push({ objectType: "draft_ad", externalId: aid, parentExternalId: sid });
      return { status: "PAUSED", campaignId: cid, adGroupId: sid, adId: aid, budgetId: sid, validateOnly: false, objects, raw: { c, s, a } };
    } catch (e) {
      // Drafts never deliver; surface what exists so it gets logged for manual cleanup.
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  /** Reporting endpoint is UNVERIFIED (modeled on the v2 aggregate_reports API); rows are read defensively. */
  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const qs = new URLSearchParams({
      entity_type: "CAMPAIGN", fields: "IMPRESSIONS,CLICKS,SPEND",
      report_start: `${from}T00:00:00Z`, report_end: `${to}T23:59:59Z`,
    });
    const notes = ["Spotify reporting endpoint/response shape is unverified; drafts have no delivery so rows may be empty in the sandbox."];
    const b = await this.api("GET", `${this.acct}/aggregate_reports?${qs}`);
    // deno-lint-ignore no-explicit-any
    const list: any[] = [b?.rows, b?.data, b?.results, b?.report, b?.items].find(Array.isArray) ?? [];
    const rows: InsightRow[] = [];
    for (const r of list) {
      const id = String(r.entity_id ?? r.campaign_id ?? r.id ?? "");
      if (!id) continue;
      if (query.campaignIds?.length && !query.campaignIds.includes(id)) continue;
      const m = r.stats ?? r.metrics ?? r;
      const spend = m.SPEND ?? m.spend ?? m.spend_micros;
      rows.push({
        campaignId: id, campaignName: r.entity_name ?? r.name ?? "", channelType: "SPOTIFY_AUDIO_VIDEO", status: r.status ?? "",
        currency: r.currency ?? null,
        spend: m.spend_micros !== undefined ? num(m.spend_micros) / 1_000_000 : num(spend),
        impressions: num(m.IMPRESSIONS ?? m.impressions), clicks: num(m.CLICKS ?? m.clicks), videoViews: null,
      });
    }
    return { rows, notes };
  }

  /** Published entities: turn delivery OFF on the campaign's ad sets. Drafts can't deliver, so nothing to pause. */
  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const l = await this.api("GET", `${this.acct}/ad_sets?${new URLSearchParams({ campaign_id: campaignId })}`);
    // deno-lint-ignore no-explicit-any
    const sets: any[] = [l?.ad_sets, l?.data, l?.items, l?.results].find(Array.isArray) ?? [];
    if (!sets.length) {
      throw new OutletError(`no published ad sets found for campaign ${campaignId}; drafts never deliver, so there is nothing to pause`, l);
    }
    const done = [];
    for (const s of sets) done.push(await this.api("PATCH", `${this.acct}/ad_sets/${s.id}`, { delivery: "OFF" }));
    return { campaignId, status: "PAUSED", raw: done };
  }
}
