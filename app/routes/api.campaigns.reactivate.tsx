import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.reactivate";
import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createCampaignCheckoutSession } from "~/lib/campaignPayments.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

// Reactivation for an EXHAUSTED campaign (spent caught up to allocated). A flat
// $10 Stripe checkout, modeled exactly on the $25 setup fee — a real payment
// rail, not an internal pending-charge row, so it's a genuinely distinct fee
// event from the allocation commission (the two are never bundled). On payment
// the webhook flips campaign_budgets.status exhausted→active; only then does the
// client allow pill allocation against it again. Dual-auth (cookie web + Bearer
// native); iOS is forced to Stripe test mode and gets a sqrz:// deep-link return.
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

  const REACTIVATION_FEE = 10;
  const stripeMode = isNative ? "test" : "live";

  const successUrl = isNative
    ? "sqrz://checkout-return?status=success"
    : `${APP_URL}/boost?reactivated=true`;
  const cancelUrl = isNative
    ? "sqrz://checkout-return?status=cancelled"
    : `${APP_URL}/boost`;

  const { checkoutUrl } = await createCampaignCheckoutSession({
    amountCents: Math.round(REACTIVATION_FEE * 100),
    productName: `SQRZ Boost Campaign — $${REACTIVATION_FEE} reactivation`,
    description: `One-time $${REACTIVATION_FEE} fee to reactivate this campaign. Fund it afterward from your ad-spend wallet.`,
    successUrl,
    cancelUrl,
    clientReferenceId: campaignId,
    customerEmail: (profile.email as string) ?? undefined,
    stripeMode,
    metadata: {
      // Setup and reactivation both carry a campaign_id — `type` is how the
      // webhook tells them apart. Reactivation → flip exhausted→active.
      type: "reactivation",
      profile_id: profile.id as string,
      campaign_id: campaignId,
      fee: String(REACTIVATION_FEE),
      source: isNative ? "ios" : "web",
    },
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
