import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fetch the current user's profile row using their auth UID.
 *
 * IMPORTANT: profiles.id (UUID) != auth.users.id (UUID).
 * The profiles table links to auth via the `user_id` column.
 * All other tables (bookings, campaigns, payments, etc.) reference
 * profiles.id as their foreign key — never auth.users.id directly.
 *
 * Usage:
 *   const profile = await getCurrentProfile(supabase, session.user.id)
 *   if (!profile) return redirect("/login")
 *   // Now use profile.id for bookings, campaigns, etc.
 */
export async function getCurrentProfile(
  supabase: SupabaseClient,
  userId: string
) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  return profile as Record<string, unknown> | null;
}
