import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-02-25.clover",
});

// ─── Test-mode client ───────────────────────────────────────────────────────
// Backs the wallet-topup / campaign-checkout / reactivation live/test split (see
// walletPayments.server.ts + campaignPayments.server.ts): stripeClientForMode is
// selected per-profile via profiles.stripe_beta_test_mode (default false = live
// for everyone, web and native alike — see api/wallet/topup.tsx). Until
// 2026-08-04 these three routes instead hardcoded test mode for every native
// (Bearer-auth/iOS) caller regardless of that flag, which is why iOS kept
// opening sandbox checkout even after web was confirmed live — not an
// environment/deployment mismatch, just this bypass.
// A session created with this client automatically renders Stripe's hosted
// Checkout in test mode (test card entry, test banner) — no other code needed
// to "enable" that, it's inherent to which secret key created the session.
if (!process.env.STRIPE_SECRET_KEY_TEST) {
  throw new Error("STRIPE_SECRET_KEY_TEST is not set");
}

export const stripeTest = new Stripe(process.env.STRIPE_SECRET_KEY_TEST, {
  apiVersion: "2026-02-25.clover",
});

export type StripeMode = "live" | "test";

export function stripeClientForMode(mode: StripeMode): Stripe {
  return mode === "test" ? stripeTest : stripe;
}

// ─── Price → plan_id map ──────────────────────────────────────────────────────
// plan_id 1 = SQRZ Creator, 2 = SQRZ Grow, 4 = Early Access, 5 = Boost

export const PRICE_TO_PLAN: Record<string, number> = {
  "price_1TC6PhAvjL5RjAe1sYnqJRGl": 1,  // Creator monthly
  "price_1TC6Q5AvjL5RjAe1uZPiNipJ": 1,  // Creator yearly
  "price_1TC6TYAvjL5RjAe1kkxTDTVu": 4,  // Early Access yearly
  "price_1TEpETAvjL5RjAe1PHKcJO6V": 5,  // Boost monthly
  "price_1TEpGXAvjL5RjAe1uUAlfZcG": 2,  // Grow per campaign
};

// ─── Helper: get or create Stripe customer ────────────────────────────────────

/**
 * Returns the Stripe customer ID for a profile.
 * If the profile has no stripe_customer_id, creates one and saves it.
 */
export async function getOrCreateStripeCustomer(
  supabase: SupabaseClient,
  profile: Record<string, unknown>
): Promise<string> {
  if (profile.stripe_customer_id) {
    return profile.stripe_customer_id as string;
  }

  const customer = await stripe.customers.create({
    email: (profile.email as string) ?? undefined,
    name: (profile.name as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      slug: (profile.slug as string) ?? "",
    },
  });

  await supabase
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", profile.id);

  return customer.id;
}
