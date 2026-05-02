import { redirect } from "react-router";
import type { Route } from "./+types/api.boost.checkout";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

// Stripe Price IDs for Boost one-time payments (create in Stripe dashboard, type: one_time):
//   STRIPE_BOOST_ACTIVATION_PRICE_ID    — $25.00 USD  "SQRZ Boost Campaign Activation"
//   STRIPE_BOOST_REACTIVATION_PRICE_ID  — $5.00 USD   "SQRZ Boost Campaign Reactivation"

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  let body: { campaignId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const { campaignId } = body;
  if (!campaignId) {
    return Response.json({ error: "Missing campaignId" }, { status: 400, headers });
  }

  // Determine activation vs reactivation — check for any previously completed campaigns
  const { count: completedCount } = await supabase
    .from("boost_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profile.id as string)
    .eq("status", "completed")
    .neq("id", campaignId);

  const isReactivation = (completedCount ?? 0) > 0;

  const activationPriceId = process.env.STRIPE_BOOST_ACTIVATION_PRICE_ID;
  const reactivationPriceId = process.env.STRIPE_BOOST_REACTIVATION_PRICE_ID;
  const priceId = isReactivation ? reactivationPriceId : activationPriceId;

  if (!priceId) {
    return Response.json({ error: "Boost price not configured" }, { status: 500, headers });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://dashboard.sqrz.com/boost?boost=success",
    cancel_url: "https://dashboard.sqrz.com/boost",
    client_reference_id: campaignId,
    customer_email: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      campaign_id: campaignId,
      type: "boost_campaign",
    },
  });

  return Response.json({ checkout_url: session.url }, { headers });
}
