import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, fetchAsBlob, firstArray, httpJson, majorStr, num,
  oauthForm, optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated, sleep,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Amazon Ads API outlet adapter — SANDBOX ONLY. Login with Amazon (LWA) OAuth,
// region-specific endpoints (AMAZON_ADS_REGION = na (default) | eu | fe), headers
// Amazon-Advertising-API-ClientId + Amazon-Advertising-API-Scope (= profileId).
// There is NO Amazon Ads sandbox for this flow — every call is real; everything is
// created PAUSED. Apply as a Direct Advertiser — see docs/outlets/amazon.md.
//
// Product: Sponsored Brands v4 (the Amazon ad product that supports an OFF-Amazon
// landing page): campaign → ad group → brand video ad whose landing page is
// { landingPageType: OFF_AMAZON_LINK, url: https://<slug>.sqrz.com }. The video
// asset comes from upload_asset (Creative Assets). Brand registry is required:
// AMAZON_ADS_BRAND_ENTITY_ID + AMAZON_ADS_BRAND_LOGO_ASSET_ID secrets (or
// extra.brand_logo_asset_id). Keywords/targeting are not set — add them in the console.
//
// VERIFIED (third-party docs mirror, via search snippets): POST
// https://advertising-api.amazon.com/sb/v4/campaigns with content-type
// application/vnd.sbcampaignresource.v4+json, multi-status response, the two
// Amazon-Advertising-API-* headers, profileId as scope, permission
// advertiser_campaign_edit.
// UNVERIFIED: eu/fe hostnames, every SB v4 body field/enum (budget, state, ad
// creative, landing page), the other vendor content types, Creative Assets
// register/upload, async v3 Reporting (create → poll → gz JSON download), pause shape.
// `validate_only: true` sends NOTHING and returns the bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTS: Record<string, string> = {
  na: "https://advertising-api.amazon.com", eu: "https://advertising-api-eu.amazon.com", fe: "https://advertising-api-fe.amazon.com",
};
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CT = {
  campaign: "application/vnd.sbcampaignresource.v4+json", adGroup: "application/vnd.sbadgroupresource.v4+json", ad: "application/vnd.sbadresource.v4+json",
};

export type AmazonConfig = { region: string; clientId: string; clientSecret: string; refreshToken: string; profileId: string; brandEntityId: string; brandLogoAssetId: string };

