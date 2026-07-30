import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.checkout";
import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createCampaignCheckoutSession } from "~/lib/campaignPayments.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

export async function action({ request }: Route.ActionArgs) {
  // Native callers (sqrz-ios) authenticate with a Bearer access token and expect JSON;
  // the browser flow authenticates via cookies. Body is JSON in both cases.
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

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  let body: {
    budget_amount?: number;
    campaign_id?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const budget = Number(body.budget_amount);

  if (!budget || budget <= 0) {
    return Response.json({ error: "Invalid budget_amount" }, { status: 400, headers });
  }
  // Start Campaign has exactly one flow now: an existing campaign row (created by
  // the /boost action first) is paid for here. The legacy grow self-create branch
  // was removed — it was fully dead (no client created grow campaigns, 0 grow rows
  // ever existed). campaign_id is always required.
  if (!body.campaign_id) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }
  const campaignId = body.campaign_id;

  // ── Calculate fee and total ────────────────────────────────────────────────
  // One fee model: flat $25 campaign fee on top of the chosen budget pill, charged
  // in the same checkout. The budget is credited to the shared ad-spend wallet
  // (fee-exempt) AND immediately allocated to this campaign on webhook. No
  // percentage variant, no campaign-type branching.
  const BOOST_FLAT_FEE = 25;
  const total = budget + BOOST_FLAT_FEE;

  // ── Checkout session (Stripe today; see campaignPayments.server.ts) ────────
  const { checkoutUrl } = await createCampaignCheckoutSession({
    amountCents: Math.round(total * 100),
    productName: `SQRZ Boost Campaign — $${budget} ad budget + $${BOOST_FLAT_FEE} fee`,
    description: `$${budget} ad budget (added to your ad-spend wallet) + flat $${BOOST_FLAT_FEE} campaign fee.`,
    successUrl: `${APP_URL}/boost?campaign_paid=true`,
    cancelUrl: `${APP_URL}/boost`,
    clientReferenceId: campaignId,
    customerEmail: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      campaign_id: campaignId,
      budget_amount: String(budget),
      fee: String(BOOST_FLAT_FEE),
      total: String(total),
      // Analytics only (mirrors the wallet-topup flow) — the webhook credits the
      // budget to the wallet with this source. Never used for gating.
      source: isNative ? "ios" : "web",
    },
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
