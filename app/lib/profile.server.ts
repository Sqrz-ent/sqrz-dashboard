import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagedProfile } from "~/lib/agent.server";

/**
 * Fetch the OWNER's profile row using their auth UID (no Agent Mode resolution).
 *
 * IMPORTANT: profiles.id (UUID) != auth.users.id (UUID).
 * The profiles table links to auth via the `user_id` column.
 * All other tables (bookings, campaigns, payments, etc.) reference
 * profiles.id as their foreign key — never auth.users.id directly.
 */
export async function getOwnerProfile(
  supabase: SupabaseClient,
  userId: string
) {
  const { data: profiles } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .order("is_claimed", { ascending: false })
    .order("claimed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1);

  return (profiles?.[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Fetch the EFFECTIVE profile for the current request.
 *
 * By default this returns the logged-in user's own profile. When a `request` is
 * passed and Agent Mode is active (a valid acting-as cookie pointing at a profile
 * the user genuinely manages), it returns the MANAGED talent profile instead — so
 * every route that derives `profile.id` from here automatically operates on the
 * managed talent while a manager is "acting as" them.
 *
 * The acting-as cookie is never trusted: resolveManagedProfile() re-validates the
 * delegation server-side before honoring it.
 *
 * Usage:
 *   const profile = await getCurrentProfile(supabase, user.id, request)
 *   // profile.id is the owner's, OR the managed talent's while acting as them
 */
export async function getCurrentProfile(
  supabase: SupabaseClient,
  userId: string,
  request?: Request
) {
  const owner = await getOwnerProfile(supabase, userId);
  if (!owner || !request) return owner;

  const managed = await resolveManagedProfile(request, owner.id as string);
  return managed ?? owner;
}
