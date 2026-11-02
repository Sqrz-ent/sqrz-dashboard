import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, centsToMicros, dryRunResult, extraStr, extraStrList,
  firstArray, httpJson, num, oauthForm, optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Reddit Ads API (v3) outlet adapter — SANDBOX ONLY.
// Base https://ads-api.reddit.com/api/v3. OAuth2 refresh-token flow against
// www.reddit.com/api/v1/access_token (HTTP Basic client auth, descriptive
// User-Agent required). Access is allow-listed — see docs/outlets/reddit.md.
// Chain: campaign → ad group (with community targeting) → ad, all configured_status PAUSED.
//
// COMMUNITY (subreddit) TARGETING: extra.communities = ["r/techno", "Berlin", "t5_2qh1i", …].
// Third-party guides warn that names alone don't work in targeting — the API wants
// community IDs — so names are resolved to ids via reddit.com/r/<name>/about.json
// (`name` = "t5_xxxx"); values already looking like t5_xxxx are used as-is.
//
// VERIFIED (third-party guides, not Reddit's reference): base URL; POST
// /accounts/{account_id}/ad_groups; ads default to PAUSED on create; DAILY_SPEND
// ad groups have a $5/day minimum; community ids (not names) are used for targeting.
// UNVERIFIED: campaign/ad group/ad request bodies and enum values, the ad creative
// shape (a hosted image + headline here), the metrics/report endpoint, the
// resolution of names → ids, and the update call used by pause.
// `validate_only: true` sends NOTHING (no resolution either) and returns the bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://ads-api.reddit.com/api/v3";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

export type RedditConfig = { clientId: string; clientSecret: string; refreshToken: string; accountId: string; userAgent: string; profileId: string };

