import {
  ConfigError,
  type CreateCampaignInput,
  type CreatedCampaign,
  type InsightRow,
  type InsightsQuery,
  type InsightsResult,
  OutletError,
  type OutletAdapter,
  type OutletObject,
  ParamError,
  type PauseResult,
  type PingResult,
  type UploadAssetInput,
  type UploadedAsset,
} from "./types.ts";
import { getOutletSecret } from "./outlet-secrets.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Google outlet adapter (Google Ads REST API + YouTube Data API v3).
//
// SANDBOX ONLY — not wired to boost_campaigns / campaign_templates.
//
// IMPORTANT product constraints (Google side):
//   * Classic "Video" campaigns (advertising_channel_type = VIDEO) CANNOT be
//     created via the Google Ads API. For YouTube inventory via API we create
//     DEMAND_GEN campaigns instead. VIDEO campaigns are REPORTING-ONLY here:
//     getInsights reads them (they may have been created in the Google Ads UI),
//     but nothing in this file creates or edits one.
//   * Everything we create is PAUSED. There is deliberately no code path that
//     enables a campaign, ad group or ad.
//
// API version: NOT hard-coded. Set the GOOGLE_ADS_API_VERSION secret (e.g.
// "v25") after checking https://developers.google.com/google-ads/api/docs/release-notes
// and the sunset-dates page. The session this was written in could not reach
// Google's docs, so no version is guessed here.
//
// The request payload shapes below follow the REST/JSON mapping of the Google
// Ads protos. They could not be checked against Google's reference from the
// build session, so use `validate_only: true` on create_demand_gen first —
// Google then validates the full request and creates nothing.
// ─────────────────────────────────────────────────────────────────────────────

export type GoogleAdsConfig = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager (MCC) account id used as login-customer-id. Digits only. */
  loginCustomerId: string;
  /** Client account id the sandbox operates on. Digits only. */
  customerId: string;
  apiVersion: string;
};

const REQUIRED_SECRETS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_API_VERSION",
] as const;

export function googleConfigFromEnv(): GoogleAdsConfig {
  const missing = REQUIRED_SECRETS.filter((k) => !getOutletSecret(k));
  if (missing.length) {
    throw new ConfigError(`missing secrets: ${missing.join(", ")}`);
  }
  const env = (k: string) => getOutletSecret(k)!;
  const apiVersion = env("GOOGLE_ADS_API_VERSION");
  if (!/^v\d+$/.test(apiVersion)) {
    throw new ConfigError(`GOOGLE_ADS_API_VERSION must look like "v25", got "${apiVersion}"`);
  }
  return {
    developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN"),
    clientId: env("GOOGLE_ADS_CLIENT_ID"),
    clientSecret: env("GOOGLE_ADS_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_ADS_REFRESH_TOKEN"),
    loginCustomerId: env("GOOGLE_ADS_LOGIN_CUSTOMER_ID").replace(/-/g, ""),
    customerId: env("GOOGLE_ADS_CUSTOMER_ID").replace(/-/g, ""),
    apiVersion,
  };
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const SCOPE_ADWORDS = "https://www.googleapis.com/auth/adwords";
const SCOPE_YT_UPLOAD = "https://www.googleapis.com/auth/youtube.upload";

// ── Error formatting (counterpart of formatMetaError) ─────────────────────────

type GoogleErrorBody = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: {
      requestId?: string;
      errors?: {
        errorCode?: Record<string, string>;
        message?: string;
        location?: { fieldPathElements?: { fieldName?: string; index?: number }[] };
      }[];
    }[];
    errors?: { reason?: string; message?: string }[]; // YouTube / OAuth style
  };
  error_description?: string; // OAuth token endpoint
};

function formatGoogleError(body: GoogleErrorBody | undefined, res?: Response): string {
  if (!body) return "";
  const e = body.error;
  const parts: string[] = [];
  if (typeof e === "string") parts.push(e as string);
  if (body.error_description) parts.push(body.error_description);
  if (e?.message) parts.push(e.message);
  for (const d of e?.details ?? []) {
    for (const ge of d.errors ?? []) {
      const code = ge.errorCode ? Object.entries(ge.errorCode).map(([k, v]) => `${k}=${v}`).join(",") : "";
      const path = ge.location?.fieldPathElements?.map((p) => p.fieldName + (p.index != null ? `[${p.index}]` : "")).join(".");
      parts.push([ge.message, code && `(${code})`, path && `at ${path}`].filter(Boolean).join(" "));
    }
  }
  for (const ye of e?.errors ?? []) parts.push(`${ye.reason ?? ""} ${ye.message ?? ""}`.trim());
  const reqId =
    e?.details?.find((d) => d.requestId)?.requestId ?? res?.headers.get("request-id") ?? undefined;
  const meta = [
    e?.status ? `status=${e.status}` : null,
    e?.code !== undefined ? `code=${e.code}` : null,
    reqId ? `request_id=${reqId}` : null,
  ].filter(Boolean).join(" ");
  return [...new Set(parts)].join(" — ") + (meta ? ` (${meta})` : "");
}

