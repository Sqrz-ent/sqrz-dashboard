import { stripeClientForMode, type StripeMode } from "~/lib/stripe.server";

// Payment-provider abstraction for one-off campaign checkouts. This is the
// ONLY place that calls the Stripe SDK for campaign checkout —
// `api/campaigns/reactivate.tsx` (the $10 reactivation fee, the sole
// remaining caller as of 2026-08-08 — the $25 campaign-setup-fee checkout
// and its `api/campaigns/checkout.tsx` route were removed, see that date's
// CLAUDE.md entry) calls `createCampaignCheckoutSession` and never touches
// `stripe` directly. Swapping providers later (Lemon Squeezy, Paddle, ...)
// means reimplementing this one function; no route changes.

export type CampaignCheckoutParams = {
  amountCents: number;
  productName: string;
  description?: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
  // Which Stripe environment creates this session — the caller's
  // profiles.stripe_beta_test_mode flag, same for web and native (default
  // false = live). See api/campaigns/reactivate.tsx.
  stripeMode: StripeMode;
};

export type CampaignCheckoutResult = {
  checkoutUrl: string | null;
};

export async function createCampaignCheckoutSession(
  params: CampaignCheckoutParams
): Promise<CampaignCheckoutResult> {
  const session = await stripeClientForMode(params.stripeMode).checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: params.amountCents,
          product_data: { name: params.productName, description: params.description },
        },
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.clientReferenceId,
    customer_email: params.customerEmail,
    metadata: params.metadata,
  });

  return { checkoutUrl: session.url };
}