export function redditConfigFromEnv(): RedditConfig {
  const s = requireEnv(["REDDIT_ADS_CLIENT_ID", "REDDIT_ADS_CLIENT_SECRET", "REDDIT_ADS_REFRESH_TOKEN", "REDDIT_ADS_ACCOUNT_ID"] as const);
  return {
    clientId: s.REDDIT_ADS_CLIENT_ID, clientSecret: s.REDDIT_ADS_CLIENT_SECRET, refreshToken: s.REDDIT_ADS_REFRESH_TOKEN, accountId: s.REDDIT_ADS_ACCOUNT_ID,
    userAgent: optionalEnv("REDDIT_ADS_USER_AGENT", "sqrz-outlet-sandbox/1.0 (by u/sqrz)"), profileId: optionalEnv("REDDIT_ADS_PROFILE_ID"),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => {
  const parts = [b?.message, b?.error, b?.detail, b?.error_description].filter((x) => typeof x === "string");
  if (Array.isArray(b?.errors)) for (const e of b.errors) parts.push(e?.message ?? JSON.stringify(e).slice(0, 200));
  return [...new Set(parts)].join(" — ");
};

export class RedditAdsAdapter implements OutletAdapter {
  readonly name = "reddit" as const;
  constructor(private readonly cfg: RedditConfig) {}

  private token(): Promise<string> {
    const c = this.cfg;
    return oauthForm(`reddit:${c.clientId}:${c.refreshToken}`, TOKEN_URL, { grant_type: "refresh_token", refresh_token: c.refreshToken },
      { basic: { id: c.clientId, secret: c.clientSecret }, headers: { "User-Agent": c.userAgent }, fmt: fmtErr });
  }

  // deno-lint-ignore no-explicit-any
  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const t = await this.token();
    const b = await httpJson(`${method} ${path}`, `${BASE}${path}`, {
      method, headers: { Authorization: `Bearer ${t}`, "User-Agent": this.cfg.userAgent, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, fmtErr);
    return b?.data ?? b;
  }

  private get acct() { return `/accounts/${this.cfg.accountId}`; }

  async ping(): Promise<PingResult> {
    const a = await this.api("GET", this.acct);
    return { ok: true, detail: `Reddit ads account ${this.cfg.accountId}${a?.name ? ` (${a.name})` : ""}`, raw: a };
  }

  /** No upload endpoint is known/verified: Reddit ad creatives reference a hosted image URL (or an existing post). */
  uploadAsset(_input: UploadAssetInput): Promise<UploadedAsset> {
    throw new ParamError("reddit has no verified asset-upload endpoint: pass a hosted https image URL as logo_url/asset_id to create_campaign instead");
  }

  private async resolveCommunities(list: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const c of list) {
      if (/^t5_[a-z0-9]+$/i.test(c)) { out.push(c); continue; }
      const sub = c.replace(/^\/?r\//i, "");
      if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw new ParamError(`invalid subreddit name: ${c}`);
      const r = await httpJson(`GET r/${sub}/about`, `https://www.reddit.com/r/${sub}/about.json`, { headers: { "User-Agent": this.cfg.userAgent } }, fmtErr);
      const id = r?.data?.name;
      if (!id) throw new OutletError(`could not resolve subreddit ${sub} to a community id`, r);
      out.push(String(id));
    }
    return out;
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "reddit");
    assertSqrzLandingUrl(input.landingUrl);
    checkTexts("headlines", input.headlines, { max: 300, maxCount: 1 });
    checkBudget(input.dailyBudgetCents, 500); // $5/day minimum for DAILY_SPEND (per third-party guides)
    const communities = extraStrList(input, "communities");
    const imageUrl = extraStr(input, "image_url") ?? (input.assetId.startsWith("https://") ? input.assetId : input.logoUrl);
    if (!imageUrl) throw new ParamError("reddit create_campaign needs a hosted https image: asset_id (URL), logo_url or extra.image_url");
    const name = `[SANDBOX] ${input.name}`.slice(0, 200);
    const acct = this.acct;

    const campaign = { name, objective: "TRAFFIC", configured_status: "PAUSED" };
    const adGroup = (campaignId: string, ids: string[]) => ({
      campaign_id: campaignId, name: `${name} ad group`, configured_status: "PAUSED", bid_strategy: "LOWEST_COST",
      goal_type: "DAILY_SPEND", goal_value: centsToMicros(input.dailyBudgetCents),
      targeting: ids.length ? { communities: ids } : {},
    });
    const ad = (adGroupId: string) => ({
      ad_group_id: adGroupId, name: `${name} ad`, configured_status: "PAUSED", click_url: input.landingUrl, headline: input.headlines[0],
      ...(this.cfg.profileId ? { profile_id: this.cfg.profileId } : {}), creative: { type: "IMAGE", image_url: imageUrl },
      ...(input.callToAction ? { call_to_action: input.callToAction } : {}),
    });

    if (input.validateOnly) {
      return dryRunResult([
        { POST: `${acct}/campaigns`, body: campaign }, { POST: `${acct}/ad_groups`, body: adGroup("<campaignId>", communities.map((c) => (/^t5_/i.test(c) ? c : `<id of ${c}>`))) },
        { POST: `${acct}/ads`, body: ad("<adGroupId>") },
      ], { communities });
    }

    const ids = await this.resolveCommunities(communities);
    const objects: OutletObject[] = [];
    try {
      const c = await this.api("POST", `${acct}/campaigns`, campaign);
      const cid = String(c?.id ?? ""); if (!cid) throw new OutletError("create campaign returned no id", c);
      objects.push({ objectType: "campaign", externalId: cid, raw: { configured_status: "PAUSED", landingUrl: input.landingUrl } });
      const g = await this.api("POST", `${acct}/ad_groups`, adGroup(cid, ids));
      const gid = String(g?.id ?? ""); if (!gid) throw new OutletError("create ad group returned no id", g);
      objects.push({ objectType: "ad_group", externalId: gid, parentExternalId: cid, raw: { communities: ids } });
      const a = await this.api("POST", `${acct}/ads`, ad(gid));
      const aid = String(a?.id ?? ""); if (!aid) throw new OutletError("create ad returned no id", a);
      objects.push({ objectType: "ad", externalId: aid, parentExternalId: gid });
      return { status: "PAUSED", campaignId: cid, adGroupId: gid, adId: aid, budgetId: gid, validateOnly: false, objects, raw: { c, g, a } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const body = { data: { starts_at: `${from}T00:00:00Z`, ends_at: `${to}T23:59:59Z`, breakdowns: ["CAMPAIGN_ID"], fields: ["IMPRESSIONS", "CLICKS", "SPEND"] } };
    const r = await this.api("POST", `${this.acct}/reports`, body);
    const rows: InsightRow[] = [];
    for (const x of firstArray(r, ["metrics", "data", "results", "rows"])) {
      const id = String(x.campaign_id ?? x.id ?? ""); if (!id || (query.campaignIds?.length && !query.campaignIds.includes(id))) continue;
      rows.push({ campaignId: id, campaignName: x.campaign_name ?? "", channelType: "REDDIT", status: "", currency: x.currency ?? "USD",
        spend: num(x.spend) / 1_000_000, impressions: num(x.impressions), clicks: num(x.clicks), videoViews: null });
    }
    return { rows, notes: ["Reports endpoint/body and response are unverified; spend assumed in micro-units."] };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("PATCH", `${this.acct}/campaigns/${campaignId}`, { configured_status: "PAUSED" });
    return { campaignId, status: "PAUSED", raw };
  }
}
