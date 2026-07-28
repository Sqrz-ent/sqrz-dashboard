import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReferralStatus = "active" | "expired" | "pending";

export type Referral = {
  slug: string;
  earned: number;
  status: ReferralStatus;
  hasStripeConnect: boolean;
};

export type BookingRow = {
  referred_slug: string;
  commission_amount: number;
  stripe_mode: "live" | "test";
};

// Data consumed by <PartnerSection> — returned by the Partners route loader and
// the Grow page loader (PARTNER section, is_partner only). One query set, no drift.
export type PartnerSectionData = {
  refCode: string | null;
  commissionPct: number;
  tier: "Partner" | "Elite";
  referrals: Referral[];
  stats: { all: number; active: number; expired: number; pending: number };
  earnings: {
    lifetime: number;
    pending: number;
    paid: number;
    pendingSubTotal: number;
    pendingBookingTotal: number;
  };
  activeCount: number;
  nextTierCount: number | null;
  commissionWindowMonths: number;
  bookingTotal: number;
  bookingCount: number;
  bookingRows: BookingRow[];
};

function tierFromPct(pct: number): "Partner" | "Elite" {
  return pct >= 75 ? "Elite" : "Partner";
}

/**
 * Loads the full partner dashboard dataset for a profile: referral code, referral
 * uses merged with referred profiles, subscription + booking commission earnings,
 * and derived tier/stats. Shared by `_app.partners` and `_app.analytics` (Grow
 * page's PARTNER section) so the two never diverge. Caller gates on is_partner.
 */
export async function loadPartnerSectionData(
  supabase: SupabaseClient,
  profile: Record<string, unknown>
): Promise<PartnerSectionData> {
  // 1. Referral code
  const { data: refCodeRow } = await supabase
    .from("referral_codes")
    .select("id, code, commission_pct")
    .eq("owner_id", profile.id as string)
    .eq("is_active", true)
    .maybeSingle();

  const commissionPct: number = (refCodeRow?.commission_pct as number | null) ?? 30;
  const refCode: string | null = (refCodeRow?.code as string | null) ?? null;

  // 2. Referral uses (separate query, no join)
  const { data: rawUses } = refCodeRow
    ? await supabase
        .from("referral_uses")
        .select("id, referred_profile_id, converted, first_paid_at, commission_ends_at")
        .eq("referral_code_id", refCodeRow.id as string)
        .order("created_at", { ascending: false })
    : { data: [] };

  // 3. Referred profiles (separate query, merge in JS)
  const referredIds = (rawUses ?? []).map((r) => r.referred_profile_id as string);
  const { data: referredProfiles } = await supabase
    .from("profiles")
    .select("id, slug, stripe_connect_id, stripe_connect_status")
    .in("id", referredIds.length ? referredIds : ["00000000-0000-0000-0000-000000000000"]);

  // 4. Earnings
  const { data: rawEarnings } = await supabase
    .from("partner_earnings")
    .select("commission_amount, payout_status, referred_profile_id")
    .eq("partner_id", profile.id as string);

  // Build per-referred-profile earned map
  const earnedByProfile: Record<string, number> = {};
  const paidTotal = { pending: 0, paid: 0 };
  for (const e of rawEarnings ?? []) {
    const amt = Number(e.commission_amount ?? 0);
    const pid = e.referred_profile_id as string;
    earnedByProfile[pid] = (earnedByProfile[pid] ?? 0) + amt;
    if (e.payout_status === "paid") paidTotal.paid += amt;
    else paidTotal.pending += amt;
  }
  const lifetimeEarned = Object.values(earnedByProfile).reduce((s, v) => s + v, 0);
  const pendingSubTotal = paidTotal.pending;

  // Build referral rows (merge uses + profiles in JS)
  const referrals: Referral[] = (rawUses ?? []).map((u) => {
    const prof = (referredProfiles ?? []).find((p) => p.id === u.referred_profile_id);
    const slug = (prof?.slug as string | null) ?? "unknown";
    const earned = earnedByProfile[(u.referred_profile_id as string)] ?? 0;
    const commissionEndsAt = u.commission_ends_at as string | null;
    const converted = !!(u.converted);

    // active: converted, commission window still open
    // expired: converted, commission window closed (or null)
    // pending: never converted
    const status: ReferralStatus = !converted
      ? "pending"
      : commissionEndsAt && new Date(commissionEndsAt) > new Date()
        ? "active"
        : "expired";

    const hasStripeConnect = !!(prof?.stripe_connect_id && prof?.stripe_connect_status === "active");
    return { slug, earned, status, hasStripeConnect };
  });

  // Stats
  const stats = {
    all: referrals.length,
    active: referrals.filter((r) => r.status === "active").length,
    expired: referrals.filter((r) => r.status === "expired").length,
    pending: referrals.filter((r) => r.status === "pending").length,
  };

  const activeCount = stats.active;
  const tier = tierFromPct(commissionPct);
  const nextTierCount = tier === "Elite" ? null : 25;
  const commissionWindowMonths = tier === "Elite" ? 24 : 12;

  // 5. Booking referral earnings
  const { data: rawBookingEarnings } = await supabase
    .from("booking_referral_earnings")
    .select("commission_amount, payout_status, referred_id, stripe_mode")
    .eq("referrer_id", profile.id as string);

  const bookingTotal = (rawBookingEarnings ?? []).reduce(
    (s, r) => s + Number(r.commission_amount ?? 0),
    0
  );
  const bookingCount = (rawBookingEarnings ?? []).length;
  const pendingBookingTotal = (rawBookingEarnings ?? [])
    .filter((r) => r.payout_status === "pending")
    .reduce((s, r) => s + Number(r.commission_amount ?? 0), 0);

  // Fetch referred profile slugs for booking rows
  const bookingReferredIds = [...new Set(
    (rawBookingEarnings ?? []).map((r) => r.referred_id as string).filter(Boolean)
  )];
  const { data: bookingProfiles } = bookingReferredIds.length
    ? await supabase
        .from("profiles")
        .select("id, slug")
        .in("id", bookingReferredIds)
    : { data: [] };

  const bookingSlugMap: Record<string, string> = {};
  for (const p of bookingProfiles ?? []) {
    bookingSlugMap[p.id as string] = (p.slug as string) ?? "unknown";
  }

  const bookingRows: BookingRow[] = (rawBookingEarnings ?? []).map((r) => ({
    referred_slug: bookingSlugMap[r.referred_id as string] ?? "unknown",
    commission_amount: Number(r.commission_amount ?? 0),
    stripe_mode: ((r.stripe_mode as string | null) === "test" ? "test" : "live"),
  }));

  return {
    refCode,
    commissionPct,
    tier,
    referrals,
    stats,
    earnings: {
      lifetime: lifetimeEarned,
      pending: pendingSubTotal + pendingBookingTotal,
      paid: paidTotal.paid,
      pendingSubTotal,
      pendingBookingTotal,
    },
    activeCount,
    nextTierCount,
    commissionWindowMonths,
    bookingTotal,
    bookingCount,
    bookingRows,
  };
}
