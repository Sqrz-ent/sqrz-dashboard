// apple-subscription-webhook — App Store Server Notifications V2 receiver for
// the SQRZ Companion iOS subscription. PUBLIC endpoint (verify_jwt: false —
// Apple can't send a Supabase JWT); authenticity comes from verifying Apple's
// signed JWS payload against the pinned Apple Root CA instead. Never trust the
// payload without verification.
//
// Writes to ios_subscriptions (upsert on original_transaction_id — Apple's
// stable id across renewals) and logs EVERY received notification to
// apple_webhook_events, including types we don't act on.
//
// The link from Apple → SQRZ profile is the transaction's appAccountToken: the
// iOS client sets it to profiles.id (uuid) at purchase time
// (CompanionSubscriptionManager.purchase()). Renewals for known subscriptions
// fall back to the existing row's profile when the token is absent.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { compactVerify, decodeProtectedHeader, importX509 } from "npm:jose@5";
import { X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Not a secret, but env-configurable so sandbox builds with a different bundle
// id (if ever needed) don't require a code change.
const BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "com.sqrz.ios";

// Apple Root CA - G3 — the root of the x5c chain in every App Store Server
// Notification. Fetched once per isolate from Apple and cached; verification
// FAILS CLOSED (503, so Apple retries) if the root can't be loaded.
const APPLE_ROOT_CA_URL = "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer";
let appleRootDer: Buffer | null = null;

async function getAppleRoot(): Promise<Buffer> {
  if (appleRootDer) return appleRootDer;
  const res = await fetch(APPLE_ROOT_CA_URL);
  if (!res.ok) throw new Error(`Apple root CA fetch failed: ${res.status}`);
  appleRootDer = Buffer.from(await res.arrayBuffer());
  return appleRootDer;
}

// Verifies one Apple JWS (the notification envelope, signedTransactionInfo, or
// signedRenewalInfo all use the same scheme): x5c chain of [leaf, intermediate,
// root], root must byte-equal the pinned Apple Root CA, each cert must be
// signed by the next, and the JWS signature must verify against the leaf key.
async function verifyAppleJws(jws: string): Promise<Record<string, unknown>> {
  const header = decodeProtectedHeader(jws);
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 3) {
    throw new Error("missing or short x5c chain");
  }

  const certs = x5c.map((b64) => new X509Certificate(Buffer.from(b64, "base64")));
  const root = certs[certs.length - 1];

  const pinnedRoot = await getAppleRoot();
  if (!root.raw.equals(pinnedRoot)) {
    throw new Error("x5c root is not Apple Root CA - G3");
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`x5c chain broken at index ${i}`);
    }
  }

  const leafKey = await importX509(certs[0].toString(), "ES256");
  const { payload } = await compactVerify(jws, leafKey);
  return JSON.parse(new TextDecoder().decode(payload));
}

