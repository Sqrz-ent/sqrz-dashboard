// ─────────────────────────────────────────────────────────────────────────────
// Outlet adapter contract (sandbox).
//
// Modeled on what the live Meta functions do today, so that wiring an outlet
// into campaign_templates / boost_campaigns later is mostly a mapping exercise:
//
//   meta-campaign-create                 → uploadAsset + createCampaign
//     - media upload → Campaign → Ad Set → Creative → Ad, everything PAUSED
//     - returns the created object ids (meta_campaign_id / adset / ad)
//     - rolls back already-created objects when a later step fails
//     - rich error formatting (formatMetaError: message + code + trace id)
//   meta-insights-sync                   → getInsights (read-only pull of spend,
//                                          impressions, clicks; numbers cast from strings)
//   meta-campaign-toggle                 → pauseCampaign
//   connectivity check in insights-sync  → ping
//
// Adapters are pure API clients: they take config via constructor, never touch
// the database, and report every object they create back to the caller (the
// edge function), which logs them to outlet_sandbox.outlet_objects.
// ─────────────────────────────────────────────────────────────────────────────

/** Extend as outlets are added ("tiktok" | "linkedin" | …). */
export type OutletName =
  | "google" | "microsoft" | "snapchat" | "openai" | "spotify"
  | "tiktok" | "reddit" | "linkedin" | "pinterest" | "x" | "amazon" | "taboola" | "adquick";

/** One external object created by an adapter call (campaign, ad group, ad, asset, video, …). */
export interface OutletObject {
  objectType: string;
  externalId: string;
  parentExternalId?: string | null;
  raw?: unknown;
}

export interface PingResult {
  ok: boolean;
  /** Human-readable summary, e.g. account name + currency. */
  detail: string;
  /** Extra checks that must not fail the whole ping (e.g. YouTube scope). */
  checks?: Record<string, { ok: boolean; detail: string }>;
  raw?: unknown;
}

// ── uploadAsset ──────────────────────────────────────────────────────────────

export interface UploadAssetInput {
  /** Publicly fetchable URL of the media file. */
  sourceUrl: string;
  title: string;
  description?: string;
  tags?: string[];
  /** Outlet-specific visibility; Google/YouTube: "private" | "unlisted" | "public". */
  visibility?: string;
  contentType?: string;
}

export interface UploadedAsset {
  /** Outlet-side id (YouTube video id for Google). */
  externalId: string;
  url?: string;
  /** Reported state, e.g. YouTube privacyStatus. */
  visibility?: string;
  objects: OutletObject[];
  raw?: unknown;
}

// ── createCampaign ───────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  /** Campaign display name (adapter may prefix it, e.g. "[SANDBOX]"). */
  name: string;
  /** Outlet-side id of an asset returned by uploadAsset. */
  assetId: string;
  /** Final URL — a https://[slug].sqrz.com profile. */
  landingUrl: string;
  businessName: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  /** Square logo, publicly fetchable. */
  logoUrl: string;
  callToAction?: string;
  /** Daily budget in cents of the ad account's currency (same unit as boost_campaigns.daily_budget_cents). */
  dailyBudgetCents: number;
  geo?: { latitude: number; longitude: number; radiusKm: number };
  /** Ask the outlet to validate only and create nothing (if the outlet supports it). */
  validateOnly?: boolean;
  /**
   * Outlet-specific variant inputs that don't fit the common fields, e.g. TikTok
   * Spark Ads { tiktok_item_id }, Reddit { communities }, AdQuick { start_date, end_date }.
   * Each adapter documents the keys it reads and ignores the rest. (Added 2026-11 —
   * optional, so existing adapters are unaffected.)
   */
  extra?: Record<string, unknown>;
}

export interface CreatedCampaign {
  /** Always PAUSED — adapters must never create anything live. */
  status: "PAUSED";
  campaignId: string;
  adGroupId: string;
  adId: string;
  budgetId: string;
  validateOnly: boolean;
  objects: OutletObject[];
  raw?: unknown;
}

// ── getInsights ──────────────────────────────────────────────────────────────

export interface InsightsQuery {
  /** Restrict to these outlet campaign ids; omit for all supported campaigns. */
  campaignIds?: string[];
  /** Preset ("LAST_30_DAYS", "ALL_TIME", …) or explicit YYYY-MM-DD range. */
  datePreset?: string;
  from?: string;
  to?: string;
}

export interface InsightRow {
  campaignId: string;
  campaignName: string;
  channelType: string;
  status: string;
  currency: string | null;
  /** Major currency units (e.g. dollars), not cents/micros. */
  spend: number;
  impressions: number;
  clicks: number;
  /** null when the outlet doesn't report it for this campaign type. */
  videoViews: number | null;
}

export interface InsightsResult {
  rows: InsightRow[];
  notes: string[];
}

// ── pauseCampaign ────────────────────────────────────────────────────────────

export interface PauseResult {
  campaignId: string;
  status: "PAUSED";
  raw?: unknown;
}

// ── The adapter ──────────────────────────────────────────────────────────────

export interface OutletAdapter {
  readonly name: OutletName;
  ping(): Promise<PingResult>;
  uploadAsset(input: UploadAssetInput): Promise<UploadedAsset>;
  createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign>;
  getInsights(query?: InsightsQuery): Promise<InsightsResult>;
  pauseCampaign(campaignId: string): Promise<PauseResult>;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Bad caller input → HTTP 400. */
export class ParamError extends Error {}

/** Missing/invalid server configuration (secrets) → HTTP 500. */
export class ConfigError extends Error {}

/**
 * Failure talking to the outlet → HTTP 502. `detail` carries the formatted
 * upstream error (message + codes + request id), like formatMetaError does for Meta.
 * `created` lists objects that exist outlet-side despite the failure, so the
 * caller can still log them.
 */
export class OutletError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
    public readonly created: OutletObject[] = [],
  ) {
    super(message);
  }
}
