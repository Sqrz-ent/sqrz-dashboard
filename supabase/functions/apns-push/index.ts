import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";

// ─────────────────────────────────────────────────────────────────────────────
// apns-push
//
// Sends an iOS push notification via Apple's APNs HTTP/2 API whenever a
// push_worthy `notifications` row is inserted. Triggered (fire-and-forget,
// async) by `on_notification_insert_apns_push` (AFTER INSERT ON notifications
// WHEN new.push_worthy = true) -> `trigger_apns_push()` -> this function.
// Guarded by the shared `push_sync_secret` from Vault (same PATTERN as
// meta_sync_secret gating meta-campaign-create/meta-adset-budget-sync, its own
// name/value so it isn't confusingly Meta-branded), injected as x-sync-secret
// by the trigger. Deploy verify_jwt:false (custom auth) — Postgres can't send
// a Supabase user JWT.
//
// APNs credentials (APNS_KEY = the .p8 key's PEM contents, APNS_KEY_ID,
// APNS_TEAM_ID) are edge-function environment secrets and are NOT set yet as
// of this pass — handled gracefully: logs a clear "APNs secrets not
// configured" message and returns 200 (not an error; the notification row
// itself is real, there's just nothing to push to until Phase 0 setup lands).
//
// Flow:
//   1. Load the notification row (type/subtype/related_id/deep_link/profile_id).
//   2. Look up profiles.apns_device_token for that profile. Null (push not
//      granted, or not yet registered) is a silent skip, not an error.
//   3. Build the alert text from type/subtype — mirrors sqrz-dashboard's own
//      NotificationList.tsx TYPE_META exactly, so a push always reads the same
//      as the in-app bell entry for the same row. Carries type/related_id/
//      deep_link as top-level custom payload data (APNs delivers any sibling
//      key of `aps` to the app as push userInfo) for iOS to route on tap.
//   4. Sign an ES256 JWT (APNs token-based provider auth) with the .p8 key via
//      `jose` — the same library apple-subscription-webhook already uses in
//      this Deno runtime, there for the reverse direction (verifying Apple's
//      JWS against the pinned Apple Root CA).
//   5. POST to Apple's APNs endpoint. Deno's fetch negotiates HTTP/2 over TLS
//      automatically (APNs requires HTTP/2; there's no HTTP/1.1 fallback) —
//      no special client needed.
//
// No retry/queue logic for this pass — one synchronous send, log failures,
// move on (no `apns-expiration` header set, so Apple's own infra won't retry
// an offline device either — consistent with "no retry" end to end).
// The signed auth token is cached in module scope for the lifetime of a warm
// isolate (Apple asks providers not to regenerate more than roughly once
// every 20 minutes) — best effort only, not guaranteed to survive between
// invocations, and harmless if it doesn't.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APNS_KEY = Deno.env.get("APNS_KEY");
const APNS_KEY_ID = Deno.env.get("APNS_KEY_ID");
const APNS_TEAM_ID = Deno.env.get("APNS_TEAM_ID");
// Matches apple-subscription-webhook's own default for the same app.
const APNS_BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "com.sqrz.ios";
const APNS_ENV = Deno.env.get("APNS_ENV") === "sandbox" ? "sandbox" : "production";
const APNS_HOST = APNS_ENV === "sandbox"
  ? "https://api.sandbox.push.apple.com"
  : "https://api.push.apple.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Temporary diagnostic (2026-08-08): confirms which host this isolate is
// actually sending to on cold start — persistent InvalidProviderToken after
// 3 secret re-sets, need to rule out a stale/misconfigured APNS_ENV rather
// than guess. Safe to leave — no secret material. Remove once resolved.
console.log("[apns-push] cold start — APNS_ENV:", APNS_ENV, "APNS_HOST:", APNS_HOST, "APNS_BUNDLE_ID:", APNS_BUNDLE_ID);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Alert copy — MUST stay in sync by hand with
// sqrz-dashboard/app/components/NotificationList.tsx's TYPE_META. There's no
// shared package between the Node web app and this Deno function, so a
// change to one needs the same change made here.
const TYPE_META: Record<string, (subtype: string | null) => string> = {
  campaign_status: (s) => `Campaign update${s ? ` — ${s.replace(/_/g, " ")}` : ""}`,
  campaign_ended: (s) => `Campaign ended${s ? ` — ${s.replace(/_/g, " ")}` : ""}`,
  booking: (s) =>
    s === "requested" ? "New booking request"
    : s === "confirmed" ? "Booking confirmed"
    : s === "cancelled" ? "Booking cancelled"
    : `Booking update${s ? ` — ${s}` : ""}`,
  advisor_warning: () => "Advisor alert — campaign needs attention",
  chat_request: () => "New inquiry",
};

function alertText(type: string, subtype: string | null): string {
  const build = TYPE_META[type];
  return build ? build(subtype) : "SQRZ notification";
}

// ── APNs auth token (ES256 JWT, token-based provider auth) ────────────────────
let cachedToken: { token: string; issuedAt: number } | null = null;
const TOKEN_MAX_AGE_MS = 55 * 60 * 1000; // reissue comfortably inside Apple's 1hr max

