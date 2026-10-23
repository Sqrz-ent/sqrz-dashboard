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
