import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, dryRunResult, firstArray, httpJson, majorStr, num, oauthForm,
  optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Taboola Backstage API outlet adapter — SANDBOX ONLY. OAuth2 client credentials
// (client_id/secret issued by your Taboola account manager; 12h access token).
// Account id lives in the path: /backstage/api/1.0/{account_id}/…
// Taboola has no ad-group level: campaign → campaign item (the ad). Everything is
// created with is_active=false. Thumbnails are fetched by Taboola from a public URL,
// so asset_id for create_campaign is simply an https image URL (upload_asset only
// validates the URL — nothing is uploaded or created).
//
// VERIFIED (Taboola Backstage docs, via search snippets): client-credentials flow
// (password flow deprecated), 12h token, Bearer header, account_id in the path,
// GET /backstage/api/1.0/{account_id}/campaigns/ pattern, account id also returned
// in the token details. Sources disagree on the token path (…/backstage/oauth/token
// vs …/backstage/api/1.0/oauth/token) — the former is used here.
// UNVERIFIED: campaign/item create bodies (branding_text, cpc, spending_limit(_model),
// marketing_objective), the report dimension path, the partial-update verb for pause.
// `validate_only: true` sends NOTHING and returns the bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const HOST = "https://backstage.taboola.com";

export type TaboolaConfig = { clientId: string; clientSecret: string; accountId: string; defaultCpc: number };

export function taboolaConfigFromEnv(): TaboolaConfig {
  const s = requireEnv(["TABOOLA_ADS_CLIENT_ID", "TABOOLA_ADS_CLIENT_SECRET", "TABOOLA_ADS_ACCOUNT_ID"] as const);
  return { clientId: s.TABOOLA_ADS_CLIENT_ID, clientSecret: s.TABOOLA_ADS_CLIENT_SECRET, accountId: s.TABOOLA_ADS_ACCOUNT_ID, defaultCpc: Number(optionalEnv("TABOOLA_ADS_DEFAULT_CPC", "0.10")) };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.error, b?.error_description, b?.http_status ? `http_status=${b.http_status}` : ""].filter(Boolean).join(" — ");

export class TaboolaAdsAdapter implements OutletAdapter {
  readonly name = "taboola" as const;
  constructor(private readonly cfg: TaboolaConfig) {}

  private token(): Promise<string> {
    const c = this.cfg;
    return oauthForm(`taboola:${c.clientId}`, `${HOST}/backstage/oauth/token`, { grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }, { fmt: fmtErr });
  }
  private get acct() { return `/backstage/api/1.0/${this.cfg.accountId}`; }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const t = await this.token();
    return httpJson(`${method} ${path}`, `${HOST}${path}`, {
      method, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }, fmtErr);
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", `${this.acct}/campaigns/`);
    const n = firstArray(b, ["results"]).length;
    return { ok: true, detail: `account ${this.cfg.accountId}: ${n} campaign(s) visible`, raw: { campaigns: n } };
  }

  /** No upload: Taboola fetches thumbnails from a public URL. This only checks the URL is a reachable image. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const res = await fetch(input.sourceUrl, { method: "HEAD" });
    const ct = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!res.ok || !ct.startsWith("image/")) throw new ParamError(`taboola thumbnail must be a reachable public image URL (got ${res.status} ${ct || "no content-type"})`);
    return { externalId: input.sourceUrl, url: input.sourceUrl, visibility: "public-url", objects: [], raw: { note: "nothing uploaded or created; pass this URL as asset_id to create_campaign" } };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "taboola");
    assertSqrzLandingUrl(input.landingUrl);
    const thumb = input.assetId.startsWith("https://") ? input.assetId : input.logoUrl;
    if (!thumb) throw new ParamError("taboola create_campaign needs a public https thumbnail: asset_id (URL) or logo_url");
    checkTexts("headlines", input.headlines, { max: 100, maxCount: 1 });
    if (input.businessName.length > 25) throw new ParamError("business_name (branding_text) must be ≤25 chars");
    checkBudget(input.dailyBudgetCents, 1);
    const name = `[SANDBOX] ${input.name}`.slice(0, 100);
    const daily = Number(majorStr(input.dailyBudgetCents));

    const campaign = {
      name, branding_text: input.businessName, cpc: this.cfg.defaultCpc, daily_cap: daily, spending_limit: Number((daily * 30).toFixed(2)), spending_limit_model: "MONTHLY",
      marketing_objective: "DRIVE_WEBSITE_TRAFFIC", is_active: false,
    };
    const item = { url: input.landingUrl, thumbnail_url: thumb, title: input.headlines[0] };

    if (input.validateOnly) {
      return dryRunResult([{ POST: `${this.acct}/campaigns/`, body: campaign }, { POST: `${this.acct}/campaigns/<campaignId>/items/`, body: item }]);
    }

    const objects: OutletObject[] = [];
    try {
      const c = await this.api("POST", `${this.acct}/campaigns/`, campaign);
      const cid = String(c?.id ?? ""); if (!cid) throw new OutletError("create campaign returned no id", c);
      objects.push({ objectType: "campaign", externalId: cid, raw: { is_active: false, landingUrl: input.landingUrl } });
      const i = await this.api("POST", `${this.acct}/campaigns/${cid}/items/`, item);
      const iid = String(i?.id ?? ""); if (!iid) throw new OutletError("create item returned no id", i);
      objects.push({ objectType: "campaign_item", externalId: iid, parentExternalId: cid });
      // Taboola has no ad-group level and a campaign-level budget.
      return { status: "PAUSED", campaignId: cid, adGroupId: cid, adId: iid, budgetId: cid, validateOnly: false, objects, raw: { c, i } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const b = await this.api("GET", `${this.acct}/reports/campaign-summary/dimensions/campaign_breakdown?${new URLSearchParams({ start_date: from, end_date: to })}`);
    const rows: InsightRow[] = firstArray(b, ["results"])
      .filter((r) => !query.campaignIds?.length || query.campaignIds.includes(String(r.campaign)))
      .map((r) => ({ campaignId: String(r.campaign ?? r.campaign_id ?? ""), campaignName: r.campaign_name ?? "", channelType: "TABOOLA", status: "", currency: r.currency ?? null,
        spend: num(r.spent), impressions: num(r.impressions), clicks: num(r.clicks), videoViews: null }));
    return { rows, notes: ["Report dimension path/response unverified."] };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("POST", `${this.acct}/campaigns/${campaignId}`, { is_active: false });
    return { campaignId, status: "PAUSED", raw };
  }
}
