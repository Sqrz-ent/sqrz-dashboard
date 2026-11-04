import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// support-chat-webhook
//
// Receives Stream Chat's `message.new` webhook (fired for every channel in
// this Stream app) and pushes a notification whenever a message lands in a
// support-chat channel — one created by app/lib/messaging/support.server.ts
// as `support_<campaign_id>`, custom channel data
// { kind: "support", campaign_id, profile_id, template_id }. Every other
// channel (inquiry threads, anything else) is ignored.
//
// Direction of the push:
//   - sender id starts with "profile_" (the customer — toStreamUserIdForProfile)
//       -> push EVERY Lab account's own profile (accounts.is_lab = true):
//          the whole team should know a new support message came in.
//   - sender id starts with "team_" (a Lab team member — toStreamUserIdForTeamAccount)
//       -> push only the customer profile's owner (the channel's profile_id).
//   - anything else (notably the server's own two intro "system" messages
//     posted at thread creation, which have no real sender) -> no push.
//
// Reuses the EXISTING push pipeline exactly as-is: this function only ever
// inserts a row into `notifications` (push_worthy: true) — the already-live
// on_notification_insert_apns_push trigger fires apns-push automatically,
// same as every other notification type. type = "support_message" (push
// title "New message" — added to apns-push's TYPE_META alongside this
// function). NOT YET in notifications_type_check — see
// supabase/migrations/..._support_message_notification_type.sql (written,
// not applied, per the task that added this function). Until that migration
// runs, every insert below fails with a check-constraint violation; those
// failures are caught and logged, never allowed to affect the webhook's own
// response (the Stream message itself already sent successfully by the time
// this webhook fires — a failed push notification must never look like a
// failed chat message).
//
// Auth: Stream signs every webhook POST with `X-Signature` — hex HMAC-SHA256
// of the raw request body, keyed with the Stream API secret
// (STREAM_API_SECRET) — same fail-closed verification shape as
// meta-status-webhook's X-Hub-Signature-256. Deploy verify_jwt:false (Stream
// can't send a Supabase JWT).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STREAM_API_SECRET = Deno.env.get("STREAM_API_SECRET") ?? "";

const SUPPORT_MESSAGE_TYPE = "support_message";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Signature verification (X-Signature: hex HMAC-SHA256 of the raw body) ───
async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!STREAM_API_SECRET) {
    console.error("[support-chat-webhook] STREAM_API_SECRET not set — rejecting (fail closed)");
    return false;
  }
  if (!header) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STREAM_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare (lengths must match first).
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function supportThreadDeepLink(campaignId: string): string {
  return `/grow/campaigns/${campaignId}`;
}

// The customer sent a message -> every Lab account's own profile gets notified.
async function pushToLabAccounts(campaignId: string): Promise<void> {
  const { data: labAccounts, error: labErr } = await supabase
    .from("accounts")
    .select("id")
    .eq("is_lab", true);
  if (labErr) {
    console.error("[support-chat-webhook] lab accounts lookup failed:", labErr.message);
    return;
  }
  const labAccountIds = (labAccounts ?? []).map((a) => a.id as string);
  if (!labAccountIds.length) return;

  const { data: labProfiles, error: profilesErr } = await supabase
    .from("profiles")
    .select("id")
    .in("account_id", labAccountIds);
  if (profilesErr) {
    console.error("[support-chat-webhook] lab profiles lookup failed:", profilesErr.message);
    return;
  }
  const rows = (labProfiles ?? []).map((p) => ({
    profile_id: p.id as string,
    type: SUPPORT_MESSAGE_TYPE,
    related_id: campaignId,
    deep_link: supportThreadDeepLink(campaignId),
    push_worthy: true,
  }));
  if (!rows.length) return;

  const { error: insertErr } = await supabase.from("notifications").insert(rows);
  if (insertErr) {
    console.error("[support-chat-webhook] notify lab accounts failed:", insertErr.message);
  }
}

// A team member replied -> only the customer profile (the request's own
// profile_id) gets notified.
async function pushToCustomer(profileId: string, campaignId: string): Promise<void> {
  const { error } = await supabase.from("notifications").insert({
    profile_id: profileId,
    type: SUPPORT_MESSAGE_TYPE,
    related_id: campaignId,
    deep_link: supportThreadDeepLink(campaignId),
    push_worthy: true,
  });
  if (error) {
    console.error("[support-chat-webhook] notify customer failed:", error.message);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const rawBody = await req.text();
  if (!(await verifySignature(rawBody, req.headers.get("x-signature")))) {
    return json({ error: "invalid signature" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (body.type !== "message.new") {
    return json({ ok: true, skipped: "not_message_new" });
  }

  const channel = (body.channel ?? {}) as Record<string, unknown>;
  if (channel.kind !== "support") {
    return json({ ok: true, skipped: "not_support_channel" });
  }

  const campaignId = typeof channel.campaign_id === "string" ? channel.campaign_id : null;
  const profileId = typeof channel.profile_id === "string" ? channel.profile_id : null;
  if (!campaignId || !profileId) {
    console.error(
      "[support-chat-webhook] support channel missing campaign_id/profile_id:",
      channel.id,
    );
    return json({ ok: true, skipped: "missing_channel_data" });
  }

  const message = (body.message ?? {}) as Record<string, unknown>;
  const topLevelUser = (body.user ?? {}) as Record<string, unknown>;
  const messageUser = (message.user ?? {}) as Record<string, unknown>;
  const senderId = String(topLevelUser.id ?? messageUser.id ?? "");

  if (senderId.startsWith("profile_")) {
    await pushToLabAccounts(campaignId);
  } else if (senderId.startsWith("team_")) {
    await pushToCustomer(profileId, campaignId);
  }
  // Any other sender (notably the server's own intro system messages, which
  // have no real sender) -> no push, by design.

  return json({ ok: true });
});
