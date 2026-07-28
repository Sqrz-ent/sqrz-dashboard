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
 * Loads the invite dashboard dataset for a beta inviter. The old partner model
 * used this surface for paid partner referrals; during the invite-
 * only iOS beta, the same referral-code structure is now used as the access graph.
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
        .select("id, referred_profile_id, converted, first_paid_at, created_at")
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
      joinedAt: joined
        ? ((row.first_paid_at as string | null) ?? (row.created_at as string | null) ?? null)
        : null,
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
