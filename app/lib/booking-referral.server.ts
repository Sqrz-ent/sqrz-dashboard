import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Write a booking_referral_earnings row when a booking completes and payment
 * is confirmed. Reads booking_ref_code from the booking row (stored + validated
 * at booking creation). Fails silently — never blocks a booking action.
 */
export async function handleBookingReferral({
  supabase,
  bookingId,
  bookingValue,
  stripeMode = "live",
}: {
  supabase: SupabaseClient;
  bookingId: string;
  bookingValue: number;
  stripeMode?: "live" | "test";
}) {
  // 1. Idempotency — skip if already processed
  const { data: existing } = await supabase
    .from("booking_referral_earnings")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("stripe_mode", stripeMode)
    .maybeSingle();
  if (existing) return;

  // 2. Fetch booking: ref code, expiry window, and seller id
  const { data: booking } = await supabase
    .from("bookings")
    .select("owner_id, booking_ref_code, booking_ref_expires_at")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking?.booking_ref_code) return;

  // 3. Check expiry window still valid
  if (!booking.booking_ref_expires_at) return;
  if (new Date(booking.booking_ref_expires_at as string) < new Date()) return;

  // 4. Look up active partner ref code
  const { data: refCode } = await supabase
    .from("referral_codes")
    .select("owner_id")
    .eq("code", booking.booking_ref_code as string)
    .eq("is_partner", true)
    .eq("is_active", true)
    .maybeSingle();
  if (!refCode?.owner_id) return;

  // 5. Block self-referral
  if (refCode.owner_id === booking.owner_id) return;

  // 6. Both sides must have matching Connect active for the selected Stripe mode
  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, stripe_connect_status, stripe_connect_status_test")
    .in("id", [refCode.owner_id as string, booking.owner_id as string]);

  const profileMap = Object.fromEntries(
    (profileRows ?? []).map((row) => [row.id as string, row])
  );
  const referrerProfile = profileMap[refCode.owner_id as string];
  const referredProfile = profileMap[booking.owner_id as string];
  const statusKey =
    stripeMode === "test" ? "stripe_connect_status_test" : "stripe_connect_status";

  if (!referrerProfile || !referredProfile) return;
  if (referrerProfile[statusKey] !== "active" || referredProfile[statusKey] !== "active") {
    return;
  }

  // 7. Calculate commission (2.5% of commissionable booking net)
  const commissionPct = 2.5;
  const commissionAmount = Math.round(bookingValue * commissionPct) / 100;

  // 8. Insert pending earnings row
  await supabase.from("booking_referral_earnings").insert({
    booking_id: bookingId,
    referrer_id: refCode.owner_id,
    referred_id: booking.owner_id,
    booking_value: bookingValue,
    commission_pct: commissionPct,
    commission_amount: commissionAmount,
    stripe_mode: stripeMode,
    payout_status: "pending",
  });
}
