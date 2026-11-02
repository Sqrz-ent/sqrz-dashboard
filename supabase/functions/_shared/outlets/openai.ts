import {
  assertSqrzLandingUrl, centsToMicros, checkBudget, checkNumericIds, checkTexts, DRY_RUN_ID, fetchAsBlob, fileNameFor,
  httpJson, num, optionalEnv, rejectGeo, requireEnv, resolveDateRange,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult,
  OutletError, type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult,
  type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ChatGPT Ads API outlet adapter — SANDBOX ONLY. https://api.ads.openai.com/v1,
// bearer API key (OPENAI_ADS_API_KEY). Hierarchy: ad account → campaign →
// ad group → ad. Everything is created with status "paused". No separate
// sandbox environment is documented — use a dedicated, unfunded ad account.
//
// VERIFIED (developers.openai.com/ads, via search snippets): base URL and
// bearer auth; hierarchy; ad groups at /v1/ad_groups with separate POST
// /{id}/activate | pause | archive; a direct POST /v1/campaigns example with
// name, status "paused", bidding_type "clicks", budget.daily_spend_limit_micros
// and targeting.locations.countries (the Bulk API uses a different, flat
// max_budget_micros shape); POST /ads with status active|paused and a
// creative { type: "chat_card", title (3–50), body (≤100), target_url,
// file_id }; images come from POST /upload; GET /v1/ads/{id}/insights with a
// granularity parameter.
// UNVERIFIED: the ad-group body (bid configuration fields), the upload
// request format, campaign-level insights path + response shape, listing
// shape, and POST /campaigns/{id}/pause (confirmed for ad groups only).
// `validate_only: true` sends NOTHING and returns the request bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://api.ads.openai.com/v1";

export type OpenAIAdsConfig = { apiKey: string; countries: string[] };

export function openaiConfigFromEnv(): OpenAIAdsConfig {
  const s = requireEnv(["OPENAI_ADS_API_KEY"] as const);
  return {
    apiKey: s.OPENAI_ADS_API_KEY,
    countries: optionalEnv("OPENAI_ADS_TARGET_COUNTRIES", "US").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => {
  const e = b?.error ?? b;
  return [e?.message, e?.code ? `code=${e.code}` : "", e?.param ? `param=${e.param}` : ""].filter(Boolean).join(" ");
};

export class OpenAIAdsAdapter implements OutletAdapter {
  readonly name = "openai" as const;
  constructor(private readonly cfg: OpenAIAdsConfig) {}

  // deno-lint-ignore no-explicit-any
  private api(method: string, path: string, body?: unknown, form?: FormData): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}` };
    if (!form) headers["Content-Type"] = "application/json";
    return httpJson(`${method} ${path}`, `${BASE}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) }, fmtErr);
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", "/campaigns?limit=1");
    const n = Array.isArray(b?.data) ? b.data.length : undefined;
    return { ok: true, detail: `api.ads.openai.com reachable, key accepted${n === undefined ? "" : ` (${n} campaign(s) in first page)`}`, raw: b };
  }

  /** Image for a chat_card creative → file_id. UNVERIFIED request format (multipart `file`). */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 20 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    if (!ct.startsWith("image/")) throw new ParamError(`openai upload_asset supports images only, got ${ct}`);
    const form = new FormData();
    form.set("file", f.blob, fileNameFor(input.title, ct));
    const b = await this.api("POST", "/upload", undefined, form);
    const id = String(b?.file_id ?? b?.id ?? "");
    if (!id) throw new OutletError("upload returned no file_id/id", b);
    return { externalId: id, visibility: "ad-account-file", objects: [{ objectType: "file", externalId: id, raw: b }], raw: b };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "openai");
    assertSqrzLandingUrl(input.landingUrl);
    checkTexts("headlines", input.headlines, { min: 1, max: 50, maxCount: 1 });
    if (input.headlines[0].length < 3) throw new ParamError("headline (creative title) must be 3–50 chars");
    checkTexts("descriptions", input.descriptions, { min: 1, max: 100, maxCount: 1 });
    checkBudget(input.dailyBudgetCents, 1);
    const name = `[SANDBOX] ${input.name}`.slice(0, 120);

    const campaign = {
      name, status: "paused", bidding_type: "clicks",
      budget: { daily_spend_limit_micros: centsToMicros(input.dailyBudgetCents) },
      targeting: { locations: { countries: this.cfg.countries } },
    };
    const adGroup = (campaignId: string) => ({ campaign_id: campaignId, name: `${name} ad group`, status: "paused" });
    const ad = (adGroupId: string) => ({
      ad_group_id: adGroupId, name: `${name} ad`, status: "paused",
      creative: {
        type: "chat_card", title: input.headlines[0], body: input.descriptions[0], target_url: input.landingUrl,
        ...(input.assetId ? { file_id: input.assetId } : {}),
      },
    });

    if (input.validateOnly) {
      return {
        status: "PAUSED", campaignId: DRY_RUN_ID, adGroupId: DRY_RUN_ID, adId: DRY_RUN_ID, budgetId: DRY_RUN_ID,
        validateOnly: true, objects: [],
        raw: { dryRun: true, requests: [
          { POST: "/campaigns", body: campaign }, { POST: "/ad_groups", body: adGroup("<campaignId>") }, { POST: "/ads", body: ad("<adGroupId>") },
        ] },
      };
    }

    const objects: OutletObject[] = [];
    try {
      const c = await this.api("POST", "/campaigns", campaign);
      if (!c?.id) throw new OutletError("create campaign returned no id", c);
      objects.push({ objectType: "campaign", externalId: String(c.id), raw: { status: "paused", landingUrl: input.landingUrl } });
      const g = await this.api("POST", "/ad_groups", adGroup(c.id));
      if (!g?.id) throw new OutletError("create ad group returned no id", g);
      objects.push({ objectType: "ad_group", externalId: String(g.id), parentExternalId: String(c.id) });
      const a = await this.api("POST", "/ads", ad(g.id));
      if (!a?.id) throw new OutletError("create ad returned no id", a);
      objects.push({ objectType: "ad", externalId: String(a.id), parentExternalId: String(g.id) });
      return { status: "PAUSED", campaignId: String(c.id), adGroupId: String(g.id), adId: String(a.id), budgetId: String(c.id), validateOnly: false, objects, raw: { c, g, a } };
    } catch (e) {
      // Objects created so far stay (all paused); surface them so they get logged for manual cleanup.
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const notes = ["Insights response shape is unverified: spend/impressions/clicks are read defensively (spend_micros preferred)."];
    const list = await this.api("GET", "/campaigns?limit=100");
    // deno-lint-ignore no-explicit-any
    let camps: any[] = list?.data ?? [];
    if (query.campaignIds?.length) camps = camps.filter((c) => query.campaignIds!.includes(c.id));
    const rows: InsightRow[] = [];
    for (const c of camps) {
      let m: Record<string, unknown> = {};
      try {
        const r = await this.api("GET", `/campaigns/${c.id}/insights?${new URLSearchParams({ granularity: "total", start_date: from, end_date: to })}`);
        m = (Array.isArray(r?.data) ? r.data[0] : r?.data ?? r) ?? {};
        // deno-lint-ignore no-explicit-any
        if ((m as any).metrics) m = (m as any).metrics;
      } catch (e) {
        notes.push(`insights for ${c.id} failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      }
      rows.push({
        campaignId: String(c.id), campaignName: c.name ?? "", channelType: "CHATGPT_ADS", status: c.status ?? "", currency: c.currency ?? "USD",
        spend: m.spend_micros !== undefined ? num(m.spend_micros) / 1_000_000 : num(m.spend),
        impressions: num(m.impressions), clicks: num(m.clicks), videoViews: null,
      });
    }
    return { rows, notes };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("POST", `/campaigns/${campaignId}/pause`, {});
    return { campaignId, status: "PAUSED", raw };
  }
}
