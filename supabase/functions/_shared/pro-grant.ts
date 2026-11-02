// Pro grant for campaign-template purchases (campaign_templates.pro_days).
//
// Called by verify-campaign-activation (client path) and apple-consumable-
// webhook (backup path) AFTER record_campaign_activation has recorded the
// purchase. Grants the `grow_access` RevenueCat entitlement — the same one
// redeem-invite-code grants — as a PROMOTIONAL entitlement with an explicit
// end time, extending rather than overwriting:
//
//   new end = max(current promotional end, now) + pro_days
//
// Idempotent per purchase: the outcome is recorded on the campaign_activations
// row (pro_granted_at / pro_granted_until / pro_days_granted). Both callers also
// invoke this on their "already recorded" paths, so a purchase whose first grant
// attempt failed (RevenueCat outage) is healed by the next retry.
//
// Never throws — a failed grant must not fail or undo the activation itself.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const PRO_ENTITLEMENT_ID = "grow_access"; // same as redeem-invite-code
const RC_API = "https://api.revenuecat.com/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
// A claim older than this is assumed abandoned (function crashed mid-grant).
const CLAIM_STALE_MS = 5 * 60 * 1000;

export type ProGrantResult =
  | { status: "granted"; days: number; until: string }
  | { status: "already_granted"; days: number | null; until: string | null }
  | { status: "no_pro" }                       // template includes no Pro (recorded)
  | { status: "already_lifetime" }             // user already has lifetime promo Pro (recorded)
  | { status: "in_progress" }                  // another invocation holds the claim
  | { status: "skipped"; reason: string }      // nothing to do / not grantable
  | { status: "failed"; reason: string };      // transient — a retry will try again

type RcEntitlement = {
  expires_date?: string | null;
  product_identifier?: string;
};

