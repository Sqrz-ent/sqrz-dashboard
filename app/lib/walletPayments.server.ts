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
  // Which Stripe environment creates this session — the caller's
  // profiles.stripe_beta_test_mode flag, same for web and native (default
  // false = live). See api/wallet/topup.tsx.
  stripeMode: StripeMode;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
};

export type WalletTopupCheckoutResult = {
  checkoutUrl: string | null;
};

// Flat 15% standard rate (2026-08-03) — commission moved off allocation and
// onto this Checkout session, since Stripe Checkout only ever handles card
// payments (wire transfers are a separate, off-platform process with their own
// pricing, not built here). Must match the hardcoded 15% in record_wallet_topup
// (the DB function is the actual source of truth for what gets recorded as
// revenue — this is only what the customer sees at checkout).
const SQRZ_TOPUP_FEE_PCT = 15;

export function walletTopupFeeCents(baseCents: number): number {
  return Math.round(baseCents * (SQRZ_TOPUP_FEE_PCT / 100));
}

export async function createWalletTopupCheckoutSession(
  params: WalletTopupCheckoutParams,
): Promise<WalletTopupCheckoutResult> {
  const feeCents = walletTopupFeeCents(params.amountCents);

  const session = await stripeClientForMode(params.stripeMode).checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: params.amountCents,
          product_data: {
            name: "Wallet Top-Up",
            description: "Funds your ad-spend wallet in full.",
          },
        },
        quantity: 1,
      },
      // The SQRZ commission, charged here (not at allocation) so top-up is the
      // one moment money changes hands. NOT credited to the wallet — recorded
      // separately as revenue by record_wallet_topup.
      {
        price_data: {
          currency: "usd",
          unit_amount: feeCents,
          product_data: {
            name: "SQRZ Fee",
            description: `SQRZ management fee (${SQRZ_TOPUP_FEE_PCT}% of the top-up amount).`,
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
    // charge total, which also includes the SQRZ Fee line. `source` is
    // analytics only — never used for gating. record_wallet_topup recomputes
    // the 15% fee itself server-side rather than trusting a client-passed value.
    metadata: {
      type: "wallet_topup",
      profile_id: params.profileId,
      amount_cents: String(params.amountCents),
      source: params.source,
    },
  });

  return { checkoutUrl: session.url };
}
