import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, firstArray, httpJson, majorStr, num,
  optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// TikTok Marketing API (TikTok API for Business) outlet adapter — SANDBOX ONLY.
// Base https://business-api.tiktok.com/open_api/v1.3, header `Access-Token`
// (long-lived token from the app/advertiser authorization, no refresh flow).
// Chain: campaign → ad group → ad, all operation_status DISABLE (= paused).
//
// VARIANTS of create_campaign:
//   • standard video ad: asset_id = video_id from upload_asset.
//   • Spark Ad (promote an existing organic post): pass extra.tiktok_item_id
//     (the post id from the identity's post list) — asset_id is then not needed.
//     Needs TIKTOK_ADS_IDENTITY_ID + TIKTOK_ADS_IDENTITY_TYPE (default AUTH_CODE
//     — the creator authorized the post via an authorization code; also
//     BC_AUTH_TT / TT_USER depending on how the identity is linked).
//
// VERIFIED (via third-party/search snippets only): Spark Ads = create the ad with
// `tiktok_item_id` from the identity's post list; advertiser id from Ads
// Manager/Business Center; app approval + Business Center onboarding needed.
// UNVERIFIED (official reference not reachable): every request/response body
// (campaign/adgroup/ad create fields, objective/optimization values), upload by
// URL, the report/integrated/get params, identity_type values. TikTok wraps
// responses as { code, message, data } — code !== 0 is treated as an error.
// `validate_only: true` sends NOTHING and returns the request bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://business-api.tiktok.com/open_api/v1.3";

export type TikTokConfig = { accessToken: string; advertiserId: string; identityId: string; identityType: string; };

