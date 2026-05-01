import { redirect } from "react-router";
import type { Route } from "./+types/api.grow.checkout";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  let body: {
    budget?: number;
    campaignId?: string | null;
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

  const budget = Number(body.budget);
  const planId = profile.plan_id as number | null;
  const isBeta = planId === null;
  const minBudget = isBeta ? 100 : 500;

  if (!budget || budget < minBudget) {
    return Response.json({ error: `Minimum budget is $${minBudget.toLocaleString()}` }, { status: 400, headers });
  }

  const fee = Math.round(budget * 0.2 * 100) / 100;
  const total = budget + fee;
  const promoteType = body.promote_type ?? "profile";
  const existingCampaignId = body.campaignId ?? null;

  let campaignId: string;

  if (existingCampaignId) {
    campaignId = existingCampaignId;
  } else {
    const { data: inserted, error: insertError } = await supabase.from("boost_campaigns").insert({
      profile_id: profile.id as string,
      promote_type: promoteType,
      promote_link_id: promoteType === "link" && body.promote_link_id ? body.promote_link_id : null,
      target_audience: body.target_audience ?? null,
      budget_amount: budget,
      budget_currency: "USD",
      status: "pending",
      notes: body.notes ?? "grow campaign — awaiting payment",
    }).select("id").single();

    if (insertError || !inserted) {
      return Response.json({ error: "Failed to create campaign" }, { status: 500, headers });
    }
    campaignId = inserted.id as string;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(total * 100),
          product_data: {
            name: "SQRZ Grow Campaign",
            description: `Campaign budget $${budget} + 20% management fee`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: "https://dashboard.sqrz.com/boost?grow=success",
    cancel_url: "https://dashboard.sqrz.com/boost",
    client_reference_id: campaignId,
    customer_email: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      campaign_id: campaignId,
      budget: String(budget),
      fee: String(fee),
      total: String(total),
      type: "grow_campaign",
    },
  });

  return Response.json({ checkout_url: session.url }, { headers });
}
