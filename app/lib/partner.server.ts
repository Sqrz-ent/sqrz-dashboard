import type { SupabaseClient } from "@supabase/supabase-js";

export type BetaInviteStatus = "joined" | "pending";

export type BetaInvite = {
  slug: string;
  status: BetaInviteStatus;
  joinedAt: string | null;
};

export type BetaInviteSectionData = {
  refCode: string | null;
  invites: BetaInvite[];
  stats: {
    total: number;
    joined: number;
    pending: number;
  };
};

/**
 * Loads the invite dashboard dataset for a beta inviter. The old commission/
 * payout partner model is gone (see root CLAUDE.md's referral-cleanup notes);
 * referral_codes/referral_uses are now purely the attribution graph for
 * invite-only iOS beta access. `referral_uses.converted` is intentionally
 * still read here — despite the column name, it no longer means "converted to
 * a paid subscription" (that write path is gone with the old commission
 * model); it's the plain joined/pending signal this surface has always shown,
 * kept in lockstep with sqrz-ios's PartnerViewModel.swift, which reads the
 * exact same column for the exact same purpose. `first_paid_at` was dropped
 * (2026-08-08) in favor of `created_at` for the joined-at date — matching
 * iOS's own model, which already dropped `firstPaidAt`/`commissionEndsAt`
 * (see sqrz-ios/CLAUDE.md's "Beta Invites" section) when it was redesigned to
 * drop the commission model on that side.
 */
export async function loadBetaInviteSectionData(
  supabase: SupabaseClient,
  profile: Record<string, unknown>
): Promise<BetaInviteSectionData> {
  const { data: refCodeRow } = await supabase
    .from("referral_codes")
    .select("id, code")
    .eq("owner_id", profile.id as string)
    .eq("is_active", true)
    .maybeSingle();

  const refCode: string | null = (refCodeRow?.code as string | null) ?? null;

  const { data: rawUses } = refCodeRow
    ? await supabase
        .from("referral_uses")
        .select("id, referred_profile_id, converted, created_at")
        .eq("referral_code_id", refCodeRow.id as string)
        .order("created_at", { ascending: false })
    : { data: [] };

  const referredIds = (rawUses ?? [])
    .map((row) => row.referred_profile_id as string | null)
    .filter((id): id is string => Boolean(id));

  const { data: referredProfiles } = referredIds.length
    ? await supabase
        .from("profiles")
        .select("id, slug")
        .in("id", referredIds)
    : { data: [] };

  const slugByProfileId = new Map(
    (referredProfiles ?? []).map((profileRow) => [
      profileRow.id as string,
      (profileRow.slug as string | null) ?? "unknown",
    ])
  );

  const invites: BetaInvite[] = (rawUses ?? []).map((row) => {
    const joined = Boolean(row.converted);
    return {
      slug: slugByProfileId.get(row.referred_profile_id as string) ?? "unknown",
      status: joined ? "joined" : "pending",
      joinedAt: joined ? ((row.created_at as string | null) ?? null) : null,
    };
  });

  return {
    refCode,
    invites,
    stats: {
      total: invites.length,
      joined: invites.filter((invite) => invite.status === "joined").length,
      pending: invites.filter((invite) => invite.status === "pending").length,
    },
  };
}
