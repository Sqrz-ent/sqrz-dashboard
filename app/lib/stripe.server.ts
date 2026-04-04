import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-02-25.clover",
});

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
