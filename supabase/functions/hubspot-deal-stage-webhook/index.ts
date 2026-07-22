import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Shared secret for the fallback (workflow-webhook) auth path. Supplied by HubSpot
// as the PASSWORD half of HTTP Basic Auth (`Authorization: Basic <base64>`) — never
// a query param, which would leak into access/proxy logs and Referer headers.
// HubSpot's native workflow webhook action supports only Basic Auth, not custom
// headers.
const WEBHOOK_SECRET = Deno.env.get("BOOST_WEBHOOK_SECRET") ?? "";
// HubSpot app CLIENT SECRET, used to verify X-HubSpot-Signature-v3. This is the
// app's client secret — distinct from HUBSPOT_TOKEN (a private-app access token)
// and from BOOST_WEBHOOK_SECRET. When set, v3 signature validation is REQUIRED and
// the shared-secret path is disabled (v3 authenticates the request truly came from
// HubSpot, so it fully supersedes the shared secret).
const HUBSPOT_APP_SECRET = Deno.env.get("HUBSPOT_APP_SECRET") ?? "";

// Reverse of BOOST_STAGE_IDS in hubspot-sync-deal — "Boost Campaigns" pipeline
// (916004525) stage internal IDs → boost_campaigns.status. KEEP IN SYNC with the
// forward map. (Two independently-deployed edge functions can't cleanly share a
// module via the deploy tooling, so this 7-line constant is intentionally
// mirrored; the pipeline/stage IDs are stable HubSpot config.)
const STAGE_ID_TO_STATUS: Record<string, string> = {
  "1396005686": "booked",
  "1396005687": "in_review",
  "1396005688": "needs_changes",
  "1396005689": "approved",
  "1396005690": "live",
  "1396005691": "completed",
  "1396005692": "rejected",
};

type StageEvent = { dealId: string; stageId: string };

// Tolerant of the two HubSpot shapes Will might configure:
//  - Private App property-change webhook: array of
//    { objectId, propertyName: "dealstage", propertyValue: "<stageId>" }
//  - Workflow "send webhook" / custom: object with objectId + dealstage
//    (possibly nested under properties.dealstage.value).
function extractEvents(body: unknown): StageEvent[] {
  const out: StageEvent[] = [];
  const push = (dealId: unknown, stageId: unknown) => {
    if (dealId != null && stageId != null && String(stageId).length > 0) {
      out.push({ dealId: String(dealId), stageId: String(stageId) });
    }
  };

  if (Array.isArray(body)) {
    for (const ev of body) {
      if (ev && typeof ev === "object") {
        const e = ev as Record<string, unknown>;
        if (e.propertyName === "dealstage") push(e.objectId ?? e.hs_object_id, e.propertyValue);
      }
    }
    return out;
  }

  if (body && typeof body === "object") {
    const e = body as Record<string, unknown>;
    const props = (e.properties ?? {}) as Record<string, unknown>;
    const nestedStage = props.dealstage as { value?: unknown } | string | undefined;
    const dealId =
      e.objectId ?? e.dealId ?? e.hs_object_id ??
      (props.hs_object_id as { value?: unknown } | string | undefined);
    const stageId =
      e.dealstage ?? e.propertyValue ??
      (typeof nestedStage === "object" ? nestedStage?.value : nestedStage);
    const unwrap = (v: unknown) =>
      v && typeof v === "object" && "value" in (v as Record<string, unknown>)
        ? (v as Record<string, unknown>).value
        : v;
    push(unwrap(dealId), stageId);
  }

  return out;
}

// ─── Request authentication helpers ──────────────────────────────────────────

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

// Constant-time string equality. Both sides are SHA-256'd to a fixed 32-byte
// digest first (so input length never leaks and timingSafeEqual never throws on a
// length mismatch), then compared with node's vetted timing-safe primitive.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return timingSafeEqual(Buffer.from(da), Buffer.from(db));
}

