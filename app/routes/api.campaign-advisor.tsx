import type { Route } from "./+types/api.campaign-advisor";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Thin authenticated forwarder to the `campaign-advisor` edge function.
// Verifies the caller owns the campaign, then invokes the function server-side
// (the ANTHROPIC_API_KEY lives only in the edge function). No caching — the
// advisor is computed live on every manual trigger.
export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  const form = await request.formData();
  const campaignId = String(form.get("campaign_id") ?? "");
  if (!campaignId) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();

  // Ownership check — the campaign must belong to the signed-in user's profile.
  const { data: campaign } = await admin
    .from("boost_campaigns")
    .select("id, profile_id")
    .eq("id", campaignId)
    .single();

  if (!campaign || campaign.profile_id !== profile.id) {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }

  const { data, error } = await admin.functions.invoke("campaign-advisor", {
    body: { campaign_id: campaignId },
  });

  if (error || !data) {
    return Response.json({ error: "Advisor unavailable" }, { status: 502, headers });
  }

  return Response.json(data, { headers });
}