export function tiktokConfigFromEnv(): TikTokConfig {
  const s = requireEnv(["TIKTOK_ADS_ACCESS_TOKEN", "TIKTOK_ADS_ADVERTISER_ID"] as const);
  return {
    accessToken: s.TIKTOK_ADS_ACCESS_TOKEN, advertiserId: s.TIKTOK_ADS_ADVERTISER_ID,
    identityId: optionalEnv("TIKTOK_ADS_IDENTITY_ID"), identityType: optionalEnv("TIKTOK_ADS_IDENTITY_TYPE", "AUTH_CODE"),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.code !== undefined ? `code=${b.code}` : "", b?.request_id ? `request_id=${b.request_id}` : ""].filter(Boolean).join(" ");

export class TikTokAdsAdapter implements OutletAdapter {
  readonly name = "tiktok" as const;
  constructor(private readonly cfg: TikTokConfig) {}

  // deno-lint-ignore no-explicit-any
  private async api(method: "GET" | "POST", path: string, payload: Record<string, unknown>): Promise<any> {
    let url = `${BASE}${path}`;
    let body: string | undefined;
    if (method === "GET") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) qs.set(k, typeof v === "string" ? v : JSON.stringify(v));
      url += `?${qs}`;
    } else body = JSON.stringify(payload);
    const b = await httpJson(`${method} ${path}`, url, {
      method, headers: { "Access-Token": this.cfg.accessToken, "Content-Type": "application/json" }, body,
    }, fmtErr);
    if (b?.code !== undefined && b.code !== 0) throw new OutletError(`${method} ${path} → code ${b.code} ${b.message ?? ""} ${b.request_id ? `(request_id=${b.request_id})` : ""}`.trim(), b);
    return b?.data ?? {};
  }

  async ping(): Promise<PingResult> {
    const d = await this.api("GET", "/advertiser/info/", { advertiser_ids: [this.cfg.advertiserId], fields: ["name", "currency", "status", "timezone"] });
    const a = firstArray(d, ["list"])[0] ?? {};
    return { ok: true, detail: `${a.name ?? "?"} (advertiser ${this.cfg.advertiserId}, ${a.currency ?? "?"}, ${a.status ?? "?"})`, raw: a };
  }

  /** Video (or image) by URL — TikTok fetches it. Returns video_id / image_id. UNVERIFIED body. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const isImage = (input.contentType ?? "").startsWith("image/") || /\.(png|jpe?g)(\?|$)/i.test(input.sourceUrl);
    const d = isImage
      ? await this.api("POST", "/file/image/ad/upload/", { advertiser_id: this.cfg.advertiserId, upload_type: "UPLOAD_BY_URL", image_url: input.sourceUrl, file_name: input.title.slice(0, 100) })
      : await this.api("POST", "/file/video/ad/upload/", { advertiser_id: this.cfg.advertiserId, upload_type: "UPLOAD_BY_URL", video_url: input.sourceUrl, file_name: input.title.slice(0, 100), flaw_detect: false });
    const r = firstArray(d, ["list"])[0] ?? d;
    const id = String(isImage ? r.image_id ?? r.id ?? "" : r.video_id ?? r.id ?? "");
    if (!id) throw new OutletError("upload returned no video_id/image_id", d);
    return { externalId: id, visibility: "advertiser-library", objects: [{ objectType: isImage ? "image" : "video", externalId: id, raw: r }], raw: d };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "tiktok");
    assertSqrzLandingUrl(input.landingUrl);
    const spark = extraStr(input, "tiktok_item_id");
    if (!spark && !input.assetId) throw new ParamError("tiktok create_campaign needs asset_id (video_id) or extra.tiktok_item_id (Spark Ad)");
    if (spark && !this.cfg.identityId) throw new ParamError("Spark Ads need the TIKTOK_ADS_IDENTITY_ID secret");
    checkTexts("headlines", input.headlines, { max: 100, maxCount: 1 }); // ad_text, ≤100 (unverified)
    checkBudget(input.dailyBudgetCents, 1);
    const adv = this.cfg.advertiserId;
    const name = `[SANDBOX] ${input.name}`.slice(0, 512);
    const start = new Date(Date.now() + 3600_000).toISOString().replace("T", " ").slice(0, 19);

    const campaign = { advertiser_id: adv, campaign_name: name, objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", operation_status: "DISABLE" };
    const adgroup = (campaignId: string) => ({
      advertiser_id: adv, campaign_id: campaignId, adgroup_name: `${name} ad group`.slice(0, 512), promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_AUTOMATIC", budget_mode: "BUDGET_MODE_DAY", budget: Number(majorStr(input.dailyBudgetCents)),
      schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: start, optimization_goal: "CLICK", billing_event: "CPC",
      bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH", operation_status: "DISABLE",
    });
    const creative = spark
      ? { ad_name: `${name} spark`.slice(0, 512), ad_format: "SINGLE_VIDEO", tiktok_item_id: spark, identity_id: this.cfg.identityId, identity_type: this.cfg.identityType }
      : { ad_name: `${name} ad`.slice(0, 512), ad_format: "SINGLE_VIDEO", video_id: input.assetId, identity_type: "CUSTOMIZED_USER", display_name: input.businessName,
          ...(this.cfg.identityId ? { identity_id: this.cfg.identityId } : {}) };
    const ad = (adgroupId: string) => ({
      advertiser_id: adv, adgroup_id: adgroupId, operation_status: "DISABLE",
      creatives: [{ ...creative, ad_text: input.headlines[0], landing_page_url: input.landingUrl, call_to_action: input.callToAction ?? "LEARN_MORE" }],
    });

    if (input.validateOnly) {
      return dryRunResult([
        { POST: "/campaign/create/", body: campaign }, { POST: "/adgroup/create/", body: adgroup("<campaignId>") }, { POST: "/ad/create/", body: ad("<adgroupId>") },
      ], { variant: spark ? "spark_ad" : "standard_video" });
    }

    const objects: OutletObject[] = [];
    try {
      const c = await this.api("POST", "/campaign/create/", campaign);
      const cid = String(c.campaign_id ?? ""); if (!cid) throw new OutletError("campaign/create returned no campaign_id", c);
      objects.push({ objectType: "campaign", externalId: cid, raw: { operation_status: "DISABLE", landingUrl: input.landingUrl } });
      const g = await this.api("POST", "/adgroup/create/", adgroup(cid));
      const gid = String(g.adgroup_id ?? ""); if (!gid) throw new OutletError("adgroup/create returned no adgroup_id", g);
      objects.push({ objectType: "ad_group", externalId: gid, parentExternalId: cid });
      const a = await this.api("POST", "/ad/create/", ad(gid));
      const aid = String(a.ad_ids?.[0] ?? a.ad_id ?? ""); if (!aid) throw new OutletError("ad/create returned no ad id", a);
      objects.push({ objectType: spark ? "spark_ad" : "ad", externalId: aid, parentExternalId: gid });
      return { status: "PAUSED", campaignId: cid, adGroupId: gid, adId: aid, budgetId: gid, validateOnly: false, objects, raw: { c, g, a } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const d = await this.api("GET", "/report/integrated/get/", {
      advertiser_id: this.cfg.advertiserId, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"],
      metrics: ["campaign_name", "spend", "impressions", "clicks", "video_play_actions", "currency"], start_date: from, end_date: to, page_size: 200,
    });
    const rows: InsightRow[] = [];
    for (const r of firstArray(d, ["list"])) {
      const id = String(r.dimensions?.campaign_id ?? r.campaign_id ?? "");
      if (!id || (query.campaignIds?.length && !query.campaignIds.includes(id))) continue;
      const m = r.metrics ?? r;
      rows.push({
        campaignId: id, campaignName: m.campaign_name ?? "", channelType: "TIKTOK", status: "", currency: m.currency ?? null,
        spend: num(m.spend), impressions: num(m.impressions), clicks: num(m.clicks),
        videoViews: m.video_play_actions === undefined ? null : num(m.video_play_actions),
      });
    }
    return { rows, notes: ["Report params/response shape unverified; spend is in the advertiser's currency units."] };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("POST", "/campaign/status/update/", { advertiser_id: this.cfg.advertiserId, campaign_ids: [campaignId], operation_status: "DISABLE" });
    return { campaignId, status: "PAUSED", raw };
  }
}
