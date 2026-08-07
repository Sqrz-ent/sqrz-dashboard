import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-status-webhook
//
// Receives Meta's real ad DELIVERY status (effective_status) push events and
// propagates them into SQRZ as the single source of truth. Replaces the earlier
// "manual publish button" idea entirely — publishing happens in Meta Ads
// Manager, outside SQRZ; this is only the receiving end.
//
// On each effective_status change:
//   1. Verify the request is genuinely from Meta (X-Hub-Signature-256 HMAC of
//      the raw body with the app secret — same rigor as the Stripe webhook).
//   2. Resolve which boost_campaigns row the referenced object belongs to, by
//      matching the payload's ad / adset / campaign id against
//      meta_ad_id / meta_adset_id / meta_campaign_id.
//   3. Write the raw value into boost_campaigns.meta_delivery_status (a column
//      distinct from `status` = SQRZ workflow, and meta_sync_status = creation
//      state — three concepts, three columns, never conflated).
//   4. Map into EXISTING pipeline vocabulary (no new statuses invented):
//        ACTIVE                 -> status = 'live'
//        WITH_ISSUES / DISAPPROVED -> status = 'needs_changes'
//        PAUSED / CAMPAIGN_PAUSED / ADSET_PAUSED -> NO forced status change
//          (a manual pause in Ads Manager isn't "needs changes" — judgment call,
//           flagged in the task; revisit if it should behave differently)
//        every other effective_status (PENDING_REVIEW, IN_PROCESS, PREAPPROVED,
//          PENDING_BILLING_INFO, DELETED, ARCHIVED) -> NO forced status change.
//          These are transient / billing-fixable / lifecycle states, NOT clean
//          terminal rejections. The confirmed ad effective_status enum has no
//          value that cleanly means a terminal 'rejected' beyond DISAPPROVED,
//          which the spec deliberately treats as fixable (needs_changes) — so no
//          auto-'rejected' path is wired (never auto-set a destructive terminal
//          status from an ambiguous Meta value). See STATUS_MAP below.
//   5. Log a HubSpot Note on the linked deal (hubspot_deal_id) for EVERY change,
//      reusing hubspot-sync-campaign-budget's exact Note pattern (association
//      type 214, default-properties only).
//
// Deploy verify_jwt:false — Meta can't send a Supabase JWT; auth is the Meta
// signature (POST) / verify token (GET handshake) instead.
//
// Secrets (edge-function env):
//   META_APP_SECRET            — HMAC key for X-Hub-Signature-256 (fail closed if unset)
//   META_WEBHOOK_VERIFY_TOKEN  — echoed-challenge token for the GET handshake
//   HUBSPOT_TOKEN              — already configured (hubspot-sync-* functions use it)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — auto-injected
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN") ?? "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const META_WEBHOOK_VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") ?? "";

// HubSpot's default association type ID for Note -> Deal (HUBSPOT_DEFINED) —
// identical to hubspot-sync-campaign-budget.
const NOTE_TO_DEAL_ASSOCIATION_TYPE_ID = 214;

// Meta effective_status (confirmed against the Marketing API Ad reference) ->
// SQRZ pipeline vocabulary. Only these three values force a `status` change;
// null = record the raw delivery status + log the Note, but leave `status` as-is.
const STATUS_MAP: Record<string, string | null> = {
  ACTIVE: "live",
  WITH_ISSUES: "needs_changes",
  DISAPPROVED: "needs_changes",
  // Explicit "no forced change" — listed so the intent is obvious, not a gap:
  PAUSED: null,
  CAMPAIGN_PAUSED: null,
  ADSET_PAUSED: null,
  PENDING_REVIEW: null,
  IN_PROCESS: null,
  PREAPPROVED: null,
  PENDING_BILLING_INFO: null,
  DELETED: null,
  ARCHIVED: null,
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function text(body: string, status = 200): Response {
  return new Response(body, { status });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Signature verification (X-Hub-Signature-256: sha256=<hex hmac of raw body>) ─
// Meta signs the exact raw request bytes with the app secret. Constant-time hex
// compare, same fail-closed posture as the Stripe webhook.
async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!META_APP_SECRET) {
    console.error("[meta-status-webhook] META_APP_SECRET not set — rejecting (fail closed)");
    return false;
  }
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length).trim();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare (lengths must match first).
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ── Payload extraction ────────────────────────────────────────────────────────
// Meta's ad_account webhook payload shape for status fields isn't perfectly
// documented and has shifted across versions, so extract DEFENSIVELY rather than
// bind to one exact shape: from each entry[].changes[] pull whatever object id
// keys and status value are present. The full raw payload is logged so the first
// real event can be inspected and this narrowed if needed.
type ExtractedChange = {
  effectiveStatus: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
};

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function extractChanges(payload: unknown): ExtractedChange[] {
  const out: ExtractedChange[] = [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const field = (change as { field?: unknown }).field;
      const rawValue = (change as { value?: unknown }).value;
      // `value` may be an object ({ effective_status, ad_id, ... }) or, for a
      // field literally named effective_status, the status string itself.
      const valObj: Record<string, unknown> =
        rawValue && typeof rawValue === "object" ? (rawValue as Record<string, unknown>) : {};

      let effectiveStatus =
        pickString(valObj, ["effective_status", "status"]) ??
        (field === "effective_status" && typeof rawValue === "string" ? rawValue : null);
      if (effectiveStatus) effectiveStatus = effectiveStatus.toUpperCase();

      // Meta's naming is legacy-confusing: modern `ad`≈old `adgroup`, and modern
      // `campaign_id` = the TOP-LEVEL campaign (our meta_campaign_id), NOT the ad
      // set. Each id is looked up against its own column, so a misfiled id simply
      // won't match (never a false match), but bucket them correctly anyway.
      out.push({
        effectiveStatus,
        adId: pickString(valObj, ["ad_id", "adgroup_id", "ad_group_id"]),
        adsetId: pickString(valObj, ["adset_id", "ad_set_id"]),
        campaignId: pickString(valObj, ["campaign_id", "campaign_group_id", "adcampaign_group_id"]),
      });
    }
  }
  return out;
}

