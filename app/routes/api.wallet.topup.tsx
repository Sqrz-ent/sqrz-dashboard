import { redirect } from "react-router";
import type { Route } from "./+types/api.wallet.topup";
import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createWalletTopupCheckoutSession } from "~/lib/walletPayments.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

// SQRZ Grow ad-spend wallet top-up. Works identically from web (cookie auth) and
// iOS (Bearer) — same Stripe Checkout flow, same wallet, same webhook. The
// wallet is credited server-side from api/stripe/webhook.tsx on payment success
// (never here) — this route only starts the checkout. `source` is recorded for
// analytics only, never for gating.
//
// Sane bounds guard typos/abuse; the exact amount is client-chosen ("custom
// top-ups"). This is the FEE-CHARGED funding path: record_wallet_topup credits
// the wallet AND creates a flat 15% management_fee_charges row (the campaign-start
// budget path is the fee-exempt one — see api/stripe/webhook.tsx). No gating.
const MIN_TOPUP_CENTS = 500;      // $5
const MAX_TOPUP_CENTS = 50_000;  // $500 (lowered from $50,000 on 2026-08-01)

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

  let body: { amount_cents?: number; source?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const amountCents = Math.round(Number(body.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return Response.json(
      { error: `amount_cents must be between ${MIN_TOPUP_CENTS} and ${MAX_TOPUP_CENTS}` },
      { status: 400, headers },
    );
  }

  // Analytics only. Trust the body if valid, else infer from the auth channel.
  const source: "web" | "ios" =
    body.source === "web" || body.source === "ios"
      ? body.source
      : isNative ? "ios" : "web";

  // iOS is forced onto Stripe test mode for now, regardless of
  // profile.stripe_beta_test_mode — web is untouched, always live. See
  // stripeClientForMode in stripe.server.ts.
  const stripeMode = isNative ? "test" : "live";

  // iOS: return straight into the app via the existing sqrz:// custom URL
  // scheme (already registered in Info.plist for Stripe Connect's
  // sqrz://stripe-return) instead of a web confirmation page — SafariSheet on
  // the client already auto-dismisses on ANY sqrz:// redirect, so this alone
  // fixes "checkout completes but leaves you stuck in Safari." AppDelegate.swift
  // / sqrzApp.swift route `checkout-return` to its own notification, distinct
  // from stripe-return. Web is untouched.
  const successUrl = isNative
    ? "sqrz://checkout-return?status=success"
    : `${APP_URL}/boost?wallet_topup=success`;
  const cancelUrl = isNative
    ? "sqrz://checkout-return?status=cancelled"
    : `${APP_URL}/boost?wallet_topup=cancelled`;

  const { checkoutUrl } = await createWalletTopupCheckoutSession({
    amountCents,
    profileId: profile.id as string,
    source,
    stripeMode,
    customerEmail: (profile.email as string) ?? undefined,
    successUrl,
    cancelUrl,
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
