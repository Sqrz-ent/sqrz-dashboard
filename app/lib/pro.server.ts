import { redirect } from "react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

// SQRZ Pro gate for the web dashboard (2026-11).
//
// "Pro" is exactly what the iOS app treats as Pro (sqrz-ios EntitlementManager):
// the RevenueCat entitlement `grow_access` — or the additive higher tier
// `multichannel_access` — being ACTIVE. RevenueCat is the single source of truth
// for all the ways of holding it: an App Store subscription/purchase, an
// invite-code promotional grant (redeem-invite-code) and a template's Pro period
// (_shared/pro-grant.ts, campaign_templates.pro_days). Nothing in the database
// mirrors it (ios_subscriptions is the separate Companion subscription), so this
// asks RevenueCat's REST API directly with the SAME secret key the edge functions
// already use — REVENUECAT_SECRET_API_KEY, which must ALSO be set in this app's
// (Vercel) environment. No new sync is introduced.
//
// Kill switch: the iOS app only gates when `app_config.purchase_gate_enabled` is
// true (world-readable). The web follows the same flag, so Pro gating can be
// switched off for iOS and web together, without a deploy.
//
// The result is cached in memory per user for a short time so page loads don't
// each hit RevenueCat. Callers must enforce it SERVER-side (loaders and actions);
// the UI never decides access.

const GROW_ACCESS = "grow_access";
const MULTICHANNEL_ACCESS = "multichannel_access";
const RC_API = "https://api.revenuecat.com/v1";

export const PRO_REQUIRED_PATH = "/pro-required";

export type ProStatus =
  | { state: "pro" }
  | { state: "free" }
  // Couldn't determine (RevenueCat unreachable / key missing). Treated as NOT Pro
  // (fail closed) but shown differently so a paying user isn't told they're free.
  | { state: "error"; reason: string };

const POSITIVE_TTL_MS = 5 * 60 * 1000; // a Pro user stays cached for 5 min
const NEGATIVE_TTL_MS = 30 * 1000;      // free: re-check soon (they may just have upgraded in the app)
const ERROR_TTL_MS = 10 * 1000;         // don't hammer RevenueCat while it's failing
const FORCE_MIN_INTERVAL_MS = 10 * 1000; // "Check again" can't bypass the cache more than once per 10 s

type CacheEntry = { status: ProStatus; expiresAt: number; fetchedAt: number };
const cache = new Map<string, CacheEntry>();
let gateFlag: { value: boolean; expiresAt: number } | null = null;

type RcEntitlement = { expires_date?: string | null; grace_period_expires_date?: string | null };

// RevenueCat v1 lists expired entitlements too, so "active" must be computed:
// no expiry (lifetime) or an expiry in the future, or still in a billing grace period.
function isEntitlementActive(ent: RcEntitlement | undefined, now: number): boolean {
  if (!ent) return false;
  if (ent.expires_date == null) return true;
  if (Date.parse(ent.expires_date) > now) return true;
  if (ent.grace_period_expires_date && Date.parse(ent.grace_period_expires_date) > now) return true;
  return false;
}

async function isGateEnabled(supabase: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (gateFlag && gateFlag.expiresAt > now) return gateFlag.value;
  const { data, error } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "purchase_gate_enabled")
    .maybeSingle();
  // On a failed read, keep the last known value, else gate ON (fail closed).
  if (error || !data) return gateFlag?.value ?? true;
  gateFlag = { value: data.value === true, expiresAt: now + 60 * 1000 };
  return gateFlag.value;
}

async function fetchFromRevenueCat(userId: string): Promise<ProStatus> {
  const key = process.env.REVENUECAT_SECRET_API_KEY;
  if (!key) {
    console.error("[pro] REVENUECAT_SECRET_API_KEY is not set in this environment — cannot verify Pro");
    return { state: "error", reason: "not_configured" };
  }
  try {
    // RevenueCat app user id = the Supabase auth user id, LOWERCASE (what
    // sqrz-ios passes to Purchases.logIn).
    const res = await fetch(`${RC_API}/subscribers/${encodeURIComponent(userId.toLowerCase())}`, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.error("[pro] RevenueCat subscriber fetch failed:", res.status);
      return { state: "error", reason: `revenuecat_${res.status}` };
    }
    const body = await res.json();
    const ents = (body?.subscriber?.entitlements ?? {}) as Record<string, RcEntitlement>;
    const now = Date.now();
    const pro = isEntitlementActive(ents[GROW_ACCESS], now) || isEntitlementActive(ents[MULTICHANNEL_ACCESS], now);
    return pro ? { state: "pro" } : { state: "free" };
  } catch (err) {
    console.error("[pro] RevenueCat request failed:", err instanceof Error ? err.message : err);
    return { state: "error", reason: "network" };
  }
}

export async function getProStatus(
  supabase: SupabaseClient,
  userId: string,
  opts: { force?: boolean } = {}
): Promise<ProStatus> {
  if (!(await isGateEnabled(supabase))) return { state: "pro" }; // gate switched off (same flag as iOS)

  const now = Date.now();
  const hit = cache.get(userId);
  if (hit) {
    const fresh = hit.expiresAt > now;
    const forceAllowed = opts.force && now - hit.fetchedAt >= FORCE_MIN_INTERVAL_MS;
    if (fresh && !forceAllowed) return hit.status;
  }

  const status = await fetchFromRevenueCat(userId);
  const ttl = status.state === "pro" ? POSITIVE_TTL_MS : status.state === "free" ? NEGATIVE_TTL_MS : ERROR_TTL_MS;
  cache.set(userId, { status, expiresAt: now + ttl, fetchedAt: now });
  if (cache.size > 5000) cache.clear(); // crude bound; entries are tiny and short-lived
  return status;
}

/**
 * For dashboard loaders/actions: throws a redirect to the Pro-required page unless
 * the signed-in user holds Pro. Call it right after the auth check.
 */
export async function requirePro(
  supabase: SupabaseClient,
  userId: string,
  headers?: Headers
): Promise<void> {
  const status = await getProStatus(supabase, userId);
  if (status.state !== "pro") throw redirect(PRO_REQUIRED_PATH, { headers });
}

/**
 * For cookie-authenticated API routes (web callers only — native Bearer callers
 * are the iOS app, which has its own entitlement handling): a 403 JSON response
 * when the user lacks Pro, else null.
 */
export async function proDeniedResponse(
  supabase: SupabaseClient,
  userId: string,
  headers?: Headers
): Promise<Response | null> {
  const status = await getProStatus(supabase, userId);
  if (status.state === "pro") return null;
  return Response.json({ error: "SQRZ Pro required" }, { status: 403, headers });
}
