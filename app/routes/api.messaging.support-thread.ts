import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import {
  ensureCustomerStreamIdentity,
  ensureSupportThread,
  ensureSupportChannel,
  type ManagedRequestRow,
} from "~/lib/messaging/support.server";

// Support chat (V1, Sandbox) — see app/lib/messaging/support.server.ts for the
// full picture. Two input modes:
//   - { campaign_id }: one of the caller's own contact-template requests
//     (boost_campaigns.is_managed = true) — that request's own summary is
//     posted into the profile's shared support channel if it hasn't been
//     already.
//   - { profile_id }: general support, no request — just ensures/repairs the
//     profile's shared support channel, no summary message. The caller must
//     own that profile (their own user_id, or via a shared account).
// Either way the channel is the caller's PROFILE's single shared support
// channel (one per profile, not one per request). Same dual-auth pattern
// (Bearer for native, cookie for web) as api.messaging.stream-inquiry.ts.
export async function action({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const authPath = bearerToken ? "bearer" : "cookie";

  let headers = new Headers();

  try {
    let supabase;
    let user;

    if (bearerToken) {
      supabase = createSupabaseBearerClient(bearerToken);
      ({
        data: { user },
      } = await supabase.auth.getUser(bearerToken));
    } else {
      ({ supabase, headers } = createSupabaseServerClient(request));
      ({
        data: { user },
      } = await supabase.auth.getUser());
    }

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    }

    let campaignId: string | null = null;
    let profileIdInput: string | null = null;
    try {
      const body = await request.json();
      campaignId = typeof body?.campaign_id === "string" && body.campaign_id ? body.campaign_id : null;
      profileIdInput = typeof body?.profile_id === "string" && body.profile_id ? body.profile_id : null;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400, headers });
    }
    if (!campaignId && !profileIdInput) {
      return Response.json({ error: "campaign_id or profile_id required" }, { status: 400, headers });
    }

    // Ownership is checked here in application code rather than left to
    // RLS, same convention as getCurrentProfile / resolveOwnedProfileId —
    // profiles currently has a known wide-open RLS policy (see root
    // CLAUDE.md's Known Open Issues).
    const admin = createSupabaseAdminClient();
    let resolvedProfileId: string;
    let campaignRow: ManagedRequestRow | null = null;

    if (campaignId) {
      const { data: campaign } = await admin
        .from("boost_campaigns")
        .select(
          "id, profile_id, is_managed, name, notes, budget_amount, budget_currency, target_audience, location_city, location_radius_km, campaign_template",
        )
        .eq("id", campaignId)
        .eq("is_managed", true)
        .maybeSingle();
      if (!campaign) {
        return Response.json({ error: "Request not found" }, { status: 404, headers });
      }

      const { data: ownerProfile } = await admin
        .from("profiles")
        .select("id, user_id")
        .eq("id", campaign.profile_id as string)
        .maybeSingle();
      if (!ownerProfile || ownerProfile.user_id !== user.id) {
        return Response.json({ error: "Request not found" }, { status: 404, headers });
      }

      resolvedProfileId = campaign.profile_id as string;
      campaignRow = campaign as ManagedRequestRow;
    } else {
      // profile_id mode (general support, no request) — the caller must own
      // the profile either directly (their own user_id) or via a shared
      // account (multi-profile ownership, see root CLAUDE.md).
      const { data: profile } = await admin
        .from("profiles")
        .select("id, user_id, account_id")
        .eq("id", profileIdInput as string)
        .maybeSingle();
      if (!profile) {
        return Response.json({ error: "Profile not found" }, { status: 404, headers });
      }

      let owns = profile.user_id === user.id;
      if (!owns && profile.account_id) {
        const { data: account } = await admin
          .from("accounts")
          .select("id")
          .eq("id", profile.account_id as string)
          .eq("user_id", user.id)
          .maybeSingle();
        owns = !!account;
      }
      if (!owns) {
        return Response.json({ error: "Profile not found" }, { status: 404, headers });
      }

      resolvedProfileId = profile.id as string;
    }

    // Upsert the customer's Stream user BEFORE ensureSupportThread/
    // ensureSupportChannel creates the channel — channel.create() sets
    // created_by_id/members to this id, and Stream rejects a channel whose
    // creator/members reference a user that doesn't exist yet.
    const { streamUserId, token } = await ensureCustomerStreamIdentity(resolvedProfileId);
    const { channelId } = campaignRow
      ? await ensureSupportThread(campaignRow)
      : await ensureSupportChannel(resolvedProfileId);
    return Response.json({ channelId, streamUserId, token }, { headers });
  } catch (error) {
    console.error(`[support-thread] (${authPath}) action failed:`, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create support thread" },
      { status: 500, headers }
    );
  }
}
