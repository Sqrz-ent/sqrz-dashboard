import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Shared secret. Set in Supabase Edge Function secrets; passed by HubSpot as a
// ?secret= query param on the webhook URL (or an x-sqrz-secret header).
const WEBHOOK_SECRET = Deno.env.get("BOOST_WEBHOOK_SECRET") ?? "";

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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Fail closed: if the secret isn't configured, reject everything.
  if (!WEBHOOK_SECRET) {
    console.error("[deal-stage-webhook] BOOST_WEBHOOK_SECRET not set — rejecting all requests.");
    return new Response("Not configured", { status: 503 });
  }
  const provided =
    new URL(req.url).searchParams.get("secret") ?? req.headers.get("x-sqrz-secret") ?? "";
  if (provided !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
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
      .select("id, status, campaign_type")
      .eq("hubspot_deal_id", dealId)
      .maybeSingle();

    if (!campaign) {
      results.push({ dealId, skipped: "no campaign for deal" });
      continue;
    }
    if (campaign.campaign_type !== "boost") {
      results.push({ dealId, skipped: "not a boost campaign" });
      continue;
    }
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
