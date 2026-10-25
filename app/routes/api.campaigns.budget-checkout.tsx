import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.budget-checkout";
import { createSupabaseServerClient, createSupabaseBearerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createWalletTopupCheckoutSession } from "~/lib/walletPayments.server";
import { getOrCreateAccountStripeCustomer, type StripeMode } from "~/lib/stripe.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

// Free-tier campaign-activation budget payment (2026-10-21 follow-up) — the
// "Card" option on the budget-payment screen shown right after a free
// (no grow_access) user's activation purchase confirms. A campaign in this
// state sits at status='awaiting_budget' (see verify-campaign-activation +
// record_campaign_activation) with no Meta object created yet
// (on_boost_campaign_submit_meta_create only fires on a transition INTO
// in_review). This route pays exactly that campaign's budget — the SAME
// Stripe Checkout session shape and fee math as api/wallet/topup.tsx
// (createWalletTopupCheckoutSession, flat 7% SQRZ Fee line, completely
// unchanged), just tagged with campaign_id in metadata. api/stripe/webhook.tsx
// reads that tag after its existing, unmodified wallet_topup branch succeeds
// and calls complete_campaign_budget_payment — which credits the wallet
// (record_wallet_topup, same as any top-up) AND immediately allocates the
// identical amount to this campaign AND advances it to in_review (firing
// meta-campaign-create), atomically, so the money never sits as free wallet
// balance even momentarily.
//
// Premium (grow_access) users never call this route — their path is
// unchanged: wallet balance check in the create sheet, then the existing
// allocate_campaign_budget RPC, no Stripe involved at launch time.
//
// Deliberately a SEPARATE route from api/wallet/topup.tsx rather than an
// optional param there: this one needs campaign ownership + status
// validation that has nothing to do with a plain wallet top-up, and keeping
// them apart means the "Card" option here can grow (more validation, a
// different amount source, etc.) without ever touching the premium wallet
// top-up path.
const MIN_BUDGET_CENTS = 500;      // $5 — same floor as wallet top-up
const MAX_BUDGET_CENTS = 50_000;   // $500 — same ceiling as wallet top-up

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

  // Multi-profile ownership (2026-10-18) — iOS sends the active profile
  // explicitly; see getCurrentProfile's own doc comment for the fallback.
  const requestedProfileId = new URL(request.url).searchParams.get("profile_id");
  const profile = await getCurrentProfile(supabase, user.id, requestedProfileId);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  let body: { campaign_id?: string; amount_cents?: number; source?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const campaignId = body.campaign_id;
  if (!campaignId) {
    return Response.json({ error: "campaign_id is required" }, { status: 400, headers });
  }

  const amountCents = Math.round(Number(body.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents < MIN_BUDGET_CENTS || amountCents > MAX_BUDGET_CENTS) {
    return Response.json(
      { error: `amount_cents must be between ${MIN_BUDGET_CENTS} and ${MAX_BUDGET_CENTS}` },
      { status: 400, headers },
    );
  }

  // Ownership + state check — this is the one place a real auth.uid()
  // context exists for this campaign, which is exactly why
  // complete_campaign_budget_payment (called later, from the webhook, with
  // no caller identity) doesn't need to re-check it itself.
  const admin = createSupabaseAdminClient();
  const { data: campaign } = await admin
    .from("boost_campaigns")
    .select("id, profile_id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.profile_id !== profile.id) {
    return Response.json({ error: "Campaign not found" }, { status: 404, headers });
  }
  if (campaign.status !== "awaiting_budget") {
    return Response.json(
      { error: "This campaign isn't waiting for a budget payment." },
      { status: 409, headers },
    );
  }

  const source: "web" | "ios" =
    body.source === "web" || body.source === "ios"
      ? body.source
      : isNative ? "ios" : "web";

  const stripeMode: StripeMode = profile.stripe_beta_test_mode ? "test" : "live";

  // Same account-level Stripe customer resolution as api/wallet/topup.tsx —
  // the wallet (and now this campaign's budget credit) lives on
  // account_wallets, shared by every profile the login owns.
  const { data: account } = await admin
    .from("accounts")
    .select("id, stripe_customer_id")
    .eq("id", profile.account_id as string)
    .maybeSingle();
  if (!account) {
    return Response.json({ error: "Account not found" }, { status: 404, headers });
  }
  const customerId = await getOrCreateAccountStripeCustomer(admin, account, {
    email: (profile.email as string) ?? undefined,
  });

  // Reuses the exact same sqrz:// return scheme SafariSheet already
  // auto-dismisses on for wallet top-up — no new client-side URL handling
  // needed.
  const successUrl = isNative
    ? "sqrz://checkout-return?status=success"
    : `${APP_URL}/boost?budget_payment=success`;
  const cancelUrl = isNative
    ? "sqrz://checkout-return?status=cancelled"
    : `${APP_URL}/boost?budget_payment=cancelled`;

  const { checkoutUrl } = await createWalletTopupCheckoutSession({
    amountCents,
    profileId: profile.id as string,
    source,
    stripeMode,
    customerId,
    successUrl,
    cancelUrl,
    campaignId,
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
