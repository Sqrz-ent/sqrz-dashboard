import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, fetchAsBlob, firstArray, httpJson, majorStr, num,
  oauthForm, optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn Advertising (Marketing) API outlet adapter — SANDBOX ONLY.
// Versioned REST at https://api.linkedin.com/rest. Every call sends
// `LinkedIn-Version: YYYYMM` (secret LINKEDIN_ADS_API_VERSION — NOT defaulted;
// LinkedIn sunsets versions, pick a current one) and `X-Restli-Protocol-Version: 2.0.0`.
// Chain: campaign group (DRAFT) → campaign (DRAFT, SPONSORED_UPDATES / WEBSITE_VISIT)
// → dark post (article post, feedDistribution NONE — never in any feed) →
// creative (intendedStatus DRAFT). LinkedIn's own "DRAFT" statuses are the paused state.
//
// VERIFIED (Microsoft Learn LinkedIn docs, via search snippets): the /rest base;
// POST /adAccounts/{id}/adCampaignGroups; POST /adCampaigns; status DRAFT→ACTIVE
// activation by PATCH; creatives live under /adAccounts/{id}/creatives and
// reference a campaign + content URN; LinkedIn-Version + X-Restli-Protocol-Version headers.
// UNVERIFIED: request bodies (campaign fields, targetingCriteria, the location URN),
// the Posts API dark-post body, the Images initializeUpload flow, adAnalytics
// query/response, PARTIAL_UPDATE pause. `validate_only: true` sends NOTHING.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://api.linkedin.com/rest";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

export type LinkedInConfig = {
  clientId: string; clientSecret: string; refreshToken: string; adAccountId: string; organizationId: string;
  version: string; currency: string; defaultCpc: string; locationUrn: string;
};

