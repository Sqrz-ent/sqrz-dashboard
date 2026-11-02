import {
  assertSqrzLandingUrl, cachedToken, centsToMicros, checkBudget, checkNumericIds, checkTexts, DRY_RUN_ID,
  fetchAsBlob, fileNameFor, httpJson, num, optionalEnv, rejectGeo, requireEnv, resolveDateRange,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult,
  OutletError, type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult,
  type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Snapchat Marketing API outlet adapter — SANDBOX ONLY.
//
// Hierarchy: Ad Account → Campaign → Ad Squad → Creative → Ad. Media is a
// placeholder created first, then the file is uploaded to it. Everything is
// created with status PAUSED. Snapchat has no separate sandbox environment
// that we know of — use a dedicated, unfunded ad account.
//
// Creative: a WEB_VIEW creative (full-screen web page) opening
// https://<slug>.sqrz.com, with the video/image media as the top snap.
//
// VERIFIED (Snap docs, via search snippets): base https://adsapi.snapchat.com/v1;
// hierarchy; OAuth refresh = POST accounts.snapchat.com/login/oauth2/access_token
// (grant_type=refresh_token, scope snapchat-marketing-api, refresh token not
// rotated); ad squads POST /campaigns/{id}/adsquads with { adsquads: [...] }
// including type SNAP_ADS, billing_event, bid_strategy, bid_micro,
// daily_budget_micro (minimum 5,000,000 = 5 units), delivery_constraint,
// targeting.geos, start_time, optimization_goal incl. SWIPES.
// UNVERIFIED (could not be checked): campaign body (objective), the creative
// and ad bodies (WEB_VIEW, REMOTE_WEBPAGE, field names/length limits), media
// create/upload paths and the 32MB simple-upload cap, the stats response
// shape, and the pause-by-PUT behavior (Snap updates need the full object).
// `validate_only: true` sends NOTHING and returns the request bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://adsapi.snapchat.com/v1";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const MAX_UPLOAD = 32 * 1024 * 1024;

export type SnapchatConfig = {
  clientId: string; clientSecret: string; refreshToken: string; adAccountId: string;
  profileId: string; objective: string; targetCountry: string;
};

export function snapchatConfigFromEnv(): SnapchatConfig {
  const s = requireEnv(["SNAPCHAT_ADS_CLIENT_ID", "SNAPCHAT_ADS_CLIENT_SECRET", "SNAPCHAT_ADS_REFRESH_TOKEN", "SNAPCHAT_ADS_AD_ACCOUNT_ID"] as const);
  return {
    clientId: s.SNAPCHAT_ADS_CLIENT_ID, clientSecret: s.SNAPCHAT_ADS_CLIENT_SECRET,
    refreshToken: s.SNAPCHAT_ADS_REFRESH_TOKEN, adAccountId: s.SNAPCHAT_ADS_AD_ACCOUNT_ID,
    profileId: optionalEnv("SNAPCHAT_ADS_PROFILE_ID"),               // public profile, if the creative needs one
    objective: optionalEnv("SNAPCHAT_ADS_OBJECTIVE", "WEB_CONVERSION"), // UNVERIFIED default — override via secret
    targetCountry: optionalEnv("SNAPCHAT_ADS_TARGET_COUNTRY", "us").toLowerCase(),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.debug_message, b?.display_message, b?.error_description, b?.error].filter(Boolean).join(" — ");

/** Snap bulk-style responses: { <plural>: [{ sub_request_status, <singular>: {...} }] }. */
// deno-lint-ignore no-explicit-any
function first(label: string, body: any, plural: string, singular: string): any {
  const el = body?.[plural]?.[0];
  if (!el || el.sub_request_status !== "SUCCESS" || !el[singular]) {
    throw new OutletError(`${label} failed: ${el?.sub_request_error_reason ?? body?.request_status ?? "no result"}`, body);
  }
  return el[singular];
}

export class SnapchatAdsAdapter implements OutletAdapter {
  readonly name = "snapchat" as const;
  constructor(private readonly cfg: SnapchatConfig) {}

  private accessToken(): Promise<string> {
    const c = this.cfg;
    return cachedToken(`snap:${c.clientId}:${c.refreshToken}`, async () => {
      const b = await httpJson("OAuth refresh", TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }).toString(),
      }, fmtErr);
      if (!b.access_token) throw new OutletError("OAuth refresh returned no access_token", b);
      return { token: b.access_token, expiresInSec: Number(b.expires_in ?? 3600) };
    });
  }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown, form?: FormData): Promise<any> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (!form) headers["Content-Type"] = "application/json";
    return httpJson(`${method} ${path}`, `${BASE}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) }, fmtErr);
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", `/adaccounts/${this.cfg.adAccountId}`);
    const a = b?.adaccounts?.[0]?.adaccount ?? {};
    return { ok: true, detail: `${a.name ?? "?"} (ad account ${this.cfg.adAccountId}, ${a.currency ?? "?"}, status ${a.status ?? "?"})`, raw: a };
  }

  /** Creates a media placeholder, then uploads the file to it. Video/image, ≤32MB (UNVERIFIED cap). */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, MAX_UPLOAD);
    const ct = input.contentType ?? f.contentType;
    const type = ct.startsWith("video/") ? "VIDEO" : ct.startsWith("image/") ? "IMAGE" : "";
    if (!type) throw new ParamError(`snapchat upload_asset needs a video/* or image/* source, got ${ct}`);

    const created = await this.api("POST", `/adaccounts/${this.cfg.adAccountId}/media`, {
      media: [{ name: input.title.slice(0, 100), type, ad_account_id: this.cfg.adAccountId }],
    });
    const media = first("create media", created, "media", "media");
    const form = new FormData();
    form.set("file", f.blob, fileNameFor(input.title, ct));
    const objects: OutletObject[] = [{ objectType: "media", externalId: media.id, raw: { type } }];
    try {
      const up = await this.api("POST", `/media/${media.id}/upload`, undefined, form);
      return { externalId: media.id, visibility: "ad-account-media", objects, raw: { created, up } };
    } catch (e) {
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "snapchat");
    assertSqrzLandingUrl(input.landingUrl);
    if (!input.assetId) throw new ParamError("snapchat create_campaign needs asset_id (a media id from upload_asset)");
    checkTexts("headlines", input.headlines, { max: 34, maxCount: 1 });   // creative headline: 1, ≤34 (unverified)
    if (input.businessName.length > 25) throw new ParamError("business_name must be ≤25 chars for Snapchat brand_name");
    checkBudget(input.dailyBudgetCents, 500); // Snap minimum 5,000,000 micro = 500 cents
    const acct = this.cfg.adAccountId;
    const name = `[SANDBOX] ${input.name}`.slice(0, 100);
    const start = new Date(Date.now() + 24 * 3600_000).toISOString();

    const campaign = { campaigns: [{ name, ad_account_id: acct, status: "PAUSED", start_time: start, objective: this.cfg.objective }] };
    const squad = (campaignId: string) => ({
      adsquads: [{
        name: `${name} squad`, campaign_id: campaignId, status: "PAUSED", type: "SNAP_ADS",
        billing_event: "IMPRESSION", optimization_goal: "SWIPES", bid_strategy: "AUTO_BID",
        daily_budget_micro: centsToMicros(input.dailyBudgetCents), delivery_constraint: "DAILY_BUDGET",
        targeting: { geos: [{ country_code: this.cfg.targetCountry }] }, start_time: start,
      }],
    });
    const creative = (mediaId: string) => ({
      creatives: [{
        ad_account_id: acct, name: `${name} creative`, type: "WEB_VIEW", top_snap_media_id: mediaId,
        brand_name: input.businessName, headline: input.headlines[0], shareable: true,
        web_view_properties: { url: input.landingUrl },
        ...(this.cfg.profileId ? { profile_properties: { profile_id: this.cfg.profileId } } : {}),
        ...(input.callToAction ? { call_to_action: input.callToAction } : {}),
      }],
    });
    const ad = (squadId: string, creativeId: string) => ({
      ads: [{ name: `${name} ad`, ad_squad_id: squadId, creative_id: creativeId, type: "REMOTE_WEBPAGE", status: "PAUSED" }],
    });

    if (input.validateOnly) {
      return {
        status: "PAUSED", campaignId: DRY_RUN_ID, adGroupId: DRY_RUN_ID, adId: DRY_RUN_ID, budgetId: DRY_RUN_ID,
        validateOnly: true, objects: [],
        raw: { dryRun: true, requests: [
          { POST: `/adaccounts/${acct}/campaigns`, body: campaign }, { POST: "/campaigns/<campaignId>/adsquads", body: squad("<campaignId>") },
          { POST: `/adaccounts/${acct}/creatives`, body: creative(input.assetId) }, { POST: "/adsquads/<squadId>/ads", body: ad("<squadId>", "<creativeId>") },
        ] },
      };
    }

    const m = await this.api("GET", `/media/${input.assetId}`);
    const media = m?.media?.[0]?.media;
    if (media?.media_status && media.media_status !== "READY") {
      throw new OutletError(`media ${input.assetId} is ${media.media_status}, not READY yet — retry shortly`, m);
    }

    const objects: OutletObject[] = [];
    try {
      const c = first("create campaign", await this.api("POST", `/adaccounts/${acct}/campaigns`, campaign), "campaigns", "campaign");
      objects.push({ objectType: "campaign", externalId: c.id, raw: { status: "PAUSED", landingUrl: input.landingUrl } });
      const s = first("create ad squad", await this.api("POST", `/campaigns/${c.id}/adsquads`, squad(c.id)), "adsquads", "adsquad");
      objects.push({ objectType: "ad_squad", externalId: s.id, parentExternalId: c.id });
      const cr = first("create creative", await this.api("POST", `/adaccounts/${acct}/creatives`, creative(input.assetId)), "creatives", "creative");
      objects.push({ objectType: "creative", externalId: cr.id, parentExternalId: acct });
      const a = first("create ad", await this.api("POST", `/adsquads/${s.id}/ads`, ad(s.id, cr.id)), "ads", "ad");
      objects.push({ objectType: "ad", externalId: a.id, parentExternalId: s.id });
      return { status: "PAUSED", campaignId: c.id, adGroupId: s.id, adId: a.id, budgetId: s.id, validateOnly: false, objects, raw: { c, s, cr, a } };
    } catch (e) {
      // Objects created so far stay (all PAUSED); surface them so they get logged for manual cleanup.
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const notes = ["Snapchat spend is returned in micro-currency and converted to major units."];
    const { from, to } = resolveDateRange(query);
    const list = await this.api("GET", `/adaccounts/${this.cfg.adAccountId}/campaigns?limit=50`);
    // deno-lint-ignore no-explicit-any
    let camps: any[] = (list.campaigns ?? []).map((x: any) => x.campaign).filter(Boolean);
    if (query.campaignIds?.length) camps = camps.filter((c) => query.campaignIds!.includes(c.id));
    const cur = (await this.api("GET", `/adaccounts/${this.cfg.adAccountId}`))?.adaccounts?.[0]?.adaccount?.currency ?? null;
    const rows: InsightRow[] = [];
    for (const c of camps) {
      const qs = new URLSearchParams({
        granularity: "TOTAL", fields: "impressions,swipes,spend,video_views",
        start_time: `${from}T00:00:00.000-00:00`, end_time: `${to}T23:59:59.000-00:00`,
      });
      let stats: Record<string, unknown> = {};
      try {
        const s = await this.api("GET", `/campaigns/${c.id}/stats?${qs}`);
        stats = s?.total_stats?.[0]?.total_stat?.stats ?? {};
      } catch (e) {
        notes.push(`stats for ${c.id} failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      }
      rows.push({
        campaignId: c.id, campaignName: c.name ?? "", channelType: "SNAP_ADS", status: c.status ?? "", currency: cur,
        spend: num(stats.spend) / 1_000_000, impressions: num(stats.impressions), clicks: num(stats.swipes),
        videoViews: stats.video_views === undefined ? null : num(stats.video_views),
      });
    }
    notes.push("clicks = swipes (Snapchat's click equivalent). Stats time windows may need to align to the account timezone (unverified).");
    return { rows, notes };
  }

  /** Snap updates take the full object, so read-modify-write. UNVERIFIED which read-only fields must be stripped. */
  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const cur = await this.api("GET", `/campaigns/${campaignId}`);
    const camp = first("read campaign", cur, "campaigns", "campaign");
    for (const k of ["created_at", "updated_at", "delivery_status", "creation_state", "effective_status"]) delete camp[k];
    const raw = await this.api("PUT", `/adaccounts/${this.cfg.adAccountId}/campaigns`, { campaigns: [{ ...camp, status: "PAUSED" }] });
    first("pause campaign", raw, "campaigns", "campaign");
    return { campaignId, status: "PAUSED", raw };
  }
}
