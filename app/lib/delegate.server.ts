import type { SupabaseClient } from "@supabase/supabase-js";

// Billing/payment features (invoices, payment links) are available to the booking owner
// or to an active agent delegate acting on the owner's behalf. A delegate is an accepted
// (status='active') row in profile_delegates linking the owner (delegator) to the
// delegate. We do not branch on permission_scope yet — any active delegate may manage
// billing for their delegator's bookings.
export async function canManageBookingBilling(
  admin: SupabaseClient,
  viewerProfileId: string,
  ownerProfileId: string
): Promise<boolean> {
  if (!viewerProfileId || !ownerProfileId) return false;
  if (viewerProfileId === ownerProfileId) return true;

  const { data } = await admin
    .from("profile_delegates")
    .select("id")
    .eq("delegator_profile_id", ownerProfileId)
    .eq("delegate_profile_id", viewerProfileId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  return !!data;
}
