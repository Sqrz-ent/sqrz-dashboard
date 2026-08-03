import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.checkout";
import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createCampaignCheckoutSession } from "~/lib/campaignPayments.server";
import type { StripeMode } from "~/lib/stripe.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

export async function action({ request }: Route.ActionArgs) {
  // Native callers (sqrz-ios) authenticate with a Bearer access token and expect JSON;
  // the browser flow authenticates via cookies. Body is JSON in both cases.
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

  let body: {
    campaign_id?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  // Start Campaign has exactly one flow now: an existing campaign row (created by
  // the client first) is paid for here. campaign_id is always required.
  if (!body.campaign_id) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }
  const campaignId = body.campaign_id;

  // ── Setup fee ──────────────────────────────────────────────────────────────
  // Allocation-fee model (2026-08-01): campaign creation charges the flat $25
  // SETUP FEE ONLY — no bundled budget pill anymore. The campaign starts with a
  // zero-budget, status='active' campaign_budgets row (created on the webhook);
  // the artist funds it afterward via wallet → allocation (which is where the
  // percentage commission now lives). No processing-fee line on this small flat
  // charge — SQRZ absorbs Stripe's cut here (see walletPayments.server.ts).
  const SETUP_FEE = 25;

  // Per-profile beta opt-in, same for web and native — see api/wallet/topup.tsx
  // for the full 2026-08-04 fix rationale (previously hardcoded on isNative).
  const stripeMode: StripeMode = profile.stripe_beta_test_mode ? "test" : "live";

  // iOS: return straight into the app via the existing sqrz:// custom URL
  // scheme (already registered in Info.plist for Stripe Connect's
  // sqrz://stripe-return) instead of a web confirmation page — SafariSheet on
  // the client already auto-dismisses on ANY sqrz:// redirect, so this alone
  // fixes "checkout completes but leaves you stuck in Safari." AppDelegate.swift
  // / sqrzApp.swift route `checkout-return` to its own notification, distinct
  // from stripe-return. Web is untouched.
  const successUrl = isNative
    ? "sqrz://checkout-return?status=success"
    : `${APP_URL}/boost?campaign_paid=true`;
  const cancelUrl = isNative
    ? "sqrz://checkout-return?status=cancelled"
    : `${APP_URL}/boost`;

  // ── Checkout session (Stripe today; see campaignPayments.server.ts) ────────
  const { checkoutUrl } = await createCampaignCheckoutSession({
    amountCents: Math.round(SETUP_FEE * 100),
    productName: `SQRZ Boost Campaign — $${SETUP_FEE} setup fee`,
    description: `One-time $${SETUP_FEE} setup fee. Fund your campaign afterward from your ad-spend wallet.`,
    successUrl,
    cancelUrl,
    clientReferenceId: campaignId,
    customerEmail: (profile.email as string) ?? undefined,
    stripeMode,
    metadata: {
      // `type` lets the webhook tell setup from reactivation (both carry a
      // campaign_id). Setup → mark booked + create the zero-budget active row.
      type: "campaign_setup",
      profile_id: profile.id as string,
      campaign_id: campaignId,
      fee: String(SETUP_FEE),
      source: isNative ? "ios" : "web",
    },
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
