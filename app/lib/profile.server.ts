import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fetch the current user's profile row using their auth UID.
 *
 * IMPORTANT: profiles.id (UUID) != auth.users.id (UUID).
 * The profiles table links to auth via the `user_id` column.
 * All other tables (bookings, campaigns, payments, etc.) reference
 * profiles.id as their foreign key — never auth.users.id directly.
 *
 * Multi-profile ownership (2026-10-18) — one login can now own more than
 * one `profiles` row, so this can no longer assume `.eq("user_id", userId)`
 * ever resolves to exactly one (the old `.single()` here would throw the
 * moment a login owned more than one, surfacing as a silent "Profile not
 * found" to every caller that just checks `if (!profile)`). `requestedProfileId`
 * is resolved by id and verified against `userId` — never trusted as-is,
 * since `profiles` currently has a known wide-open RLS policy (see root
 * CLAUDE.md's Known Open Issues). No `requestedProfileId` (an older app
 * build, or any caller not yet passing one) falls back to the user's oldest
 * profile — the same `order(created_at asc).limit(1)` fallback
 * `resolveOwnedProfileId` (app/lib/messaging/inquiry.server.ts) and
 * `get-or-create-invite-code` already use for this exact situation. Never
 * `.single()` on `user_id` — only ever `.maybeSingle()`, so an unexpected
 * zero/multiple-row shape returns null instead of throwing.
 *
 * Usage:
 *   const profile = await getCurrentProfile(supabase, session.user.id, requestedProfileId)
 *   if (!profile) return redirect("/login")
 *   // Now use profile.id for bookings, campaigns, etc.
 */
export async function getCurrentProfile(
  supabase: SupabaseClient,
  userId: string,
  requestedProfileId?: string | null
) {
  if (requestedProfileId) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", requestedProfileId)
      .maybeSingle();
    if (!profile || profile.user_id !== userId) return null;
    return profile as Record<string, unknown>;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return profile as Record<string, unknown> | null;
}

// ─── Active profile (web) ────────────────────────────────────────────────────
//
// Web counterpart of sqrz-ios's ActiveProfileStore (2026-11): one login can own
// several profiles; the one the dashboard shows is remembered in a cookie (iOS
// persists the same choice in UserDefaults, per auth user). The cookie is only
// a *preference*: every read goes through getCurrentProfile, which verifies the
// profile belongs to the signed-in user, and a missing/stale/foreign id silently
// falls back to the user's oldest profile — the same fallback iOS uses.

export const ACTIVE_PROFILE_COOKIE = "sqrz_active_profile_id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readActiveProfileCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== ACTIVE_PROFILE_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null; // malformed cookie — treat as unset
    }
    return UUID_RE.test(value) ? value : null;
  }
  return null;
}

export function serializeActiveProfileCookie(profileId: string): string {
  return [
    `${ACTIVE_PROFILE_COOKIE}=${encodeURIComponent(profileId)}`,
    "Path=/",
    `Max-Age=${60 * 60 * 24 * 365}`,
    "SameSite=Lax",
    "Secure",
    "HttpOnly",
  ].join("; ");
}

/**
 * The profile every dashboard page should load: an explicit id (native callers
 * pass `?profile_id=`, strictly verified — an invalid one returns null, as
 * before), else the cookie-selected profile, else the user's oldest profile.
 */
export async function getActiveProfile(
  request: Request,
  supabase: SupabaseClient,
  userId: string,
  explicitProfileId?: string | null
) {
  if (explicitProfileId) return getCurrentProfile(supabase, userId, explicitProfileId);

  const cookieId = readActiveProfileCookie(request);
  if (cookieId) {
    const selected = await getCurrentProfile(supabase, userId, cookieId);
    if (selected) return selected;
  }
  return getCurrentProfile(supabase, userId);
}

/** Every profile the user owns, oldest first (iOS ActiveProfileStore.load order). */
export async function listOwnedProfiles(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, slug, name, brand_name, avatar_url, account_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data ?? []) as Array<{
    id: string;
    slug: string;
    name: string | null;
    brand_name: string | null;
    avatar_url: string | null;
    account_id: string | null;
    created_at: string;
  }>;
}

/**
 * Account-level wallet balance in cents — same source as iOS WalletViewModel.load():
 * profiles.account_id → account_wallets.balance_cents. No row = $0 (the row is
 * created lazily by the first ledger entry's trigger).
 */
export async function getAccountBalanceCents(
  supabase: SupabaseClient,
  accountId: string | null | undefined
): Promise<number> {
  if (!accountId) return 0;
  const { data } = await supabase
    .from("account_wallets")
    .select("balance_cents")
    .eq("account_id", accountId)
    .maybeSingle();
  return Number(data?.balance_cents ?? 0);
}
