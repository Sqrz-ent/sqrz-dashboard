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

// Stripe standard US-card pricing: 2.9% + 30¢. The EXACT fee is card-dependent
// (Amex/international higher, +currency conversion) and only knowable AFTER the
// charge settles (balance_transaction.fee) — there is no accurate number at
// session-creation time. So this is a deliberately flat, honest estimate shown
// as its own line, exact for the vast majority of US cards. NOT grossed up (we
// don't solve for fee-on-the-new-total) — the customer pays base + this, the
// wallet is credited the base only. Top-up flow ONLY (the $25 setup / $10
// reactivation charges absorb Stripe's cut rather than showing a fee-on-a-fee).
export function stripeProcessingFeeCents(baseCents: number): number {
  return Math.round(baseCents * 0.029) + 30;
}

export async function createWalletTopupCheckoutSession(
  params: WalletTopupCheckoutParams,
): Promise<WalletTopupCheckoutResult> {
  const dollars = (params.amountCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const feeCents = stripeProcessingFeeCents(params.amountCents);

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
              "Funds your ad-spend wallet. The SQRZ commission is charged separately when you allocate this to a campaign — not on this top-up.",
          },
        },
        quantity: 1,
      },
      // Transparent pass-through of Stripe's card processing cost, shown as its
      // own line so the total reads as "top-up + card fee" and it's clear this
      // part isn't SQRZ's cut. Added to the charge; NOT credited to the wallet.
      {
        price_data: {
          currency: "usd",
          unit_amount: feeCents,
          product_data: {
            name: "Card processing fee (2.9% + 30¢)",
            description:
              "Passed through from Stripe — this is the card network's processing cost, not a SQRZ fee.",
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
    // branch (vs the campaign branch, which keys on `campaign_id`). `amount_cents`
    // is the BASE top-up (what the wallet is credited) — deliberately NOT the
    // charge total, which now also includes the processing-fee line. `source` is
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
