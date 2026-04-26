import { redirect } from "react-router";
import type { Route } from "./+types/api.stripe.connect";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import Stripe from "stripe";

const stripeConnect = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const publicUrl = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "payments";
  const returnPath = returnTo === "partners" ? "/office/partners" : "/payments";

  let connectId = profile.stripe_connect_id as string | undefined;

  if (!connectId) {
    // Create new Stripe Express account (live mode)
    const account = await stripeConnect.accounts.create({
      type: "express",
      email: (profile.email as string) ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        profile_id: profile.id as string,
        slug: (profile.slug as string) ?? "",
      },
    });

    connectId = account.id;

    // Persist immediately so the webhook can match it
    await supabase
      .from("profiles")
      .update({
        stripe_connect_id: connectId,
        stripe_connect_status: "pending",
      })
      .eq("id", profile.id);
  }

  // Create onboarding link
  const accountLink = await stripeConnect.accountLinks.create({
    account: connectId,
    refresh_url: `${publicUrl}${returnPath}?connect=refresh`,
    return_url: `${publicUrl}${returnPath}?connect=success`,
    type: "account_onboarding",
  });

  return redirect(accountLink.url, { headers });
}
