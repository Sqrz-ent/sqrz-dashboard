// verify-campaign-activation — campaign activation via a consumable IAP,
// priced per template (2026-10-21). Verifies the client's StoreKit 2 signed
// transaction (Transaction.jwsRepresentation — the SAME JWS format/shape
// Apple's server notifications use, verified with the identical function),
// then atomically records the purchase and advances the campaign.
//
// Budget-after-booking fix (2026-10-22): campaign creation/activation never
// looks at money, for free AND paying (grow_access) users alike — budget
// always comes after the campaign is booked. This REPLACES the 2026-10-21
// free-tier follow-up, which branched the campaign's post-activation status
// on a live RevenueCat grow_access check (premium -> in_review immediately,
// free -> awaiting_budget) — that branch, and the hasGrowAccess() RevenueCat
// call backing it, are both removed here. record_campaign_activation is now
// called with NO p_target_status at all, so EVERY successful activation
// lands on its default, 'awaiting_budget' (see the
// budget_after_booking migration) — regardless of tier. What happens next is
// entirely a client-side routing decision (which screen to show — the
// existing free-tier budget-payment screen, or the new premium Allocate
// screen), not a server-enforced one: the real money-moving actions
// (allocate_campaign_budget, complete_campaign_budget_payment) each do their
// own ownership/balance checks independently and are what actually advances
// awaiting_budget -> in_review (which is what fires
// on_boost_campaign_submit_meta_create) — so Meta's campaign is only ever
// created once real budget has moved, for both paths, never before.
//
// Does NOT touch wallet top-up, allocate_campaign_budget, meta-campaign-
// create, or api/campaigns/checkout — those are a completely separate
// money flow (ad spend) from this one (paying to submit a campaign at all).
//
// Auth: the caller's own Supabase JWT (same manual-validation pattern as
// meta-insights-sync's user-triggered path / the meta-page-* functions) +
// user_owns_profile ownership check on the CAMPAIGN'S profile — deployed
// verify_jwt:true since this function has no other caller.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyAppleJws } from "../_shared/apple-jws.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "com.sqrz.ios";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Body = {
  campaign_id?: string;
  signed_transaction?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearerToken);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const campaignId = body.campaign_id;
  const signedTransaction = body.signed_transaction;
  if (!campaignId || !signedTransaction) {
    return json({ error: "missing_fields", message: "campaign_id and signed_transaction are required." }, 400);
  }

  // ── Load the campaign (profile_id + goal decide ownership and the
  // expected product) ──
  const { data: campaign, error: campErr } = await supabase
    .from("boost_campaigns")
    .select("id, profile_id, goal, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) return json({ error: `campaign lookup: ${campErr.message}` }, 500);
  if (!campaign) {
    // Not one of the 4 codes the spec lists by name — flagged as an
    // addition, same convention every other function in this project uses
    // for a lookup-miss beyond the requested error set.
    return json({ error: "campaign_not_found" }, 404);
  }

  // ── Ownership — through a client scoped to the caller's own JWT, so
  // auth.uid() resolves inside the RLS helper (same pattern as
  // meta-insights-sync's user-triggered refresh / the meta-page-* functions). ──
  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc("user_owns_profile", {
    p_profile_id: campaign.profile_id,
  });
  if (ownsErr || owns !== true) return json({ error: "not_owner" }, 403);

  // ── Verify the StoreKit 2 signed transaction ──
  let txn: Record<string, unknown>;
  try {
    txn = await verifyAppleJws(signedTransaction);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[verify-campaign-activation] JWS verification failed for campaign ${campaignId}:`, msg);
    return json({ error: "invalid_transaction", message: "Couldn't verify this transaction." }, 400);
  }

  // Bundle id + appAccountToken (must equal the campaign's profile_id) —
  // both fold into invalid_transaction per the spec's own error-code list
  // (neither is called out as its own distinct code there), unlike
  // product_mismatch below, which the spec DOES call out separately.
  if (txn.bundleId != null && txn.bundleId !== BUNDLE_ID) {
    return json({ error: "invalid_transaction", message: "Wrong app bundle." }, 400);
  }
  const appAccountToken = txn.appAccountToken != null ? String(txn.appAccountToken) : null;
  if (!appAccountToken || appAccountToken.toLowerCase() !== String(campaign.profile_id).toLowerCase()) {
    return json({ error: "invalid_transaction", message: "This transaction isn't for this profile." }, 400);
  }

  const transactionId = txn.transactionId != null ? String(txn.transactionId) : null;
  const originalTransactionId = txn.originalTransactionId != null
    ? String(txn.originalTransactionId)
    : null;
  const productId = txn.productId != null ? String(txn.productId) : null;
  if (!transactionId || !productId) {
    return json({ error: "invalid_transaction", message: "Transaction is missing required fields." }, 400);
  }

  // ── Product must match this campaign's template (via its goal) ──
  const { data: mapping, error: mappingErr } = await supabase
    .from("campaign_activation_products")
    .select("product_id")
    .eq("goal", campaign.goal ?? "")
    .maybeSingle();
  if (mappingErr) return json({ error: `product mapping lookup: ${mappingErr.message}` }, 500);
  if (!mapping || mapping.product_id !== productId) {
    return json({
      error: "product_mismatch",
      message: "This product doesn't match the campaign's template.",
    }, 400);
  }

  const environment = String(txn.environment ?? "").toLowerCase() === "production"
    ? "production"
    : "sandbox";
  const purchasedAt = txn.purchaseDate != null
    ? new Date(Number(txn.purchaseDate)).toISOString()
    : new Date().toISOString();

  // ── Record + advance, atomically (record_campaign_activation) — no
  // p_target_status passed, so every activation lands on the RPC's own
  // default, 'awaiting_budget', regardless of tier (see the module header). ──
  try {
    const { data: result, error } = await supabase.rpc("record_campaign_activation", {
      p_campaign_id: campaignId,
      p_profile_id: campaign.profile_id,
      p_product_id: productId,
      p_transaction_id: transactionId,
      p_original_transaction_id: originalTransactionId,
      p_environment: environment,
      p_price: txn.price != null ? Number(txn.price) : null,
      p_currency: txn.currency != null ? String(txn.currency) : null,
      p_purchased_at: purchasedAt,
    });
    if (error) throw error;
    return json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return json({ error: "already_used", message: "This transaction has already been used." }, 409);
    }
    console.error(`[verify-campaign-activation] record_campaign_activation failed for campaign ${campaignId}:`, msg);
    return json({ error: "activation_failed", message: "Couldn't record this activation. Please try again." }, 500);
  }
});