// ── OAuth: refresh-token flow, cached per isolate ─────────────────────────────

type TokenCache = { token: string; scope: string; expiresAt: number; key: string };
let tokenCache: TokenCache | null = null;

async function getAccessToken(cfg: GoogleAdsConfig): Promise<{ token: string; scope: string }> {
  const key = `${cfg.clientId}:${cfg.refreshToken}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache;
  }
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as
    & GoogleErrorBody
    & { access_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !body.access_token) {
    throw new OutletError(`OAuth refresh failed → ${res.status} ${formatGoogleError(body, res)}`.trim(), body);
  }
  tokenCache = {
    token: body.access_token,
    scope: body.scope ?? "",
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    key,
  };
  return tokenCache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const GAQL_PRESETS = new Set([
  "TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS",
  "THIS_MONTH", "LAST_MONTH", "ALL_TIME",
]);

const toNum = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function extractIdFromResource(resourceName: string): string {
  return resourceName.split("/").pop() ?? resourceName;
}

// Demand Gen text limits (characters).
const LIMITS = { headline: 30, longHeadline: 90, description: 90, businessName: 25 };

function checkTexts(label: string, list: string[], max: number, maxCount = 5) {
  if (!list.length) throw new ParamError(`${label}: at least one required`);
  if (list.length > maxCount) throw new ParamError(`${label}: at most ${maxCount}`);
  for (const t of list) {
    if (!t.trim() || t.length > max) throw new ParamError(`${label}: "${t}" must be 1–${max} chars`);
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class GoogleAdsAdapter implements OutletAdapter {
  readonly name = "google" as const;

  constructor(private readonly cfg: GoogleAdsConfig) {}

  // ── Google Ads REST ─────────────────────────────────────────────────────────

  private async ads(path: string, body: unknown): Promise<unknown> {
    const { token, scope } = await getAccessToken(this.cfg);
    if (scope && !scope.includes(SCOPE_ADWORDS)) {
      throw new OutletError(`refresh token lacks the adwords scope (granted: ${scope})`);
    }
    const res = await fetch(
      `https://googleads.googleapis.com/${this.cfg.apiVersion}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": this.cfg.developerToken,
          "login-customer-id": this.cfg.loginCustomerId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const parsed = await res.json().catch(() => ({}));
    // searchStream returns an array, errors come back as { error } or [{ error }].
    const errBody = (Array.isArray(parsed) ? parsed.find((p) => p?.error) : parsed) as GoogleErrorBody;
    if (!res.ok || errBody?.error) {
      throw new OutletError(`POST ${path} → ${res.status} ${formatGoogleError(errBody, res)}`.trim(), parsed);
    }
    return parsed;
  }

  private async gaql(query: string): Promise<Record<string, any>[]> {
    const batches = (await this.ads(
      `customers/${this.cfg.customerId}/googleAds:searchStream`,
      { query },
    )) as { results?: Record<string, any>[] }[];
    return batches.flatMap((b) => b.results ?? []);
  }

  private get cid() {
    return this.cfg.customerId;
  }

  // ── ping ────────────────────────────────────────────────────────────────────

  async ping(): Promise<PingResult> {
    const rows = await this.gaql(
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.test_account FROM customer LIMIT 1",
    );
    const c = rows[0]?.customer ?? {};
    const checks: NonNullable<PingResult["checks"]> = {};

    // YouTube side: separate check, never fails the ping as a whole.
    try {
      const { token, scope } = await getAccessToken(this.cfg);
      checks.youtube_scope = scope.includes(SCOPE_YT_UPLOAD)
        ? { ok: true, detail: "youtube.upload scope granted" }
        : { ok: false, detail: `refresh token lacks ${SCOPE_YT_UPLOAD} (granted: ${scope})` };
      const res = await fetch(`${YOUTUBE_API}/channels?part=id,snippet&mine=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as GoogleErrorBody & {
        items?: { id: string; snippet?: { title?: string } }[];
      };
      // channels.list needs youtube.readonly/youtube scope; 403 here is expected with upload-only tokens.
      checks.youtube_channel = res.ok && body.items?.[0]
        ? { ok: true, detail: `${body.items[0].snippet?.title ?? ""} (${body.items[0].id})` }
        : { ok: false, detail: `channels.list → ${res.status} ${formatGoogleError(body, res)}`.trim() };
    } catch (e) {
      checks.youtube_scope = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }

    return {
      ok: true,
      detail: `${c.descriptiveName ?? "?"} (customer ${c.id ?? this.cid}, ${c.currencyCode ?? "?"}` +
        `${c.testAccount ? ", TEST ACCOUNT" : ""}), API ${this.cfg.apiVersion}`,
      checks,
      raw: c,
    };
  }

  // ── uploadAsset: YouTube resumable upload from a URL ────────────────────────

  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const { token, scope } = await getAccessToken(this.cfg);
    if (scope && !scope.includes(SCOPE_YT_UPLOAD)) {
      throw new OutletError(`refresh token lacks the youtube.upload scope (granted: ${scope})`);
    }

    const src = await fetch(input.sourceUrl);
    if (!src.ok || !src.body) {
      throw new OutletError(`source download failed → ${src.status} ${input.sourceUrl}`);
    }
    const length = src.headers.get("content-length");
    if (!length) {
      // Resumable single-request upload needs the total size up front; we stream
      // the source straight through (no buffering) so we need it from the origin.
      throw new OutletError("source URL did not send Content-Length; cannot stream-upload it");
    }
    const contentType = input.contentType ?? src.headers.get("content-type") ?? "video/*";
    const privacy = input.visibility ?? "unlisted"; // ads can use unlisted/public, never private

    // 1) Start the resumable session.
    const init = await fetch(`${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": length,
        "X-Upload-Content-Type": contentType,
      },
      body: JSON.stringify({
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description ?? "",
          tags: input.tags,
          categoryId: "10", // Music
        },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      }),
    });
    if (!init.ok) {
      const b = (await init.json().catch(() => ({}))) as GoogleErrorBody;
      await src.body.cancel().catch(() => {});
      throw new OutletError(`YouTube upload init → ${init.status} ${formatGoogleError(b, init)}`.trim(), b);
    }
    const sessionUrl = init.headers.get("location");
    if (!sessionUrl) {
      await src.body.cancel().catch(() => {});
      throw new OutletError("YouTube upload init returned no Location header");
    }

    // 2) Stream the bytes in one PUT.
    const put = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": length },
      body: src.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const video = (await put.json().catch(() => ({}))) as GoogleErrorBody & {
      id?: string;
      status?: { privacyStatus?: string; uploadStatus?: string };
    };
    if (!put.ok || !video.id) {
      throw new OutletError(`YouTube upload PUT → ${put.status} ${formatGoogleError(video, put)}`.trim(), video);
    }

    const objects: OutletObject[] = [{
      objectType: "youtube_video",
      externalId: video.id,
      raw: video,
    }];
    return {
      externalId: video.id,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      visibility: video.status?.privacyStatus,
      objects,
      raw: video,
    };
  }

  // ── createCampaign: Demand Gen (PAUSED) ─────────────────────────────────────

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    // Local validation first (cheap, clear errors, mirrors Google's limits).
    checkTexts("headlines", input.headlines, LIMITS.headline);
    checkTexts("long_headlines", input.longHeadlines, LIMITS.longHeadline);
    checkTexts("descriptions", input.descriptions, LIMITS.description);
    if (!input.businessName || input.businessName.length > LIMITS.businessName) {
      throw new ParamError(`business_name must be 1–${LIMITS.businessName} chars`);
    }
    if (!Number.isInteger(input.dailyBudgetCents) || input.dailyBudgetCents <= 0) {
      throw new ParamError("daily_budget_cents must be a positive integer");
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(input.assetId)) {
      throw new ParamError("video_id must be an 11-char YouTube video id");
    }

    const validateOnly = !!input.validateOnly;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `[SANDBOX] ${input.name}`.slice(0, 200);

    // Logo → inline base64 ImageAsset (Demand Gen video ads require a logo).
    const logoRes = await fetch(input.logoUrl);
    if (!logoRes.ok) throw new OutletError(`logo download failed → ${logoRes.status} ${input.logoUrl}`);
    const logoB64 = bytesToBase64(new Uint8Array(await logoRes.arrayBuffer()));

    // Reuse an existing YouTube video asset if one exists (Google rejects duplicates).
    const existing = await this.gaql(
      `SELECT asset.resource_name FROM asset WHERE asset.youtube_video_asset.youtube_video_id = '${input.assetId}' LIMIT 1`,
    );
    const existingVideoAsset: string | undefined = existing[0]?.asset?.resourceName;

    // One atomic googleAds:mutate with temporary (negative) ids — all or nothing,
    // so a failure leaves nothing to roll back (unlike the 5-call Meta chain).
    const t = (kind: string, n: number) => `customers/${this.cid}/${kind}/${n}`;
    const videoAsset = existingVideoAsset ?? t("assets", -1);
    const logoAsset = t("assets", -2);
    const budget = t("campaignBudgets", -3);
    const campaign = t("campaigns", -4);
    const adGroup = t("adGroups", -5);

    const ops: Record<string, unknown>[] = [];
    if (!existingVideoAsset) {
      ops.push({
        assetOperation: {
          create: { resourceName: videoAsset, name: `sandbox video ${input.assetId} ${stamp}`, youtubeVideoAsset: { youtubeVideoId: input.assetId } },
        },
      });
    }
    ops.push(
      { assetOperation: { create: { resourceName: logoAsset, name: `sandbox logo ${stamp}`, imageAsset: { data: logoB64 } } } },
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budget,
            name: `${name} budget ${stamp}`,
            amountMicros: String(input.dailyBudgetCents * 10_000), // cents → micros
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: campaign,
            name,
            status: "PAUSED", // ALWAYS paused
            advertisingChannelType: "DEMAND_GEN",
            campaignBudget: budget,
            // Maximize clicks — no conversion tracking exists in the sandbox.
            targetSpend: {},
            // Required on campaign creation in recent API versions.
            containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          },
        },
      },
    );
    if (input.geo) {
      ops.push({
        campaignCriterionOperation: {
          create: {
            campaign,
            proximity: {
              geoPoint: {
                latitudeInMicroDegrees: Math.round(input.geo.latitude * 1e6),
                longitudeInMicroDegrees: Math.round(input.geo.longitude * 1e6),
              },
              radius: input.geo.radiusKm,
              radiusUnits: "KILOMETERS",
            },
          },
        },
      });
    }
    ops.push(
      { adGroupOperation: { create: { resourceName: adGroup, campaign, name: `${name} ad group`, status: "PAUSED" } } },
      {
        adGroupAdOperation: {
          create: {
            adGroup,
            status: "PAUSED", // ALWAYS paused
            ad: {
              name: `${name} ad`,
              finalUrls: [input.landingUrl],
              demandGenVideoResponsiveAd: {
                videos: [{ asset: videoAsset }],
                logoImages: [{ asset: logoAsset }],
                headlines: input.headlines.map((text) => ({ text })),
                longHeadlines: input.longHeadlines.map((text) => ({ text })),
                descriptions: input.descriptions.map((text) => ({ text })),
                businessName: { text: input.businessName },
                callToActions: [{ callToAction: input.callToAction ?? "LEARN_MORE" }],
              },
            },
          },
        },
      },
    );

    const res = (await this.ads(`customers/${this.cid}/googleAds:mutate`, {
      mutateOperations: ops,
      validateOnly,
      // partialFailure stays false → atomic.
    })) as { mutateOperationResponses?: Record<string, { resourceName?: string }>[] };

    if (validateOnly) {
      return {
        status: "PAUSED",
        campaignId: "(validate_only)",
        adGroupId: "(validate_only)",
        adId: "(validate_only)",
        budgetId: "(validate_only)",
        validateOnly: true,
        objects: [],
        raw: res,
      };
    }

    // Collect created resource names by type.
    const created: Record<string, string[]> = {};
    for (const r of res.mutateOperationResponses ?? []) {
      for (const [k, v] of Object.entries(r)) {
        if (v?.resourceName) (created[k] ??= []).push(v.resourceName);
      }
    }
    const one = (k: string) => created[k]?.[0] ?? "";
    const campaignRN = one("campaignResult");
    const adGroupRN = one("adGroupResult");
    const adRN = one("adGroupAdResult"); // customers/X/adGroupAds/{adGroupId}~{adId}
    const budgetRN = one("campaignBudgetResult");
    const campaignId = extractIdFromResource(campaignRN);
    const adGroupId = extractIdFromResource(adGroupRN);
    const adId = extractIdFromResource(adRN);
    const budgetId = extractIdFromResource(budgetRN);

    const objects: OutletObject[] = [
      { objectType: "campaign_budget", externalId: budgetId, parentExternalId: null, raw: { resourceName: budgetRN } },
      { objectType: "campaign", externalId: campaignId, parentExternalId: budgetId, raw: { resourceName: campaignRN, status: "PAUSED", landingUrl: input.landingUrl } },
      { objectType: "ad_group", externalId: adGroupId, parentExternalId: campaignId, raw: { resourceName: adGroupRN } },
      { objectType: "ad", externalId: adId, parentExternalId: adGroupId, raw: { resourceName: adRN } },
      ...(created.assetResult ?? []).map((rn): OutletObject => ({
        objectType: "asset",
        externalId: extractIdFromResource(rn),
        parentExternalId: campaignId,
        raw: { resourceName: rn },
      })),
    ];

    return { status: "PAUSED", campaignId, adGroupId, adId, budgetId, validateOnly: false, objects, raw: res };
  }

  // ── getInsights: GAQL over DEMAND_GEN + VIDEO campaigns ─────────────────────

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    const notes: string[] = [];
    const where = [`campaign.advertising_channel_type IN ('DEMAND_GEN', 'VIDEO')`];

    if (query.campaignIds?.length) {
      for (const id of query.campaignIds) {
        if (!/^\d+$/.test(id)) throw new ParamError(`campaign id must be numeric: ${id}`); // GAQL-injection guard
      }
      where.push(`campaign.id IN (${query.campaignIds.join(",")})`);
    }
    if (query.from || query.to) {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      if (!query.from || !query.to || !re.test(query.from) || !re.test(query.to)) {
        throw new ParamError("from/to must both be YYYY-MM-DD");
      }
      where.push(`segments.date BETWEEN '${query.from}' AND '${query.to}'`);
    } else {
      const preset = (query.datePreset ?? "LAST_30_DAYS").toUpperCase();
      if (!GAQL_PRESETS.has(preset)) {
        throw new ParamError(`date_preset must be one of ${[...GAQL_PRESETS].join(", ")}`);
      }
      if (preset !== "ALL_TIME") where.push(`segments.date DURING ${preset}`);
    }

    const base = [
      "campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type",
      "customer.currency_code",
      "metrics.cost_micros", "metrics.impressions", "metrics.clicks",
    ];
    const build = (withVideo: boolean) =>
      `SELECT ${[...base, ...(withVideo ? ["metrics.video_trueview_views"] : [])].join(", ")} ` +
      `FROM campaign WHERE ${where.join(" AND ")}`;

    let rows: Record<string, any>[];
    let withVideo = true;
    try {
      rows = await this.gaql(build(true));
    } catch (e) {
      // Some metric/resource combinations are incompatible; retry without the video metric
      // rather than failing the whole report.
      withVideo = false;
      notes.push(`video views metric unavailable, retried without it: ${e instanceof Error ? e.message.slice(0, 300) : e}`);
      rows = await this.gaql(build(false));
    }

    const out: InsightRow[] = rows.map((r) => ({
      campaignId: String(r.campaign?.id ?? ""),
      campaignName: r.campaign?.name ?? "",
      channelType: r.campaign?.advertisingChannelType ?? "",
      status: r.campaign?.status ?? "",
      currency: r.customer?.currencyCode ?? null,
      spend: toNum(r.metrics?.costMicros) / 1_000_000,
      impressions: toNum(r.metrics?.impressions),
      clicks: toNum(r.metrics?.clicks),
      videoViews: withVideo && r.metrics?.videoTrueviewViews !== undefined
        ? toNum(r.metrics.videoTrueviewViews)
        : null,
    }));
    return { rows: out, notes };
  }

  // ── pauseCampaign ───────────────────────────────────────────────────────────

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    if (!/^\d+$/.test(campaignId)) throw new ParamError("campaign_id must be numeric");
    const raw = await this.ads(`customers/${this.cid}/campaigns:mutate`, {
      operations: [{
        update: { resourceName: `customers/${this.cid}/campaigns/${campaignId}`, status: "PAUSED" },
        updateMask: "status",
      }],
    });
    return { campaignId, status: "PAUSED", raw };
  }
}
