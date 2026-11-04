import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import {
  ensureCustomerStreamIdentity,
  ensureSupportThread,
  type ManagedRequestRow,
} from "~/lib/messaging/support.server";

// Support chat (V1, Sandbox) — see app/lib/messaging/support.server.ts for the
// full picture. Input is still one of the caller's own contact-template
// requests (campaign_id, boost_campaigns.is_managed = true) — that's the
// request being submitted or (re)opened — but the channel ensureSupportThread
// creates/returns is now the caller's PROFILE's single shared support
// channel (one per profile, not one per request): this request's own
// summary is posted into it if it hasn't been already, same response shape
// as before. Same dual-auth pattern (Bearer for native, cookie for web) as
// api.messaging.stream-inquiry.ts.
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

    let campaignId: string;
    try {
      const body = await request.json();
      campaignId = String(body?.campaign_id ?? "");
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400, headers });
    }
    if (!campaignId) {
      return Response.json({ error: "campaign_id required" }, { status: 400, headers });
    }

    // Resolve the request row + verify ownership with the service role —
    // profiles currently has a known wide-open RLS policy (see root
    // CLAUDE.md's Known Open Issues), so ownership is checked here in
    // application code rather than left to RLS, same convention as
    // getCurrentProfile / resolveOwnedProfileId.
    const admin = createSupabaseAdminClient();
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

    // Upsert the customer's Stream user BEFORE ensureSupportThread creates
    // the channel — channel.create() sets created_by_id/members to this id,
    // and Stream rejects a channel whose creator/members reference a user
    // that doesn't exist yet.
    const { streamUserId, token } = await ensureCustomerStreamIdentity(campaign.profile_id as string);
    const { channelId } = await ensureSupportThread(campaign as ManagedRequestRow);
    return Response.json({ channelId, streamUserId, token }, { headers });
  } catch (error) {
    console.error(`[support-thread] (${authPath}) action failed:`, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to create support thread" },
      { status: 500, headers }
    );
  }
}
