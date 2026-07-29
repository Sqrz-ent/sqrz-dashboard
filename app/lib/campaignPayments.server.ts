import { stripe } from "~/lib/stripe.server";

// Payment-provider abstraction for one-off campaign checkouts (Boost/Grow ad
// spend + fees). This is the ONLY place that calls the Stripe SDK for campaign
// checkout — `api/campaigns/checkout.tsx` calls `createCampaignCheckoutSession`
// and never touches `stripe` directly. Swapping providers later (Lemon Squeezy,
// Paddle, ...) means reimplementing this one function; no route changes.

export type CampaignCheckoutParams = {
  amountCents: number;
  productName: string;
  description?: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
};

export type CampaignCheckoutResult = {
  checkoutUrl: string | null;
};

export async function createCampaignCheckoutSession(
  params: CampaignCheckoutParams
): Promise<CampaignCheckoutResult> {
  const session = await stripe.checkout.sessions.create({
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
