import {
  assertSqrzLandingUrl, centsToMicros, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, firstArray, httpJson, num, oauthForm,
  optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pinterest API v5 (ads) outlet adapter — SANDBOX ONLY.
// PINTEREST_ADS_ENV = "sandbox" (default) → https://api-sandbox.pinterest.com/v5 ;
// "production" → https://api.pinterest.com/v5.
// Auth: PINTEREST_ADS_ACCESS_TOKEN (e.g. the sandbox token from the developer
// portal) OR the refresh-token flow (APP_ID/APP_SECRET/REFRESH_TOKEN, Basic auth).
// Chain: campaign → ad group → ad (PAUSED). An ad references a Pin: pass
// asset_id = an existing pin_id, or extra.image_url (+ PINTEREST_ADS_BOARD_ID) to
// create the Pin first, linking to https://<slug>.sqrz.com. In production a
// created Pin is a real organic Pin on that board — use a throwaway board.
//
// VERIFIED (Pinterest sandbox docs, via search snippets): sandbox host
// api-sandbox.pinterest.com; sandbox supports ad account/campaign/ad group/ad
// create/list/update and campaign/ad group/ad analytics; Trial or Standard access.
// UNVERIFIED: request bodies and enum values (objective_type, billable_event,
// placement_group, targeting_spec), the bulk-array body/response envelope
// ({items:[{data,exceptions}]}), analytics columns/response, Pin creation body.
// `validate_only: true` sends NOTHING and returns the bodies built.
// ─────────────────────────────────────────────────────────────────────────────

export type PinterestConfig = {
  env: "sandbox" | "production"; accessToken: string; appId: string; appSecret: string; refreshToken: string;
  adAccountId: string; boardId: string; country: string;
};

export function pinterestConfigFromEnv(): PinterestConfig {
  const env = optionalEnv("PINTEREST_ADS_ENV", "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "production") throw new ConfigError(`PINTEREST_ADS_ENV must be "sandbox" or "production", got "${env}"`);
  const s = requireEnv(["PINTEREST_ADS_AD_ACCOUNT_ID"] as const);
  const accessToken = optionalEnv("PINTEREST_ADS_ACCESS_TOKEN");
  const refresh = { appId: optionalEnv("PINTEREST_ADS_APP_ID"), appSecret: optionalEnv("PINTEREST_ADS_APP_SECRET"), refreshToken: optionalEnv("PINTEREST_ADS_REFRESH_TOKEN") };
  if (!accessToken && !(refresh.appId && refresh.appSecret && refresh.refreshToken)) {
    throw new ConfigError("missing secrets: set PINTEREST_ADS_ACCESS_TOKEN, or PINTEREST_ADS_APP_ID + PINTEREST_ADS_APP_SECRET + PINTEREST_ADS_REFRESH_TOKEN");
  }
  return { env, accessToken, ...refresh, adAccountId: s.PINTEREST_ADS_AD_ACCOUNT_ID, boardId: optionalEnv("PINTEREST_ADS_BOARD_ID"), country: optionalEnv("PINTEREST_ADS_TARGET_COUNTRY", "US").toUpperCase() };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.code !== undefined ? `code=${b.code}` : "", b?.error_description].filter(Boolean).join(" ");

export class PinterestAdsAdapter implements OutletAdapter {
  readonly name = "pinterest" as const;
  constructor(private readonly cfg: PinterestConfig) {}

  private get base() { return this.cfg.env === "sandbox" ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5"; }
  private get acct() { return `/ad_accounts/${this.cfg.adAccountId}`; }

  private token(): Promise<string> {
    const c = this.cfg;
    if (c.accessToken) return Promise.resolve(c.accessToken);
    return oauthForm(`pinterest:${c.appId}:${c.refreshToken}`, `${this.base}/oauth/token`, { grant_type: "refresh_token", refresh_token: c.refreshToken },
      { basic: { id: c.appId, secret: c.appSecret }, fmt: fmtErr });
  }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const t = await this.token();
    return httpJson(`${method} ${path}`, `${this.base}${path}`, {
      method, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }, fmtErr);
  }

  /** Bulk create envelope: { items: [{ data: {...}, exceptions: [...] }] } (unverified). */
  // deno-lint-ignore no-explicit-any
  private firstItem(label: string, b: any): any {
    const it = b?.items?.[0];
    if (!it || it.exceptions?.length || !it.data?.id) {
      throw new OutletError(`${label} failed: ${(it?.exceptions ?? []).map((x: { message?: string }) => x.message).join("; ") || "no item returned"}`, b);
    }
    return it.data;
  }

  async ping(): Promise<PingResult> {
    const a = await this.api("GET", this.acct);
    return { ok: true, detail: `${this.cfg.env}: ${a?.name ?? "?"} (ad account ${this.cfg.adAccountId}, ${a?.currency ?? "?"})`, raw: a };
  }

  /** Ads reference Pins, not uploaded files — see class comment. */
  uploadAsset(_input: UploadAssetInput): Promise<UploadedAsset> {
    throw new ParamError("pinterest has no standalone ad-asset upload: pass an existing pin_id as asset_id, or extra.image_url (+ PINTEREST_ADS_BOARD_ID) to create_campaign");
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "pinterest");
    assertSqrzLandingUrl(input.landingUrl);
    checkTexts("headlines", input.headlines, { max: 100, maxCount: 1 });
    checkBudget(input.dailyBudgetCents, 1);
    const imageUrl = extraStr(input, "image_url");
    if (!input.assetId && !imageUrl) throw new ParamError("pinterest create_campaign needs asset_id (pin_id) or extra.image_url");
    if (imageUrl && !this.cfg.boardId) throw new ParamError("extra.image_url creates a Pin and needs the PINTEREST_ADS_BOARD_ID secret");
    const name = `[SANDBOX] ${input.name}`.slice(0, 128);
    const micros = centsToMicros(input.dailyBudgetCents);
    const acctId = this.cfg.adAccountId;

    const pin = {
      board_id: this.cfg.boardId, title: input.headlines[0].slice(0, 100), description: (input.descriptions[0] ?? "").slice(0, 500),
      link: input.landingUrl, media_source: { source_type: "image_url", url: imageUrl },
    };
    const campaign = [{ ad_account_id: acctId, name, status: "PAUSED", objective_type: "CONSIDERATION", daily_spend_cap: micros }];
    const adGroup = (cid: string) => [{
      ad_account_id: acctId, campaign_id: cid, name: `${name} ad group`, status: "PAUSED", billable_event: "CLICKTHROUGH",
      budget_in_micro_currency: micros, bid_in_micro_currency: 500_000, placement_group: "ALL", targeting_spec: { GEO: [this.cfg.country] },
    }];
    const ad = (gid: string, pinId: string) => [{ ad_group_id: gid, creative_type: "REGULAR", pin_id: pinId, name: `${name} ad`, status: "PAUSED", destination_url: input.landingUrl }];

    if (input.validateOnly) {
      return dryRunResult([
        ...(imageUrl ? [{ POST: "/pins", body: pin }] : []),
        { POST: `${this.acct}/campaigns`, body: campaign }, { POST: `${this.acct}/ad_groups`, body: adGroup("<campaignId>") },
        { POST: `${this.acct}/ads`, body: ad("<adGroupId>", input.assetId || "<pinId>") },
      ], { env: this.cfg.env });
    }

    const objects: OutletObject[] = [];
    try {
      let pinId = input.assetId;
      if (imageUrl) {
        const p = await this.api("POST", "/pins", pin);
        pinId = String(p?.id ?? ""); if (!pinId) throw new OutletError("create pin returned no id", p);
        objects.push({ objectType: "pin", externalId: pinId, raw: { link: input.landingUrl } });
      }
      const c = this.firstItem("create campaign", await this.api("POST", `${this.acct}/campaigns`, campaign));
      objects.push({ objectType: "campaign", externalId: String(c.id), raw: { status: "PAUSED", landingUrl: input.landingUrl } });
      const g = this.firstItem("create ad group", await this.api("POST", `${this.acct}/ad_groups`, adGroup(c.id)));
      objects.push({ objectType: "ad_group", externalId: String(g.id), parentExternalId: String(c.id) });
      const a = this.firstItem("create ad", await this.api("POST", `${this.acct}/ads`, ad(g.id, pinId)));
      objects.push({ objectType: "ad", externalId: String(a.id), parentExternalId: String(g.id) });
      return { status: "PAUSED", campaignId: String(c.id), adGroupId: String(g.id), adId: String(a.id), budgetId: String(g.id), validateOnly: false, objects, raw: { c, g, a } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const list = await this.api("GET", `${this.acct}/campaigns?page_size=100`);
    // deno-lint-ignore no-explicit-any
    let camps: any[] = firstArray(list, ["items"]);
    if (query.campaignIds?.length) camps = camps.filter((c) => query.campaignIds!.includes(String(c.id)));
    const rows: InsightRow[] = [];
    const notes = ["Analytics response shape is unverified; metrics are read defensively (spend in micro-dollars)."];
    if (camps.length) {
      const qs = new URLSearchParams({
        start_date: from, end_date: to, campaign_ids: camps.map((c) => c.id).join(","), granularity: "TOTAL",
        columns: "SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1",
      });
      const an = await this.api("GET", `${this.acct}/campaigns/analytics?${qs}`);
      for (const r of firstArray(an, ["items"])) {
        const m = r.metrics ?? r; const id = String(r.campaign_id ?? m.CAMPAIGN_ID ?? ""); const c = camps.find((x) => String(x.id) === id);
        if (!id) continue;
        rows.push({ campaignId: id, campaignName: c?.name ?? "", channelType: "PINTEREST", status: c?.status ?? "", currency: "USD",
          spend: num(m.SPEND_IN_MICRO_DOLLAR) / 1_000_000, impressions: num(m.IMPRESSION_1), clicks: num(m.CLICKTHROUGH_1), videoViews: null });
      }
    }
    return { rows, notes };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("PATCH", `${this.acct}/campaigns`, [{ id: campaignId, status: "PAUSED" }]);
    this.firstItem("pause campaign", raw);
    return { campaignId, status: "PAUSED", raw };
  }
}