export function amazonConfigFromEnv(): AmazonConfig {
  const region = optionalEnv("AMAZON_ADS_REGION", "na").toLowerCase();
  if (!HOSTS[region]) throw new ConfigError(`AMAZON_ADS_REGION must be na | eu | fe, got "${region}"`);
  const s = requireEnv(["AMAZON_ADS_CLIENT_ID", "AMAZON_ADS_CLIENT_SECRET", "AMAZON_ADS_REFRESH_TOKEN", "AMAZON_ADS_PROFILE_ID"] as const);
  return {
    region, clientId: s.AMAZON_ADS_CLIENT_ID, clientSecret: s.AMAZON_ADS_CLIENT_SECRET, refreshToken: s.AMAZON_ADS_REFRESH_TOKEN, profileId: s.AMAZON_ADS_PROFILE_ID,
    brandEntityId: optionalEnv("AMAZON_ADS_BRAND_ENTITY_ID"), brandLogoAssetId: optionalEnv("AMAZON_ADS_BRAND_LOGO_ASSET_ID"),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.code, b?.details, b?.error_description, b?.error].filter((x) => typeof x === "string").join(" — ");

export class AmazonAdsAdapter implements OutletAdapter {
  readonly name = "amazon" as const;
  constructor(private readonly cfg: AmazonConfig) {}

  private get host() { return HOSTS[this.cfg.region]; }
  private token(): Promise<string> {
    const c = this.cfg;
    return oauthForm(`amazon:${c.clientId}:${c.refreshToken}`, TOKEN_URL,
      { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret }, { fmt: fmtErr });
  }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown, ct = "application/json", accept?: string, scoped = true): Promise<any> {
    const t = await this.token();
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, "Amazon-Advertising-API-ClientId": this.cfg.clientId, "Content-Type": ct, Accept: accept ?? ct };
    if (scoped) headers["Amazon-Advertising-API-Scope"] = this.cfg.profileId;
    return httpJson(`${method} ${path}`, `${this.host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, fmtErr);
  }

  /** SB v4 multi-status: { campaigns: { success: [{ campaignId, index }], error: [...] } } (unverified). */
  // deno-lint-ignore no-explicit-any
  private ok(label: string, b: any, key: string, idKey: string): string {
    const bucket = b?.[key] ?? {};
    const id = bucket.success?.[0]?.[idKey];
    if (!id) throw new OutletError(`${label} failed: ${JSON.stringify(bucket.error ?? b).slice(0, 400)}`, b);
    return String(id);
  }

  async ping(): Promise<PingResult> {
    const p = await this.api("GET", "/v2/profiles", undefined, "application/json", undefined, false);
    const list = firstArray(p, ["profiles"]);
    const mine = list.find((x) => String(x.profileId) === this.cfg.profileId);
    return {
      ok: !!mine || list.length === 0,
      detail: `${this.cfg.region}: ${list.length} profile(s) visible; ${mine ? `profile ${this.cfg.profileId} (${mine.accountInfo?.name ?? "?"}, ${mine.countryCode ?? "?"}, ${mine.currencyCode ?? "?"})` : `profile ${this.cfg.profileId} NOT found`}`,
      raw: mine ?? { profiles: list.length },
    };
  }

  /** Creative Assets: register → PUT bytes to the returned location. UNVERIFIED flow. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 100 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    if (!/^(video|image)\//.test(ct)) throw new ParamError(`amazon upload_asset needs video/* or image/*, got ${ct}`);
    const reg = await this.api("POST", "/assets/register", { name: input.title.slice(0, 100), assetType: ct.startsWith("video/") ? "VIDEO" : "IMAGE", contentType: ct, assetSubTypeList: [] });
    const id = String(reg?.assetId ?? ""); const loc = reg?.uploadLocation as string | undefined;
    if (!id || !loc) throw new OutletError("assets/register returned no assetId/uploadLocation", reg);
    const objects: OutletObject[] = [{ objectType: "asset", externalId: id, raw: { type: ct } }];
    const put = await fetch(loc, { method: "PUT", headers: { "Content-Type": ct }, body: f.blob });
    if (!put.ok) rethrowWithCreated(new OutletError(`asset PUT → ${put.status}`), objects);
    return { externalId: id, visibility: "profile-assets", objects, raw: reg };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "amazon");
    assertSqrzLandingUrl(input.landingUrl);
    if (!input.assetId) throw new ParamError("amazon create_campaign needs asset_id (a video asset id from upload_asset)");
    const logo = extraStr(input, "brand_logo_asset_id") ?? this.cfg.brandLogoAssetId;
    if (!this.cfg.brandEntityId || !logo) throw new ParamError("amazon needs AMAZON_ADS_BRAND_ENTITY_ID and a brand logo asset (AMAZON_ADS_BRAND_LOGO_ASSET_ID or extra.brand_logo_asset_id)");
    checkTexts("headlines", input.headlines, { max: 50, maxCount: 1 });
    if (input.businessName.length > 30) throw new ParamError("business_name (brand name) must be ≤30 chars");
    checkBudget(input.dailyBudgetCents, 100);
    const name = `[SANDBOX] ${input.name}`.slice(0, 128);
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");

    const campaign = { campaigns: [{ name, state: "PAUSED", startDate: today, budget: { budget: Number(majorStr(input.dailyBudgetCents)), budgetType: "DAILY" }, brandEntityId: this.cfg.brandEntityId, bidding: { bidOptimization: true } }] };
    const adGroup = (cid: string) => ({ adGroups: [{ campaignId: cid, name: `${name} ad group`, state: "PAUSED" }] });
    const ad = (gid: string) => ({
      ads: [{
        adGroupId: gid, name: `${name} ad`, state: "PAUSED", adType: "VIDEO",
        creative: { brandName: input.businessName, brandLogoAssetID: logo, headline: input.headlines[0], videoAssetIds: [input.assetId] },
        landingPage: { landingPageType: "OFF_AMAZON_LINK", url: input.landingUrl },
      }],
    });

    if (input.validateOnly) {
      return dryRunResult([
        { POST: "/sb/v4/campaigns", contentType: CT.campaign, body: campaign }, { POST: "/sb/v4/adGroups", contentType: CT.adGroup, body: adGroup("<campaignId>") },
        { POST: "/sb/v4/ads", contentType: CT.ad, body: ad("<adGroupId>") },
      ], { region: this.cfg.region });
    }

    const objects: OutletObject[] = [];
    try {
      const c = this.ok("create campaign", await this.api("POST", "/sb/v4/campaigns", campaign, CT.campaign), "campaigns", "campaignId");
      objects.push({ objectType: "campaign", externalId: c, raw: { state: "PAUSED", landingUrl: input.landingUrl } });
      const g = this.ok("create ad group", await this.api("POST", "/sb/v4/adGroups", adGroup(c), CT.adGroup), "adGroups", "adGroupId");
      objects.push({ objectType: "ad_group", externalId: g, parentExternalId: c });
      const a = this.ok("create ad", await this.api("POST", "/sb/v4/ads", ad(g), CT.ad), "ads", "adId");
      objects.push({ objectType: "ad", externalId: a, parentExternalId: g });
      return { status: "PAUSED", campaignId: c, adGroupId: g, adId: a, budgetId: c, validateOnly: false, objects, raw: {} };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  /** Async v3 reporting: create → poll → download gz JSON. UNVERIFIED shapes. */
  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const r = await this.api("POST", "/reporting/reports", {
      name: "sqrz-sandbox-insights", startDate: from, endDate: to,
      configuration: { adProduct: "SPONSORED_BRANDS", groupBy: ["campaign"], columns: ["campaignId", "campaignName", "campaignStatus", "impressions", "clicks", "cost", "videoCompleteViews"], reportTypeId: "sbCampaigns", timeUnit: "SUMMARY", format: "GZIP_JSON" },
    }, "application/vnd.createasyncreportrequest.v3+json", "application/vnd.createasyncreportrequest.v3+json");
    const id = r?.reportId; if (!id) throw new OutletError("reporting/reports returned no reportId", r);
    let url = "";
    for (let i = 0; i < 20 && !url; i++) {
      await sleep(2000);
      const s = await this.api("GET", `/reporting/reports/${id}`, undefined, "application/json");
      if (s?.status === "FAILED") throw new OutletError(`report failed: ${s.failureReason ?? ""}`, s);
      if (s?.status === "COMPLETED") url = s.url ?? "";
    }
    const notes = ["Reporting API shapes unverified; cost assumed in profile currency units."];
    if (!url) return { rows: [], notes: [...notes, `report ${id} not ready after 40s; retry later`] };
    const res = await fetch(url);
    if (!res.ok) throw new OutletError(`report download → ${res.status}`);
    const json = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json();
    const rows: InsightRow[] = firstArray(json, ["rows"]).filter((x) => !query.campaignIds?.length || query.campaignIds.includes(String(x.campaignId)))
      .map((x) => ({ campaignId: String(x.campaignId), campaignName: x.campaignName ?? "", channelType: "AMAZON_SPONSORED_BRANDS", status: x.campaignStatus ?? "", currency: null,
        spend: num(x.cost), impressions: num(x.impressions), clicks: num(x.clicks), videoViews: x.videoCompleteViews === undefined ? null : num(x.videoCompleteViews) }));
    return { rows, notes };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("PUT", "/sb/v4/campaigns", { campaigns: [{ campaignId, state: "PAUSED" }] }, CT.campaign);
    this.ok("pause campaign", raw, "campaigns", "campaignId");
    return { campaignId, status: "PAUSED", raw };
  }
}
