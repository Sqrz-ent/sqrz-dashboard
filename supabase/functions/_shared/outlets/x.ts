import {
  assertSqrzLandingUrl, centsToMicros, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, firstArray, num, oauth1Header,
  optionalEnv, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// X Ads API outlet adapter — SANDBOX ONLY. OAuth 1.0a user context (HMAC-SHA1;
// consumer key/secret + the ad account user's access token/secret). Needs Ads API
// access approval — see docs/outlets/x.md. Requests are form-encoded.
// X_ADS_ENV = "sandbox" (default, ads-api-sandbox.twitter.com) | "production"
// (ads-api.x.com). X_ADS_API_VERSION defaults to "12" (the version shown in the
// current line-items reference; override when X moves on).
// Chain: campaign → line item (PROMOTED_TWEETS) → promoted tweet, all entity_status PAUSED.
// The creative is a Tweet: by default a nullcast ("promoted-only", not on the
// timeline) tweet "<headline> https://<slug>.sqrz.com" is created for the account;
// or promote an existing tweet with extra.tweet_id.
//
// VERIFIED (X docs, via search snippets): create flow funding instrument →
// campaign (funding_instrument_id, name, budget fields) → line item (campaign_id,
// product_type PROMOTED_TWEETS, entity_status PAUSED) → promoted tweets; limits
// (100 line items/campaign); un-pausing is a PUT with entity_status; OAuth 1.0a.
// UNVERIFIED: line-item objective/placements/bid fields, the nullcast tweet
// endpoint (POST accounts/:id/tweet), stats response shape, the sandbox host.
// `validate_only: true` sends NOTHING and returns the bodies built.
// ─────────────────────────────────────────────────────────────────────────────

export type XConfig = {
  env: "sandbox" | "production"; version: string; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string;
  accountId: string; fundingInstrumentId: string; asUserId: string;
};

export function xConfigFromEnv(): XConfig {
  const env = optionalEnv("X_ADS_ENV", "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "production") throw new ConfigError(`X_ADS_ENV must be "sandbox" or "production", got "${env}"`);
  const s = requireEnv(["X_ADS_CONSUMER_KEY", "X_ADS_CONSUMER_SECRET", "X_ADS_ACCESS_TOKEN", "X_ADS_ACCESS_TOKEN_SECRET", "X_ADS_ACCOUNT_ID", "X_ADS_FUNDING_INSTRUMENT_ID"] as const);
  return {
    env, version: optionalEnv("X_ADS_API_VERSION", "12"), consumerKey: s.X_ADS_CONSUMER_KEY, consumerSecret: s.X_ADS_CONSUMER_SECRET,
    token: s.X_ADS_ACCESS_TOKEN, tokenSecret: s.X_ADS_ACCESS_TOKEN_SECRET, accountId: s.X_ADS_ACCOUNT_ID,
    fundingInstrumentId: s.X_ADS_FUNDING_INSTRUMENT_ID, asUserId: optionalEnv("X_ADS_AS_USER_ID"),
  };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => (b?.errors ?? []).map((e: { code?: string; message?: string }) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");

export class XAdsAdapter implements OutletAdapter {
  readonly name = "x" as const;
  constructor(private readonly cfg: XConfig) {}

  private get base() { return `${this.cfg.env === "sandbox" ? "https://ads-api-sandbox.twitter.com" : "https://ads-api.x.com"}/${this.cfg.version}`; }
  private get acct() { return `/accounts/${this.cfg.accountId}`; }

  // deno-lint-ignore no-explicit-any
  private async api(method: "GET" | "POST" | "PUT", path: string, params: Record<string, string> = {}): Promise<any> {
    let url = `${this.base}${path}`;
    let body: string | undefined;
    const qs = new URLSearchParams(params).toString();
    if (method === "GET") { if (qs) url += `?${qs}`; } else body = qs;
    const auth = await oauth1Header(method, method === "GET" ? url.split("?")[0] : url, params, {
      consumerKey: this.cfg.consumerKey, consumerSecret: this.cfg.consumerSecret, token: this.cfg.token, tokenSecret: this.cfg.tokenSecret,
    });
    const res = await fetch(url, { method, headers: { Authorization: auth, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body });
    const text = await res.text();
    // deno-lint-ignore no-explicit-any
    let b: any = {}; try { b = text ? JSON.parse(text) : {}; } catch { b = { raw: text.slice(0, 300) }; }
    if (!res.ok || b?.errors?.length) throw new OutletError(`${method} ${path} → ${res.status} ${fmtErr(b) || text.slice(0, 200)}`.trim(), b);
    return b;
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", this.acct);
    const a = b?.data ?? {};
    return { ok: true, detail: `${this.cfg.env}: ${a.name ?? "?"} (account ${this.cfg.accountId}, ${a.currency ?? "?"}, ${a.approval_status ?? "?"})`, raw: a };
  }

  /** Not supported: X creatives are Tweets. Create the tweet (with media) in X, then pass extra.tweet_id. */
  uploadAsset(_input: UploadAssetInput): Promise<UploadedAsset> {
    throw new ParamError("x has no ad-asset upload: create the tweet in X and pass extra.tweet_id to create_campaign (or let it create a text+link nullcast tweet)");
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "x");
    assertSqrzLandingUrl(input.landingUrl);
    checkTexts("headlines", input.headlines, { max: 200, maxCount: 1 });
    checkBudget(input.dailyBudgetCents, 1);
    const existing = extraStr(input, "tweet_id");
    const name = `[SANDBOX] ${input.name}`.slice(0, 80);
    const text = `${input.headlines[0]} ${input.landingUrl}`; // ≤ 280 (t.co counts links as 23)
    const micros = String(centsToMicros(input.dailyBudgetCents)); // account-currency micros

    const tweet: Record<string, string> = { text, nullcast: "true", ...(this.cfg.asUserId ? { as_user_id: this.cfg.asUserId } : {}) };
    const campaign = { funding_instrument_id: this.cfg.fundingInstrumentId, name, daily_budget_amount_local_micro: micros, entity_status: "PAUSED" };
    const lineItem = (cid: string) => ({
      campaign_id: cid, name: `${name} line item`, product_type: "PROMOTED_TWEETS", placements: "ALL_ON_TWITTER", objective: "WEBSITE_CLICKS",
      bid_type: "AUTO", entity_status: "PAUSED",
    });
    const promoted = (lid: string, tid: string) => ({ line_item_id: lid, tweet_ids: tid });

    if (input.validateOnly) {
      return dryRunResult([
        ...(existing ? [] : [{ POST: `${this.acct}/tweet`, form: tweet }]), { POST: `${this.acct}/campaigns`, form: campaign },
        { POST: `${this.acct}/line_items`, form: lineItem("<campaignId>") }, { POST: `${this.acct}/promoted_tweets`, form: promoted("<lineItemId>", existing ?? "<tweetId>") },
      ], { env: this.cfg.env });
    }

    const objects: OutletObject[] = [];
    try {
      let tweetId = existing;
      if (!tweetId) {
        const t = await this.api("POST", `${this.acct}/tweet`, tweet);
        tweetId = String(t?.data?.id_str ?? t?.data?.id ?? ""); if (!tweetId) throw new OutletError("tweet creation returned no id", t);
        objects.push({ objectType: "nullcast_tweet", externalId: tweetId, raw: { text } });
      }
      const c = await this.api("POST", `${this.acct}/campaigns`, campaign);
      const cid = String(c?.data?.id ?? ""); if (!cid) throw new OutletError("create campaign returned no id", c);
      objects.push({ objectType: "campaign", externalId: cid, raw: { entity_status: "PAUSED", landingUrl: input.landingUrl } });
      const l = await this.api("POST", `${this.acct}/line_items`, lineItem(cid));
      const lid = String(l?.data?.id ?? ""); if (!lid) throw new OutletError("create line item returned no id", l);
      objects.push({ objectType: "line_item", externalId: lid, parentExternalId: cid });
      const p = await this.api("POST", `${this.acct}/promoted_tweets`, promoted(lid, tweetId));
      const pid = String(firstArray(p, ["data"])[0]?.id ?? p?.data?.id ?? ""); if (!pid) throw new OutletError("promote tweet returned no id", p);
      objects.push({ objectType: "promoted_tweet", externalId: pid, parentExternalId: lid });
      return { status: "PAUSED", campaignId: cid, adGroupId: lid, adId: pid, budgetId: cid, validateOnly: false, objects, raw: { c, l, p } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const endExclusive = new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10);
    const list = await this.api("GET", `${this.acct}/campaigns`, { count: "200", with_deleted: "false" });
    // deno-lint-ignore no-explicit-any
    let camps: any[] = firstArray(list, ["data"]);
    if (query.campaignIds?.length) camps = camps.filter((c) => query.campaignIds!.includes(String(c.id)));
    const rows: InsightRow[] = [];
    for (let i = 0; i < camps.length; i += 20) {
      const chunk = camps.slice(i, i + 20);
      const st = await this.api("GET", `/stats/accounts/${this.cfg.accountId}`, {
        entity: "CAMPAIGN", entity_ids: chunk.map((c) => c.id).join(","), granularity: "TOTAL", metric_groups: "ENGAGEMENT,BILLING,VIDEO",
        placement: "ALL_ON_TWITTER", start_time: `${from}T00:00:00Z`, end_time: `${endExclusive}T00:00:00Z`,
      });
      for (const d of firstArray(st, ["data"])) {
        const m = d.id_data?.[0]?.metrics ?? {}; const c = chunk.find((x) => String(x.id) === String(d.id));
        const one = (v: unknown) => (Array.isArray(v) ? num(v[0]) : num(v));
        rows.push({
          campaignId: String(d.id), campaignName: c?.name ?? "", channelType: "X_PROMOTED_TWEETS", status: c?.entity_status ?? "", currency: c?.currency ?? null,
          spend: one(m.billed_charge_local_micro) / 1_000_000, impressions: one(m.impressions), clicks: one(m.clicks),
          videoViews: m.video_total_views === undefined ? null : one(m.video_total_views),
        });
      }
    }
    return { rows, notes: ["Stats window: end_time is exclusive (to + 1 day, midnight UTC); stats response shape unverified."] };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("PUT", `${this.acct}/campaigns/${campaignId}`, { entity_status: "PAUSED" });
    return { campaignId, status: "PAUSED", raw };
  }
}
