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

  let body: { budget?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const budget = Number(body.budget);
  if (!budget || budget < 1000) {
    return Response.json({ error: "Minimum budget is $1,000" }, { status: 400, headers });
  }

  const fee = budget * 0.2;
  const total = budget + fee;

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
    customer_email: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      budget: String(budget),
      fee: String(fee),
      total: String(total),
      type: "grow_campaign",
    },
  });

  await supabase.from("boost_campaigns").insert({
    profile_id: profile.id as string,
    promote_type: "grow",
    budget_amount: budget,
    budget_currency: "USD",
    status: "pending",
    notes: "grow campaign — awaiting payment",
  });

  return Response.json({ checkout_url: session.url }, { headers });
}