// ── HubSpot Note (same shape as hubspot-sync-campaign-budget) ──────────────────
async function logHubspotNote(dealId: string, noteBody: string): Promise<void> {
  if (!HUBSPOT_TOKEN) {
    console.error("[meta-status-webhook] HUBSPOT_TOKEN not set — skipping Note");
    return;
  }
  const now = new Date();
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { hs_note_body: noteBody, hs_timestamp: now.getTime() },
      associations: [
        {
          to: { id: dealId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: NOTE_TO_DEAL_ASSOCIATION_TYPE_ID,
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error("[meta-status-webhook] HubSpot note error:", res.status, await res.text());
  }
}

// ── Resolve the boost_campaigns row for a change ──────────────────────────────
async function resolveCampaign(change: ExtractedChange) {
  const attempts: Array<[string, string]> = [];
  if (change.adId) attempts.push(["meta_ad_id", change.adId]);
  if (change.adsetId) attempts.push(["meta_adset_id", change.adsetId]);
  if (change.campaignId) attempts.push(["meta_campaign_id", change.campaignId]);

  for (const [col, val] of attempts) {
    const { data, error } = await supabase
      .from("boost_campaigns")
      .select("id, status, hubspot_deal_id, meta_delivery_status")
      .eq(col, val)
      .maybeSingle();
    if (error) {
      console.error(`[meta-status-webhook] lookup on ${col} failed:`, error.message);
      continue;
    }
    if (data) return data;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── GET: Meta's subscription verification handshake ─────────────────────────
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && META_WEBHOOK_VERIFY_TOKEN && token === META_WEBHOOK_VERIFY_TOKEN) {
      return text(challenge ?? "", 200);
    }
    return text("Forbidden", 403);
  }

  if (req.method !== "POST") return text("Method not allowed", 405);

  // ── POST: verify signature against the RAW body, then process ───────────────
  const rawBody = await req.text();
  const ok = await verifySignature(rawBody, req.headers.get("x-hub-signature-256"));
  if (!ok) {
    console.error("[meta-status-webhook] signature verification failed");
    return text("Invalid signature", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return text("Invalid JSON", 400);
  }

  const changes = extractChanges(payload);
  // Always log the raw payload once — the first real event is how we confirm
  // Meta's exact shape and narrow extractChanges() if it ever needs it.
  console.log(
    "[meta-status-webhook] received:",
    JSON.stringify(payload),
    "| extracted:",
    JSON.stringify(changes),
  );

  const results: unknown[] = [];
  for (const change of changes) {
    if (!change.effectiveStatus) {
      results.push({ skipped: "no effective_status in change" });
      continue;
    }
    const campaign = await resolveCampaign(change);
    if (!campaign) {
      // Not one of our campaigns (or the ids don't match a row) — ack, don't error.
      results.push({ effective_status: change.effectiveStatus, skipped: "no matching campaign" });
      continue;
    }

    const effective = change.effectiveStatus;
    // `undefined` = a status value not in our enum map (log it, change nothing);
    // `null` = a known status we deliberately don't act on; string = new status.
    const mapped = STATUS_MAP[effective];
    const update: Record<string, unknown> = { meta_delivery_status: effective };
    if (typeof mapped === "string" && mapped !== campaign.status) {
      update.status = mapped;
      update.status_updated_at = new Date().toISOString();
    }

    const { error: updErr } = await supabase
      .from("boost_campaigns")
      .update(update)
      .eq("id", campaign.id);
    if (updErr) {
      console.error("[meta-status-webhook] update failed:", updErr.message);
      results.push({ campaign_id: campaign.id, error: updErr.message });
      continue;
    }

    // HubSpot Note on every change (only when there's a linked deal).
    if (campaign.hubspot_deal_id) {
      const line = `Meta delivery status changed to ${effective}`;
      const statusLine =
        typeof mapped === "string" && mapped !== campaign.status
          ? `\nSQRZ status → ${mapped}`
          : typeof mapped === "undefined"
            ? `\n(unmapped Meta status — SQRZ status unchanged)`
            : `\n(SQRZ status unchanged)`;
      await logHubspotNote(
        campaign.hubspot_deal_id as string,
        `${line}${statusLine}\nAt: ${new Date().toISOString()}`,
      );
    }

    results.push({
      campaign_id: campaign.id,
      meta_delivery_status: effective,
      status: typeof mapped === "string" ? mapped : campaign.status,
    });
  }

  // Always 200 on a verified request so Meta doesn't retry indefinitely for
  // events about campaigns that aren't ours.
  return json({ ok: true, processed: results });
});
