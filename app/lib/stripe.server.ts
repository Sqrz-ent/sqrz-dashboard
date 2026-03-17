import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-03-31.basil",
});

// ─── Price → plan_id map ──────────────────────────────────────────────────────

export const PRICE_TO_PLAN: Record<string, number> = {
  [process.env.STRIPE_GROW_STARTER_PRICE_ID ?? ""]: 2,
  [process.env.STRIPE_GROW_PRO_PRICE_ID ?? ""]: 3,
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