export async function grantProForActivation(
  supabase: SupabaseClient,
  transactionId: string,
): Promise<ProGrantResult> {
  try {
    return await run(supabase, transactionId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[pro-grant] unexpected failure for transaction ${transactionId}:`, reason);
    return { status: "failed", reason };
  }
}

async function run(supabase: SupabaseClient, transactionId: string): Promise<ProGrantResult> {
  // ── 1. The purchase ──
  const { data: activation, error: actErr } = await supabase
    .from("campaign_activations")
    .select("id, profile_id, product_id, status, pro_days_granted, pro_granted_at, pro_granted_until")
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (actErr) return { status: "failed", reason: `activation lookup: ${actErr.message}` };
  if (!activation) return { status: "skipped", reason: "no_activation" };
  if (activation.status !== "active") return { status: "skipped", reason: "activation_not_active" };

  // Idempotency: already decided → never grant again.
  if (activation.pro_granted_at) {
    return {
      status: "already_granted",
      days: activation.pro_days_granted as number | null,
      until: activation.pro_granted_until as string | null,
    };
  }

  // ── 2. What the template includes ──
  const { data: template, error: tplErr } = await supabase
    .from("campaign_templates")
    .select("pro_days")
    .eq("iap_product_id", activation.product_id)
    .maybeSingle();
  if (tplErr) return { status: "failed", reason: `template lookup: ${tplErr.message}` };
  const proDays = Number(template?.pro_days ?? 0);

  if (!(proDays > 0)) {
    // Record the "no Pro" decision so editing pro_days later never causes a
    // retry of THIS purchase to grant retroactively.
    await finalise(supabase, activation.id as string, 0, null);
    return { status: "no_pro" };
  }

  const secretKey = Deno.env.get("REVENUECAT_SECRET_API_KEY");
  if (!secretKey) {
    console.error("[pro-grant] REVENUECAT_SECRET_API_KEY is not set — cannot grant Pro");
    return { status: "failed", reason: "revenuecat_key_missing" };
  }

  // ── 3. Claim (atomic): only one invocation proceeds to RevenueCat ──
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("campaign_activations")
    .update({ pro_grant_started_at: nowIso })
    .eq("id", activation.id)
    .is("pro_granted_at", null)
    .or(`pro_grant_started_at.is.null,pro_grant_started_at.lt.${staleIso}`)
    .select("id");
  if (claimErr) return { status: "failed", reason: `claim: ${claimErr.message}` };
  if (!claimed || claimed.length === 0) return { status: "in_progress" };

  const release = () =>
    supabase.from("campaign_activations").update({ pro_grant_started_at: null }).eq("id", activation.id);

  // ── 4. RevenueCat app user id = the Supabase auth user id, lowercase (that is
  // exactly what sqrz-ios passes to Purchases.logIn). ──
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("id", activation.profile_id)
    .maybeSingle();
  if (profErr || !profile?.user_id) {
    await release();
    return { status: "failed", reason: "profile_has_no_user_id" };
  }
  const appUserId = String(profile.user_id).toLowerCase();
  const headers = { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };

  // ── 5. Current entitlement → base time ──
  let base = Date.now();
  try {
    const subRes = await fetch(`${RC_API}/subscribers/${encodeURIComponent(appUserId)}`, { headers });
    if (!subRes.ok) {
      console.error("[pro-grant] RevenueCat subscriber fetch failed:", subRes.status, await subRes.text());
      await release();
      return { status: "failed", reason: `revenuecat_fetch_${subRes.status}` };
    }
    const sub = await subRes.json();
    const ent = sub?.subscriber?.entitlements?.[PRO_ENTITLEMENT_ID] as RcEntitlement | undefined;
    const isPromo = typeof ent?.product_identifier === "string" && ent.product_identifier.startsWith("rc_promo_");
    if (ent && isPromo) {
      if (ent.expires_date == null) {
        // Lifetime promotional Pro (e.g. an invite code) — nothing to extend.
        await finalise(supabase, activation.id as string, 0, null);
        return { status: "already_lifetime" };
      }
      const currentEnd = Date.parse(ent.expires_date);
      if (!Number.isNaN(currentEnd)) base = Math.max(base, currentEnd);
    }
    // A paid subscription (non-promo) or no/expired entitlement → base stays now.
  } catch (err) {
    await release();
    return { status: "failed", reason: `revenuecat_fetch: ${err instanceof Error ? err.message : err}` };
  }

  // ── 6. Grant with an explicit end time ──
  const endMs = base + proDays * DAY_MS;
  try {
    const grantRes = await fetch(
      `${RC_API}/subscribers/${encodeURIComponent(appUserId)}/entitlements/${PRO_ENTITLEMENT_ID}/promotional`,
      { method: "POST", headers, body: JSON.stringify({ end_time_ms: endMs }) },
    );
    if (!grantRes.ok) {
      console.error("[pro-grant] RevenueCat promotional grant failed:", grantRes.status, await grantRes.text());
      await release();
      return { status: "failed", reason: `revenuecat_grant_${grantRes.status}` };
    }
  } catch (err) {
    await release();
    return { status: "failed", reason: `revenuecat_grant: ${err instanceof Error ? err.message : err}` };
  }

  // ── 7. Record. RevenueCat has already granted at this point, so retry the
  // write — a lost write here would let a later retry extend a second time. ──
  const untilIso = new Date(endMs).toISOString();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await finalise(supabase, activation.id as string, proDays, untilIso);
    if (ok) return { status: "granted", days: proDays, until: untilIso };
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  console.error(
    `[pro-grant] GRANTED but FAILED TO RECORD for activation ${activation.id} (until ${untilIso}) — a retry may double-grant; reconcile manually.`,
  );
  return { status: "granted", days: proDays, until: untilIso };
}

async function finalise(
  supabase: SupabaseClient,
  activationId: string,
  daysGranted: number,
  untilIso: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from("campaign_activations")
    .update({
      pro_days_granted: daysGranted,
      pro_granted_at: new Date().toISOString(),
      pro_granted_until: untilIso,
      pro_grant_started_at: null,
    })
    .eq("id", activationId)
    .is("pro_granted_at", null);
  if (error) {
    console.error("[pro-grant] finalise failed:", error.message);
    return false;
  }
  return true;
}