// notificationType (+subtype) → ios_subscriptions.status. Types not listed are
// log-only (TEST, CONSUMPTION_REQUEST, RENEWAL_EXTENDED, PRICE_INCREASE, …).
function mapStatus(type: string, subtype: string | undefined): string | null {
  switch (type) {
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      return "active";
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return "expired";
    case "DID_FAIL_TO_RENEW":
      return subtype === "GRACE_PERIOD" ? "in_grace_period" : "in_billing_retry";
    case "REFUND":
      return "refunded";
    case "REVOKE":
      return "revoked";
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let signedPayload: string;
  try {
    const body = await req.json();
    signedPayload = body.signedPayload;
    if (typeof signedPayload !== "string") throw new Error("no signedPayload");
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // ── Verify the envelope ────────────────────────────────────────────────────
  let notification: Record<string, unknown>;
  try {
    notification = await verifyAppleJws(signedPayload);
  } catch (err) {
    // Root-CA fetch problems are our side — 503 so Apple retries. Anything else
    // is an invalid/forged payload — 401, no retry needed.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[apple-webhook] verification failed:", msg);
    const status = msg.includes("root CA fetch") ? 503 : 401;
    return new Response("Verification failed", { status });
  }

  const notificationType = String(notification.notificationType ?? "");
  const subtype = notification.subtype != null ? String(notification.subtype) : undefined;
  const data = (notification.data ?? {}) as Record<string, unknown>;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Inner JWS payloads (transaction + renewal info) ────────────────────────
  let txn: Record<string, unknown> = {};
  let renewal: Record<string, unknown> = {};
  let innerError: string | null = null;
  try {
    if (typeof data.signedTransactionInfo === "string") {
      txn = await verifyAppleJws(data.signedTransactionInfo);
    }
    if (typeof data.signedRenewalInfo === "string") {
      renewal = await verifyAppleJws(data.signedRenewalInfo);
    }
  } catch (err) {
    innerError = `inner JWS verification failed: ${err instanceof Error ? err.message : err}`;
  }

  const environment = String(data.environment ?? "").toLowerCase() === "production"
    ? "production"
    : "sandbox";
  const originalTransactionId = txn.originalTransactionId != null
    ? String(txn.originalTransactionId)
    : null;

  // ── Always log the raw event first ─────────────────────────────────────────
  const { data: eventRow } = await supabase
    .from("apple_webhook_events")
    .insert({
      notification_type: notificationType,
      subtype: subtype ?? null,
      notification_uuid: notification.notificationUUID != null
        ? String(notification.notificationUUID)
        : null,
      original_transaction_id: originalTransactionId,
      environment,
      payload: { notification, transaction: txn, renewal },
      processed: false,
      error: innerError,
    })
    .select("id")
    .single();
  const eventId = eventRow?.id as number | undefined;

  async function markEvent(processed: boolean, error?: string) {
    if (eventId == null) return;
    await supabase
      .from("apple_webhook_events")
      .update({ processed, error: error ?? null })
      .eq("id", eventId);
  }

  if (innerError) {
    return new Response("Verification failed", { status: 401 });
  }

  // ── Bundle check ───────────────────────────────────────────────────────────
  if (data.bundleId != null && data.bundleId !== BUNDLE_ID) {
    await markEvent(false, `bundleId mismatch: ${data.bundleId}`);
    return new Response("Wrong bundle", { status: 401 });
  }

  const targetStatus = mapStatus(notificationType, subtype);
  const isRenewalStatusChange = notificationType === "DID_CHANGE_RENEWAL_STATUS";

  // Log-only types (TEST etc.) — recorded above, nothing to upsert.
  if (targetStatus == null && !isRenewalStatusChange) {
    await markEvent(true);
    return new Response("OK", { status: 200 });
  }

  if (!originalTransactionId) {
    await markEvent(false, "no originalTransactionId in transaction payload");
    return new Response("OK", { status: 200 });
  }

  // ── Resolve the profile ────────────────────────────────────────────────────
  // appAccountToken is set to profiles.id by the iOS purchase call. For
  // renewals/updates of a known subscription, fall back to the existing row.
  let profileId = txn.appAccountToken != null ? String(txn.appAccountToken) : null;
  const { data: existing } = await supabase
    .from("ios_subscriptions")
    .select("id, profile_id, product_id")
    .eq("original_transaction_id", originalTransactionId)
    .maybeSingle();
  if (!profileId) profileId = (existing?.profile_id as string | undefined) ?? null;

  if (!profileId) {
    await markEvent(false, "cannot resolve profile (no appAccountToken, no existing row)");
    return new Response("OK", { status: 200 });
  }

  // ── Upsert ─────────────────────────────────────────────────────────────────
  const autoRenewStatus = renewal.autoRenewStatus != null
    ? Number(renewal.autoRenewStatus) === 1
    : null;

  const row: Record<string, unknown> = {
    profile_id: profileId,
    product_id: String(txn.productId ?? existing?.product_id ?? ""),
    original_transaction_id: originalTransactionId,
    latest_transaction_id: txn.transactionId != null ? String(txn.transactionId) : null,
    environment,
    current_period_expires_at: txn.expiresDate != null
      ? new Date(Number(txn.expiresDate)).toISOString()
      : null,
    ...(autoRenewStatus != null ? { auto_renew_status: autoRenewStatus } : {}),
    ...(renewal.autoRenewProductId != null
      ? { auto_renew_product_id: String(renewal.autoRenewProductId) }
      : {}),
    ...(txn.revocationReason != null
      ? { cancellation_reason: String(txn.revocationReason) }
      : {}),
  };

  // DID_CHANGE_RENEWAL_STATUS doesn't change entitlement — status stays as-is
  // on update (omitted from row); the insert fallback below defaults to active.
  if (targetStatus != null) {
    row.status = targetStatus;
  }

  const { error: upsertError } = existing
    ? await supabase
        .from("ios_subscriptions")
        .update(row)
        .eq("original_transaction_id", originalTransactionId)
    : await supabase.from("ios_subscriptions").insert({ ...row, status: row.status ?? "active" });

  if (upsertError) {
    console.error("[apple-webhook] upsert failed:", upsertError.message);
    await markEvent(false, `upsert failed: ${upsertError.message}`);
    // 500 → Apple retries; the event row keeps the error for debugging.
    return new Response("Upsert failed", { status: 500 });
  }

  await markEvent(true);
  console.log(
    `[apple-webhook] ${notificationType}${subtype ? `/${subtype}` : ""} → ` +
    `${row.status ?? "(status unchanged)"} for ${originalTransactionId} (${environment})`,
  );
  return new Response("OK", { status: 200 });
});
