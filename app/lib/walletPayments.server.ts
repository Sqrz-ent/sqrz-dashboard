import { stripeClientForMode, type StripeMode } from "~/lib/stripe.server";

// Payment-provider abstraction for SQRZ Grow ad-spend wallet top-ups. This is
// the ONLY place that calls the Stripe SDK for wallet top-ups — `api/wallet/topup`
// calls `createWalletTopupCheckoutSession` and never touches `stripe` directly.
// Mirrors campaignPayments.server.ts so a provider swap later touches one file.
//
// Reuses the existing Boost pattern deliberately: a Stripe Checkout Session
// (hosted page, SCA handled) confirmed by the existing api/stripe/webhook.tsx on
// `checkout.session.completed` — NOT a raw PaymentIntent with a bespoke
// confirmation path. The wallet is credited server-side from the webhook.

export type WalletTopupCheckoutParams = {
  amountCents: number;
  profileId: string;
  source: "web" | "ios";
  // Which Stripe environment creates this session — iOS is forced to "test"
  // regardless of profile.stripe_beta_test_mode; web always passes "live".
  // See api/wallet/topup.tsx.
  stripeMode: StripeMode;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
};

export type WalletTopupCheckoutResult = {
  checkoutUrl: string | null;
};

export async function createWalletTopupCheckoutSession(
  params: WalletTopupCheckoutParams,
): Promise<WalletTopupCheckoutResult> {
  const dollars = (params.amountCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const session = await stripeClientForMode(params.stripeMode).checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: params.amountCents,
          product_data: {
            name: `SQRZ ad-spend top-up — $${dollars}`,
            description:
              "Funds your ad-spend wallet. A 15% SQRZ management fee is recorded separately (not deducted from this balance).",
          },
        },
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.profileId,
    customer_email: params.customerEmail,
    // `type` is how api/stripe/webhook.tsx routes this to the wallet-topup
    // branch (vs the campaign branch, which keys on `campaign_id`). `source` is
    // analytics only — never used for gating.
    metadata: {
      type: "wallet_topup",
      profile_id: params.profileId,
      amount_cents: String(params.amountCents),
      source: params.source,
    },
  });

  return { checkoutUrl: session.url };
}
