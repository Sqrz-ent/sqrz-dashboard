import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — HubSpot "Boost Campaigns" pipeline.
//
// HubSpot plan no longer allows custom deal properties, so this syncs default
// properties only. Campaign status is carried by `dealstage` on this dedicated
// pipeline. Values are the pipeline + stage INTERNAL IDs (not display labels),
// from HubSpot → Settings → Objects → Deals → Pipelines → "Boost Campaigns".
// ─────────────────────────────────────────────────────────────────────────────
const BOOST_PIPELINE_ID = "916004525";
const BOOST_STAGE_IDS: Record<string, string> = {
  booked:        "1396005686",
  in_review:     "1396005687",
  needs_changes: "1396005688",
  approved:      "1396005689",
  live:          "1396005690",
  completed:     "1396005691",
  rejected:      "1396005692",
};

const GOAL_LABELS: Record<string, string> = {
  bookings: "Bookings",
  visibility: "Visibility",
  audience: "Audience",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: { type: string; record: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { type, record } = payload;

  if (type !== "INSERT" && type !== "UPDATE") {
    return new Response("Ignored", { status: 200 });
  }

  // Boost only — Grow is fully manual and must not sync as a deal.
  const campaignType = (record.campaign_type as string) ?? "boost";
  if (campaignType !== "boost") {
    return new Response("Not a boost campaign — skipping", { status: 200 });
  }

  // Only sync once the campaign has a status that maps to a pipeline stage
  // (a paid booking onward). Unpaid boosts have null status → nothing to sync.
  const status = (record.status as string) ?? "";
  const dealStage = BOOST_STAGE_IDS[status];
  if (!dealStage) {
    return new Response(`No pipeline stage for status '${status}' — skipping`, { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Owner profile — for the artist name + contact association.
  const { data: profile } = await supabase
    .from("profiles")
    .select("hubspot_contact_id, brand_name, name, first_name, last_name, slug")
    .eq("id", record.profile_id as string)
    .single();

  const artistName =
    (profile?.brand_name as string) ||
    (profile?.name as string) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    (profile?.slug as string) ||
    "Unknown";

  const goalRaw = (record.goal as string) ?? "";
  const goalLabel = GOAL_LABELS[goalRaw] ?? goalRaw;

  const dealName = ["Boost", artistName, goalLabel].filter(Boolean).join(" — ");

  // Plain-text description — a human-readable reference block (no custom props).
  const descriptionLines = [
    record.channel ? `Channel: ${record.channel}` : null,
    record.target_audience ? `Target audience: ${record.target_audience}` : null,
    record.notes ? `Notes: ${record.notes}` : null,
    record.creative_asset_url ? `Creative: ${record.creative_asset_url}` : null,
    `SQRZ Campaign ID: ${record.id}`,
  ].filter(Boolean);
  const description = descriptionLines.join("\n");

  // Default HubSpot deal properties only.
  const dealProperties: Record<string, string | number> = {
    dealname: dealName,
    dealstage: dealStage,
    pipeline: BOOST_PIPELINE_ID,
    amount: record.budget_amount ? Number(record.budget_amount) : 0,
    deal_currency_code: ((record.budget_currency as string) ?? "USD").toUpperCase(),
    description,
  };
  // Terminal stages (completed / rejected) want a close date.
  if (status === "completed" || status === "rejected") {
    const ts = (record.completed_at as string) || (record.status_updated_at as string) || (record.created_at as string);
    if (ts) dealProperties.closedate = new Date(ts).toISOString();
  }

  const existingDealId = record.hubspot_deal_id as string | null;
  let hubspotDealId = existingDealId;
  let hsRes: Response;

  if (existingDealId) {
    hsRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${existingDealId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: dealProperties }),
    });
  } else {
    hsRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: dealProperties }),
    });
  }

  if (!hsRes.ok) {
    const err = await hsRes.text();
    console.error("[hubspot-sync-deal] HubSpot error:", hsRes.status, err);
    return new Response(`HubSpot deal error: ${err}`, { status: 500 });
  }

  const hsData = await hsRes.json();
  hubspotDealId = hubspotDealId ?? hsData.id;

  // Write the deal ID back + associate with the artist's contact (first create only).
  if (hubspotDealId && !existingDealId) {
    await supabase
      .from("boost_campaigns")
      .update({ hubspot_deal_id: hubspotDealId })
      .eq("id", record.id as string);

    // Contact association is unaffected by the custom-property change — still
    // uses profiles.hubspot_contact_id via the default deal↔contact association.
    if (profile?.hubspot_contact_id) {
      await fetch(
        `https://api.hubapi.com/crm/v4/objects/deals/${hubspotDealId}/associations/contacts/${profile.hubspot_contact_id}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }]),
        }
      );
    }
  }

  return new Response(JSON.stringify({ ok: true, hubspot_deal_id: hubspotDealId }), {
    headers: { "Content-Type": "application/json" },
  });
});
