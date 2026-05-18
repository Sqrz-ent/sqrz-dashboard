import { redirect } from "react-router";
import type { Route } from "./+types/api.stripe.connect";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getStripeClient, resolveStripeMode } from "~/lib/stripe-mode.server";

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const url = new URL(request.url);
  const formData = await request.formData();
  const isBeta = Boolean(profile.is_beta);
  const mode = resolveStripeMode(
    (formData.get("mode") as string | null) ?? url.searchParams.get("mode"),
    isBeta
  );
  const stripeConnect = getStripeClient(mode);
  if (!stripeConnect) {
    return Response.json({ error: `Stripe ${mode} mode is not configured.` }, { status: 500, headers });
  }

  const publicUrl = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";
  const returnTo = url.searchParams.get("returnTo") ?? "payments";
  const returnPath = returnTo === "partners" ? "/partners" : "/payments";
  const returnModeParam = mode === "test" ? "&mode=test" : "";

  const connectIdField = mode === "test" ? "stripe_connect_id_test" : "stripe_connect_id";
  const connectStatusField = mode === "test" ? "stripe_connect_status_test" : "stripe_connect_status";
  let connectId = profile[connectIdField] as string | undefined;

  if (!connectId) {
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
        [connectIdField]: connectId,
        [connectStatusField]: "pending",
        ...(mode === "test" ? { stripe_beta_test_mode: true } : {}),
      })
      .eq("id", profile.id);
  }

  // Create onboarding link
  const accountLink = await stripeConnect.accountLinks.create({
    account: connectId,
    refresh_url: `${publicUrl}${returnPath}?connect=refresh${returnModeParam}`,
    return_url: `${publicUrl}${returnPath}?connect=success${returnModeParam}`,
    type: "account_onboarding",
  });

  return redirect(accountLink.url, { headers });
}