export function linkedinConfigFromEnv(): LinkedInConfig {
  const s = requireEnv(["LINKEDIN_ADS_CLIENT_ID", "LINKEDIN_ADS_CLIENT_SECRET", "LINKEDIN_ADS_REFRESH_TOKEN", "LINKEDIN_ADS_AD_ACCOUNT_ID", "LINKEDIN_ADS_ORGANIZATION_ID", "LINKEDIN_ADS_API_VERSION"] as const);
  if (!/^\d{6}$/.test(s.LINKEDIN_ADS_API_VERSION)) throw new ConfigError(`LINKEDIN_ADS_API_VERSION must be YYYYMM, got "${s.LINKEDIN_ADS_API_VERSION}"`);
  return {
    clientId: s.LINKEDIN_ADS_CLIENT_ID, clientSecret: s.LINKEDIN_ADS_CLIENT_SECRET, refreshToken: s.LINKEDIN_ADS_REFRESH_TOKEN,
    adAccountId: s.LINKEDIN_ADS_AD_ACCOUNT_ID, organizationId: s.LINKEDIN_ADS_ORGANIZATION_ID, version: s.LINKEDIN_ADS_API_VERSION,
    currency: optionalEnv("LINKEDIN_ADS_CURRENCY", "USD"), defaultCpc: optionalEnv("LINKEDIN_ADS_DEFAULT_CPC", "5.00"),
    locationUrn: optionalEnv("LINKEDIN_ADS_LOCATION_URN", "urn:li:geo:103644278"), // United States (unverified id)
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.code ? `code=${b.code}` : "", b?.status ? `status=${b.status}` : "", b?.error_description].filter(Boolean).join(" ");
const urnId = (u: string) => u.split(":").pop() ?? u;

export class LinkedInAdsAdapter implements OutletAdapter {
  readonly name = "linkedin" as const;
  constructor(private readonly cfg: LinkedInConfig) {}

  private token(): Promise<string> {
    const c = this.cfg;
    return oauthForm(`linkedin:${c.clientId}:${c.refreshToken}`, TOKEN_URL,
      { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret }, { fmt: fmtErr });
  }
  private get acctUrn() { return `urn:li:sponsoredAccount:${this.cfg.adAccountId}`; }
  private get orgUrn() { return `urn:li:organization:${this.cfg.organizationId}`; }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, raw?: BodyInit): Promise<{ body: any; headers: Headers }> {
    const t = await this.token();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${t}`, "LinkedIn-Version": this.cfg.version, "X-Restli-Protocol-Version": "2.0.0", ...extraHeaders,
    };
    if (raw === undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    // deno-lint-ignore no-explicit-any
    let parsed: any = {}; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 300) }; }
    if (!res.ok) throw new OutletError(`${method} ${path} → ${res.status} ${fmtErr(parsed) || text.slice(0, 200)}`.trim(), parsed);
    return { body: parsed, headers: res.headers };
  }

  async ping(): Promise<PingResult> {
    const { body } = await this.api("GET", `/adAccounts/${this.cfg.adAccountId}`);
    return { ok: true, detail: `${body?.name ?? "?"} (ad account ${this.cfg.adAccountId}, ${body?.currency ?? "?"}, ${body?.status ?? "?"}), LinkedIn-Version ${this.cfg.version}`, raw: body };
  }

  /** Image via the Images API (initializeUpload → PUT bytes) owned by the organization. UNVERIFIED flow. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 8 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    if (!/^image\/(png|jpe?g)$/.test(ct)) throw new ParamError("linkedin upload_asset supports png/jpeg images only");
    const { body } = await this.api("POST", "/images?action=initializeUpload", { initializeUploadRequest: { owner: this.orgUrn } });
    const v = body?.value ?? {};
    if (!v.uploadUrl || !v.image) throw new OutletError("initializeUpload returned no uploadUrl/image", body);
    const t = await this.token();
    const put = await fetch(v.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": ct }, body: f.blob });
    if (!put.ok) throw new OutletError(`image PUT → ${put.status}`);
    return { externalId: v.image, visibility: "organization-owned", objects: [{ objectType: "image", externalId: v.image, raw: v }], raw: v };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "linkedin");
    assertSqrzLandingUrl(input.landingUrl);
    checkTexts("headlines", input.headlines, { max: 70, maxCount: 1 });   // article title
    checkTexts("descriptions", input.descriptions, { max: 255, maxCount: 1 }); // intro text / commentary
    checkBudget(input.dailyBudgetCents, 1000); // LinkedIn daily budget minimum ≈ $10 (unverified)
    const cfg = this.cfg;
    const name = `[SANDBOX] ${input.name}`.slice(0, 100);
    const start = Date.now() + 24 * 3600_000;
    const money = (cents: number) => ({ amount: majorStr(cents), currencyCode: cfg.currency });

    const group = { account: this.acctUrn, name: `${name} group`, status: "DRAFT", runSchedule: { start } };
    const campaign = (groupId: string) => ({
      account: this.acctUrn, campaignGroup: `urn:li:sponsoredCampaignGroup:${groupId}`, name, status: "DRAFT", type: "SPONSORED_UPDATES",
      costType: "CPC", objectiveType: "WEBSITE_VISIT", format: "STANDARD_UPDATE", dailyBudget: money(input.dailyBudgetCents),
      unitCost: { amount: cfg.defaultCpc, currencyCode: cfg.currency }, locale: { country: "US", language: "en" },
      targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": [cfg.locationUrn] } }] } },
      runSchedule: { start }, offsiteDeliveryEnabled: false,
    });
    const post = {
      author: this.orgUrn, commentary: input.descriptions[0], visibility: "PUBLIC", lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
      distribution: { feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] }, // dark post
      content: { article: { source: input.landingUrl, title: input.headlines[0], ...(input.assetId ? { thumbnail: input.assetId } : {}) } },
    };
    const creative = (campaignId: string, postUrn: string) => ({
      campaign: `urn:li:sponsoredCampaign:${campaignId}`, intendedStatus: "DRAFT", content: { reference: postUrn },
    });

    if (input.validateOnly) {
      return dryRunResult([
        { POST: `/adAccounts/${cfg.adAccountId}/adCampaignGroups`, body: group }, { POST: `/adAccounts/${cfg.adAccountId}/adCampaigns`, body: campaign("<groupId>") },
        { POST: "/posts", body: post }, { POST: `/adAccounts/${cfg.adAccountId}/creatives`, body: creative("<campaignId>", "<postUrn>") },
      ], { note: "status DRAFT everywhere; the post is a dark post (feedDistribution NONE)" });
    }

    const objects: OutletObject[] = [];
    const idFrom = (h: Headers) => h.get("x-restli-id") ?? h.get("x-linkedin-id") ?? "";
    try {
      const g = await this.api("POST", `/adAccounts/${cfg.adAccountId}/adCampaignGroups`, group);
      const gid = idFrom(g.headers); if (!gid) throw new OutletError("campaign group created but no id header returned", g.body);
      objects.push({ objectType: "campaign_group", externalId: gid, raw: { status: "DRAFT" } });
      const c = await this.api("POST", `/adAccounts/${cfg.adAccountId}/adCampaigns`, campaign(gid));
      const cid = idFrom(c.headers); if (!cid) throw new OutletError("campaign created but no id header returned", c.body);
      objects.push({ objectType: "campaign", externalId: cid, parentExternalId: gid, raw: { status: "DRAFT", landingUrl: input.landingUrl } });
      const p = await this.api("POST", "/posts", post);
      const pid = idFrom(p.headers); if (!pid) throw new OutletError("post created but no id header returned", p.body);
      objects.push({ objectType: "dark_post", externalId: pid, parentExternalId: cid });
      const cr = await this.api("POST", `/adAccounts/${cfg.adAccountId}/creatives`, creative(cid, pid));
      const crid = idFrom(cr.headers); if (!crid) throw new OutletError("creative created but no id header returned", cr.body);
      objects.push({ objectType: "creative", externalId: crid, parentExternalId: cid });
      return { status: "PAUSED", campaignId: cid, adGroupId: gid, adId: crid, budgetId: cid, validateOnly: false, objects, raw: {} };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const d = (s: string) => { const [y, m, dd] = s.split("-").map(Number); return `(year:${y},month:${m},day:${dd})`; };
    const target = query.campaignIds?.length
      ? `campaigns=List(${query.campaignIds.map((i) => encodeURIComponent(`urn:li:sponsoredCampaign:${i}`)).join(",")})`
      : `accounts=List(${encodeURIComponent(this.acctUrn)})`;
    const { body } = await this.api("GET",
      `/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=ALL&dateRange=(start:${d(from)},end:${d(to)})&${target}&fields=pivotValues,impressions,clicks,costInLocalCurrency,videoViews`);
    const rows: InsightRow[] = firstArray(body, ["elements"]).map((e) => ({
      campaignId: urnId(String(e.pivotValues?.[0] ?? "")), campaignName: "", channelType: "LINKEDIN", status: "", currency: this.cfg.currency,
      spend: num(e.costInLocalCurrency), impressions: num(e.impressions), clicks: num(e.clicks), videoViews: e.videoViews === undefined ? null : num(e.videoViews),
    }));
    return { rows, notes: ["campaignName is empty (a separate campaign lookup is not performed); adAnalytics query/response unverified."] };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const { body } = await this.api("POST", `/adAccounts/${this.cfg.adAccountId}/adCampaigns/${campaignId}`, { patch: { $set: { status: "PAUSED" } } }, { "X-RestLi-Method": "PARTIAL_UPDATE" });
    return { campaignId, status: "PAUSED", raw: body };
  }
}
