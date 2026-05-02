import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.checkout";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  let body: {
    campaign_type?: "boost" | "grow";
    budget_amount?: number;
    campaign_id?: string | null;
    is_reactivation?: boolean;
    // Grow-only fields for new campaign creation
    promote_type?: string | null;
    promote_link_id?: string | null;
    target_audience?: string | null;
    notes?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const { campaign_type, is_reactivation = false } = body;
  const budget = Number(body.budget_amount);

  if (!campaign_type || !["boost", "grow"].includes(campaign_type)) {
    return Response.json({ error: "Invalid campaign_type" }, { status: 400, headers });
  }
  if (!budget || budget <= 0) {
    return Response.json({ error: "Invalid budget_amount" }, { status: 400, headers });
  }

  // ── Resolve campaign ID ────────────────────────────────────────────────────
  let campaignId: string;

  if (body.campaign_id) {
    campaignId = body.campaign_id;
  } else if (campaign_type === "grow") {
    // Grow: create campaign row now (no prior action step)
    const planId = profile.plan_id as number | null;
    const minBudget = planId === null || planId === 4 ? 100 : 500;
    if (budget < minBudget) {
      return Response.json(
        { error: `Minimum Grow budget is $${minBudget.toLocaleString()}` },
        { status: 400, headers }
      );
    }
    const promoteType = body.promote_type ?? "profile";
    const { data: inserted, error: insertError } = await supabase
      .from("boost_campaigns")
      .insert({
        profile_id: profile.id as string,
        promote_type: promoteType,
        promote_link_id: promoteType === "link" && body.promote_link_id ? body.promote_link_id : null,
        target_audience: body.target_audience ?? null,
        budget_amount: budget,
        budget_currency: "USD",
        status: "pending",
        campaign_type: "grow",
        notes: body.notes ?? "grow campaign — awaiting payment",
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      return Response.json({ error: "Failed to create campaign" }, { status: 500, headers });
    }
    campaignId = inserted.id as string;
  } else {
    return Response.json({ error: "campaign_id required for boost campaigns" }, { status: 400, headers });
  }

  // ── Calculate fee and total ────────────────────────────────────────────────
  const fee = campaign_type === "boost"
    ? (is_reactivation ? 5 : 25)
    : Math.round(budget * 0.20 * 100) / 100;
  const total = budget + fee;

  const productName = campaign_type === "boost"
    ? `SQRZ Boost Campaign — $${budget} ad budget`
    : `SQRZ Grow Campaign — $${budget} ad budget`;

  const description = campaign_type === "boost"
    ? `Includes $${is_reactivation ? 5 : 25} ${is_reactivation ? "reactivation" : "activation"} fee`
    : `Includes 20% management fee ($${Math.round(budget * 0.20)})`;

  // ── Stripe checkout session ────────────────────────────────────────────────
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(total * 100),
          product_data: { name: productName, description },
        },
        quantity: 1,
      },
    ],
    success_url: `${APP_URL}/boost?campaign_paid=true`,
    cancel_url: `${APP_URL}/boost`,
    client_reference_id: campaignId,
    customer_email: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      campaign_id: campaignId,
      campaign_type,
      budget_amount: String(budget),
      fee: String(fee),
      total: String(total),
    },
  });

  return Response.json({ checkout_url: session.url }, { headers });
}
