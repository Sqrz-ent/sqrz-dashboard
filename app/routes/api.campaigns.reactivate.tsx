import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.reactivate";
import { createSupabaseServerClient, createSupabaseBearerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Reactivation for an EXHAUSTED campaign (spent caught up to allocated).
// Previously a flat $10 Stripe checkout, modeled on the $25 setup fee — removed
// 2026-08-08, same reasoning as the setup fee: it was justified by manual
// reactivation labor that no longer exists (this is just a status transition).
// No replacement charge. The endpoint stays (unlike api/campaigns/checkout.tsx,
// which was deleted outright) because campaign_budgets has no owner-write RLS
// policy — only campaign_budgets_owner_select (read-only) — so the
// exhausted→active flip needs the service-role client; this route is what
// gives the client a safe, ownership-checked way to trigger it. Dual-auth
// (cookie web + Bearer native).
export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
    if (!user) return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  let body: { campaign_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }
  if (!body.campaign_id) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }
  const campaignId = body.campaign_id;

  // Ownership check — the campaign must belong to the signed-in profile. (The RLS
  // client can only see the caller's own rows, so a null here = not theirs.)
  const { data: campaign } = await supabase
    .from("boost_campaigns")
    .select("id, profile_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.profile_id !== profile.id) {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }

  // Reset — same two writes the old Stripe webhook's reactivation branch did,
  // now performed directly instead of gated behind payment success. Admin
  // client: campaign_budgets has no owner-write RLS policy.
  const admin = createSupabaseAdminClient();

  const { error: campaignError } = await admin
    .from("boost_campaigns")
    .update({
      status: "pending",
      status_updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (campaignError) {
    return Response.json({ error: campaignError.message }, { status: 500, headers });
  }

  // Guarded no-op when the budget wasn't 'exhausted' (e.g. reactivating a
  // completed-and-archived campaign that was never exhausted in the first
  // place) — matches the old webhook's behavior exactly.
  const { error: budgetError } = await admin
    .from("campaign_budgets")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("campaign_id", campaignId)
    .eq("status", "exhausted");
  if (budgetError) {
    return Response.json({ error: budgetError.message }, { status: 500, headers });
  }

  return Response.json({ ok: true }, { headers });
}