async function getApnsAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedToken.issuedAt < TOKEN_MAX_AGE_MS) {
    // Temporary diagnostic (2026-08-08): see note above getApnsAuthToken's
    // fresh-sign branch — remove alongside it once resolved.
    console.log("[apns-push] using cached JWT, issued", Math.round((now - cachedToken.issuedAt) / 1000), "s ago");
    return cachedToken.token;
  }
  const header = { alg: "ES256" as const, kid: APNS_KEY_ID! };
  const iatSeconds = Math.floor(now / 1000);
  const claims = { iss: APNS_TEAM_ID!, iat: iatSeconds };
  // Temporary diagnostic (2026-08-08): header + claims only, NEVER the
  // signature or APNS_KEY itself — logging exactly what's about to be signed
  // and sent to Apple, to debug a persistent InvalidProviderToken that
  // survived 3 independent secret re-sets with an identical error each time.
  // Remove once resolved.
  console.log("[apns-push] signing fresh JWT — header:", JSON.stringify(header), "claims:", JSON.stringify(claims), "APNS_HOST:", APNS_HOST);
  const key = await importPKCS8(APNS_KEY!, "ES256");
  const token = await new SignJWT({})
    .setProtectedHeader(header)
    .setIssuer(claims.iss)
    .setIssuedAt(claims.iat)
    .sign(key);
  cachedToken = { token, issuedAt: now };
  return token;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Auth: shared secret from Vault (same pattern as meta-campaign-create).
  const provided = req.headers.get("x-sync-secret") ?? "";
  const { data: expected, error: secretErr } = await supabase.rpc("get_push_sync_secret");
  if (secretErr || !expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  let notificationId: string;
  try {
    const payload = await req.json();
    notificationId = payload.notification_id as string;
    if (!notificationId) throw new Error("missing notification_id");
  } catch {
    return json({ error: "invalid payload" }, 400);
  }

  // APNs credentials not configured yet (Phase 0 setup pending) — log clearly
  // and exit without error. The notification row is real; there's just
  // nothing to push to until the secrets are set.
  if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) {
    console.error(
      "[apns-push] APNs secrets not configured (APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID) — skipping push for notification",
      notificationId,
    );
    return json({ ok: true, skipped: "apns_not_configured" });
  }

  const { data: notification, error: notifErr } = await supabase
    .from("notifications")
    .select("id, profile_id, type, subtype, related_id, deep_link")
    .eq("id", notificationId)
    .maybeSingle();
  if (notifErr) {
    console.error("[apns-push] notification lookup error:", notifErr.message);
    return json({ error: `notification lookup: ${notifErr.message}` }, 500);
  }
  if (!notification) return json({ error: "notification not found" }, 404);

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("apns_device_token")
    .eq("id", notification.profile_id as string)
    .maybeSingle();
  if (profileErr) {
    console.error("[apns-push] profile lookup error:", profileErr.message);
    return json({ error: `profile lookup: ${profileErr.message}` }, 500);
  }

  const deviceToken = (profile?.apns_device_token as string | null) ?? null;
  if (!deviceToken) {
    // No token yet — push not granted, or not yet registered. Not an error.
    return json({ ok: true, skipped: "no_device_token" });
  }

  const type = notification.type as string;
  const subtype = notification.subtype as string | null;
  const alert = alertText(type, subtype);

  const apnsPayload = {
    aps: {
      alert: { title: "SQRZ", body: alert },
      sound: "default",
    },
    type,
    related_id: notification.related_id,
    deep_link: notification.deep_link,
  };

  let authToken: string;
  try {
    authToken = await getApnsAuthToken();
  } catch (err) {
    console.error("[apns-push] failed to sign APNs auth token:", err);
    return json({ error: "token signing failed" }, 500);
  }

  try {
    const res = await fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${authToken}`,
        "apns-topic": APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify(apnsPayload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[apns-push] APNs send failed:", res.status, body);
      // Temporary diagnostic (2026-08-08): the edge-function log viewer does
      // not reliably surface console.log output (confirmed twice now), but
      // net._http_response does capture this response body — so put the
      // non-sensitive diagnostic facts directly in the error payload instead
      // of relying on logs. Never the signature or APNS_KEY. Remove once
      // resolved.
      const keyRaw = APNS_KEY ?? "";
      return json({
        error: "apns send failed",
        status: res.status,
        body,
        diagnostic: {
          apns_env: APNS_ENV,
          apns_host: APNS_HOST,
          jwt_header: { alg: "ES256", kid: APNS_KEY_ID },
          jwt_claims: { iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
          key_id_len: (APNS_KEY_ID ?? "").length,
          key_id_trimmed_len: (APNS_KEY_ID ?? "").trim().length,
          team_id_len: (APNS_TEAM_ID ?? "").length,
          team_id_trimmed_len: (APNS_TEAM_ID ?? "").trim().length,
          key_len: keyRaw.length,
          key_trimmed_len: keyRaw.trim().length,
          key_starts_with_pem_header: keyRaw.trim().startsWith("-----BEGIN PRIVATE KEY-----"),
          key_ends_with_pem_footer: keyRaw.trim().endsWith("-----END PRIVATE KEY-----"),
          key_contains_literal_backslash_n: keyRaw.includes("\\n"),
          key_contains_real_newline: keyRaw.includes("\n"),
          key_line_count: keyRaw.split("\n").length,
        },
      }, 502);
    }
  } catch (err) {
    console.error("[apns-push] APNs fetch error:", err);
    return json({ error: "apns fetch error" }, 502);
  }

  return json({ ok: true, sent: true });
});
