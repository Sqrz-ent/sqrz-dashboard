import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public-facing (verify_jwt: false) — called directly by the iOS app with the
// anon/publishable key. Identity here is RevenueCat's own rc_app_user_id
// (Purchases.shared.appUserID), not a Supabase auth session, so there's no JWT
// to verify in the first place. Same CORS/verify_jwt shape as
// hubspot-beta-slug-request (the other public-facing function in this
// project).
//
// Grants the `grow_access` RevenueCat entitlement via a lifetime Promotional
// Entitlement grant — the same RevenueCat mechanism Will already uses
// manually (from the RevenueCat dashboard UI) to comp invited testers. No
// code in this project called that API before this function, so
// REVENUECAT_SECRET_API_KEY is a NEW secret — must be set in this project's
// edge function secrets (RevenueCat dashboard → API Keys → secret key,
// `sk_...`) before this function can grant anything.
//
// Companion: get-or-create-invite-code (verify_jwt: true) — the partner's-own-
// code side of this feature.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REVENUECAT_SECRET_API_KEY = Deno.env.get("REVENUECAT_SECRET_API_KEY")!;

const ENTITLEMENT_ID = "grow_access";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  let body: { code?: string; rc_app_user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, code: "invalid_json" }, 400);
  }

  const rawCode = (body.code ?? "").trim();
  const rcAppUserId = (body.rc_app_user_id ?? "").trim();
  if (!rawCode || !rcAppUserId) {
    return json(
      { ok: false, code: "missing_fields", message: "code and rc_app_user_id are required." },
      400,
    );
  }
  const code = rawCode.toUpperCase();

  // ── 1. Look up the code, reject with a typed error ──
  const { data: inviteCode, error: lookupError } = await admin
    .from("invite_codes")
    .select("code, max_redemptions, redemption_count, expires_at, revoked")
    .eq("code", code)
    .maybeSingle();

  if (lookupError) {
    console.error("invite_codes lookup error:", lookupError);
    return json({ ok: false, code: "grant_failed", message: "Something went wrong — try again." }, 500);
  }
  if (!inviteCode) {
    return json({ ok: false, code: "invalid_code", message: "That code isn't valid." }, 404);
  }
  if (inviteCode.revoked) {
    return json({ ok: false, code: "code_revoked", message: "That code is no longer active." }, 410);
  }
  if (inviteCode.expires_at && new Date(inviteCode.expires_at).getTime() < Date.now()) {
    return json({ ok: false, code: "code_expired", message: "That code is no longer active." }, 410);
  }
  if (inviteCode.max_redemptions !== null && inviteCode.redemption_count >= inviteCode.max_redemptions) {
    return json({ ok: false, code: "code_exhausted", message: "That code has already been used up." }, 410);
  }

  // ── 2. Idempotent retry — already redeemed by this rc_app_user_id? Return
  // success without re-granting or re-counting. ──
  const { data: existingRedemption, error: existingError } = await admin
    .from("invite_code_redemptions")
    .select("id")
    .eq("code", code)
    .eq("rc_app_user_id", rcAppUserId)
    .maybeSingle();

  if (existingError) {
    console.error("invite_code_redemptions lookup error:", existingError);
    return json({ ok: false, code: "grant_failed", message: "Something went wrong — try again." }, 500);
  }
  if (existingRedemption) {
    return json({ ok: true, already_redeemed: true });
  }

  // ── 3. Grant the entitlement via RevenueCat's promotional-entitlement API ──
  const rcRes = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcAppUserId)}/entitlements/${ENTITLEMENT_ID}/promotional`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REVENUECAT_SECRET_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ duration: "lifetime" }),
    },
  );

  if (!rcRes.ok) {
    const errText = await rcRes.text();
    console.error("RevenueCat promotional grant failed:", rcRes.status, errText);
    // Do NOT record the redemption — a retry must not be burned on a code
    // that never actually granted anything.
    return json({ ok: false, code: "grant_failed", message: "Something went wrong — try again." }, 502);
  }

  // ── 4. Record the redemption + bump redemption_count atomically (see the
  // record_invite_code_redemption migration — handles the concurrent-retry
  // race for a shared/unlimited code). ──
  const { error: recordError } = await admin.rpc("record_invite_code_redemption", {
    p_code: code,
    p_rc_app_user_id: rcAppUserId,
  });

  if (recordError) {
    // The entitlement is already granted at this point (RevenueCat's grant
    // call is idempotent server-side, so a retry can't double-grant) — a
    // bookkeeping failure here is logged, not surfaced as a failed redeem.
    console.error("record_invite_code_redemption error:", recordError);
  }

  return json({ ok: true });
});
