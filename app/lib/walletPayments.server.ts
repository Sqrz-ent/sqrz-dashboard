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
  // The ACCOUNT's Stripe customer id (2026-10-18 — the wallet lives on
  // account_wallets now, shared by every profile the login owns; see
  // getOrCreateAccountStripeCustomer in stripe.server.ts). Required, not a
  // plain email: `customer` and `customer_email` are mutually exclusive on
  // a Checkout Session, and resolving a real customer id is what lets every
  // top-up from any of the account's profiles land on the same Stripe
  // customer record.
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  // Free-tier campaign-activation budget payment (2026-10-21 follow-up) — set
  // ONLY when this checkout is paying a specific campaign's ad budget
  // (api/campaigns/budget-checkout.tsx), never for a plain wallet top-up. Fee
  // math below is completely unchanged either way; this only adds a metadata
  // field api/stripe/webhook.tsx reads to decide whether to ALSO allocate the
  // paid amount to this campaign (complete_campaign_budget_payment) instead
  // of leaving it as free wallet balance.
  campaignId?: string;
};

export type WalletTopupCheckoutResult = {
  checkoutUrl: string | null;
};

// Flat 7% standard rate (2026-10-25; was 15% since 2026-08-03 — lowered once
// campaign package templates replaced manual setup). Commission moved off allocation and
// onto this Checkout session, since Stripe Checkout only ever handles card
// payments (wire transfers are a separate, off-platform process with their own
// pricing, not built here). Must match the hardcoded 7% in record_wallet_topup
// (the DB function is the actual source of truth for what gets recorded as
// revenue — this is only what the customer sees at checkout).
const SQRZ_TOPUP_FEE_PCT = 7;

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
    // Still the PROFILE, not the account — unused by api.stripe.webhook.tsx
    // today (it reads session.metadata.profile_id instead) but left as the
    // same attribution unit as before this migration, since nothing asked
    // for it to change.
    client_reference_id: params.profileId,
    customer: params.customerId,
    // `type` is how api/stripe/webhook.tsx routes this to the wallet-topup
    // branch (vs the campaign branch, which keys on `campaign_id`). `amount_cents`
    // is the BASE top-up (what the wallet is credited) — deliberately NOT the
    // charge total, which also includes the SQRZ Fee line. `source` is
    // analytics only — never used for gating. record_wallet_topup recomputes
    // the 7% fee itself server-side rather than trusting a client-passed value.
    metadata: {
      // type stays "wallet_topup" regardless of campaignId — api/stripe/webhook.tsx's
      // existing wallet_topup branch (record_wallet_topup call, fee row, etc.)
      // is completely unchanged; campaign_id is read as an ADDITIONAL step
      // after that branch succeeds, not a different branch.
      type: "wallet_topup",
      profile_id: params.profileId,
      amount_cents: String(params.amountCents),
      source: params.source,
      ...(params.campaignId ? { campaign_id: params.campaignId } : {}),
    },
  });

  return { checkoutUrl: session.url };
}