// Base64 HMAC-SHA256, matching HubSpot's v3 signature construction.
async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Validate HubSpot's X-HubSpot-Signature-v3 header. Source string =
// requestMethod + requestUri + requestBody + timestamp (no separators);
// HMAC-SHA256 keyed with the app client secret; base64; reject if the
// X-HubSpot-Request-Timestamp header is older than 5 minutes.
// https://developers.hubspot.com/docs/guides/apps/authentication/validating-requests
async function verifyHubspotV3(req: Request, rawBody: string, appSecret: string): Promise<boolean> {
  const signature = req.headers.get("x-hubspot-signature-v3");
  const timestamp = req.headers.get("x-hubspot-request-timestamp");
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Date.now() - ts > 5 * 60 * 1000) return false;

  // requestUri must be the full original URL (protocol + host + path + query),
  // exactly as HubSpot saw it. NOTE: if the Supabase edge proxy rewrites host or
  // protocol, req.url may not match what HubSpot signed — see report caveat.
  const source = `POST${req.url}${rawBody}${timestamp}`;
  const expected = await hmacSha256Base64(appSecret, source);
  return constantTimeEqual(expected, signature);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Fail closed: at least one auth mechanism must be configured.
  if (!HUBSPOT_APP_SECRET && !WEBHOOK_SECRET) {
    console.error("[deal-stage-webhook] No auth configured (HUBSPOT_APP_SECRET / BOOST_WEBHOOK_SECRET) — rejecting all requests.");
    return new Response("Not configured", { status: 503 });
  }

  // Read the raw body ONCE — required verbatim for v3 signature verification
  // (a re-serialized JSON body would not match HubSpot's HMAC).
  const rawBody = await req.text();

  // Preferred: HubSpot v3 signature, which authenticates that the request truly
  // came from HubSpot. When the app secret is configured, v3 is REQUIRED and the
  // shared-secret path is disabled. Otherwise fall back to the shared secret
  // supplied as the Basic Auth password, constant-time compared.
  if (HUBSPOT_APP_SECRET) {
    if (!(await verifyHubspotV3(req, rawBody, HUBSPOT_APP_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    // Fallback (workflow-webhook) path: HubSpot's native webhook action supports
    // only HTTP Basic Auth (no custom headers). Parse `Authorization: Basic <b64>`,
    // decode, split on the first ":", and constant-time compare the PASSWORD half
    // against the shared secret. The username is ignored (enter any value on the
    // HubSpot side, e.g. "sqrz").
    const authHeader = req.headers.get("authorization") ?? "";
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme?.toLowerCase() !== "basic" || !encoded) {
      return new Response("Unauthorized", { status: 401 });
    }
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const idx = decoded.indexOf(":");
    if (idx === -1) {
      return new Response("Unauthorized", { status: 401 });
    }
    const password = decoded.slice(idx + 1);
    if (!password || !(await constantTimeEqual(password, WEBHOOK_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const events = extractEvents(body);
  if (events.length === 0) {
    return new Response("No dealstage events found — ignored", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const results: Record<string, unknown>[] = [];

  for (const { dealId, stageId } of events) {
    const status = STAGE_ID_TO_STATUS[stageId];
    // Not a Boost Campaigns pipeline stage (e.g. an unrelated deal) — ignore.
    if (!status) {
      results.push({ dealId, stageId, skipped: "unmapped stage" });
      continue;
    }

    const { data: campaign } = await supabase
      .from("boost_campaigns")
      .select("id, status")
      .eq("hubspot_deal_id", dealId)
      .maybeSingle();

    if (!campaign) {
      results.push({ dealId, skipped: "no campaign for deal" });
      continue;
    }
    // Both Boost and Grow reverse-sync — a stage move in the shared pipeline
    // updates the campaign status either way (grow status is unconstrained).
    // Loop guard: already at the mapped status → skip (avoids a redundant
    // forward PATCH). The forward sync is itself a stage no-op when unchanged,
    // so this is belt-and-suspenders, not the sole protection.
    if (campaign.status === status) {
      results.push({ dealId, status, skipped: "unchanged" });
      continue;
    }

    const { error } = await supabase
      .from("boost_campaigns")
      .update({ status, status_updated_at: new Date().toISOString() })
      .eq("id", campaign.id as string);
    results.push({ dealId, status, updated: !error, ...(error ? { error: error.message } : {}) });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
