import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// hubspot-sync-campaign-budget
//
// Keeps a boost_campaign's linked HubSpot deal current with the ALLOCATION-
// driven budget, at every allocation event — not just once at campaign
// creation (that's hubspot-sync-deal, which no longer touches `amount` as of
// this pass; see its own header comment).
//
// Triggered by `on_wallet_ledger_entry_insert_hubspot_sync` (2026-08-03
// migration) on any wallet_ledger_entries INSERT with entry_type IN
// ('allocation','deallocation') and a non-null campaign_id — i.e. every event
// that changes a campaign's campaign_budgets.allocated_cents: an initial
// allocation, a deallocation, or a reallocation (which is one deallocation row
// on the source campaign + one allocation row on the destination campaign, so
// both campaigns' deals get their own sync call). Reactivation itself doesn't
// insert a wallet_ledger_entries row — it just flips campaign_budgets.status
// exhausted→active so allocation is allowed again — so it has no direct sync
// step here; the allocation the user makes AFTER reactivating is what fires
// this, same as any other allocation.
//
// For each event: PATCH the deal's `amount` (default property) to the
// campaign's current allocated_cents running total, and create a Note
// (HubSpot's native activity-timeline engagement) recording this specific
// event's amount + the new running total, associated to the deal.
//
// No custom `sqrz_budget_allocated` property — HubSpot's plan doesn't allow
// custom deal properties (see hubspot-sync-deal's header comment / commits
// ccfa33a, e6a5b1a, 2026-07-08, which dropped all sqrz_* custom properties for
// exactly this reason). Confirmed with the user before building this: `amount`
// carries the running total instead, same default-properties-only approach
// hubspot-sync-deal already uses.
// ─────────────────────────────────────────────────────────────────────────────

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// HubSpot's default association type ID for Note → Deal (HUBSPOT_DEFINED).
const NOTE_TO_DEAL_ASSOCIATION_TYPE_ID = 214;

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

  const { record } = payload;
  const campaignId = record.campaign_id as string | null;
  const entryType = record.entry_type as string; // 'allocation' | 'deallocation'
  // Signed: 'allocation' entries are NEGATIVE (wallet decreased), 'deallocation'
  // entries are POSITIVE (wallet increased) — see apply_wallet_ledger_entry.
  const eventAmountCents = Number(record.amount_cents ?? 0);

  if (!campaignId) {
    return new Response("No campaign_id on this entry — skipping", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: campaign, error: campaignErr } = await supabase
    .from("boost_campaigns")
    .select("id, hubspot_deal_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignErr) {
    console.error("[hubspot-sync-campaign-budget] campaign lookup error:", campaignErr.message);
    return new Response(`campaign lookup: ${campaignErr.message}`, { status: 500 });
  }

  const dealId = campaign?.hubspot_deal_id as string | null;
  if (!dealId) {
    // No deal yet (hubspot-sync-deal hasn't created one, or this campaign
    // predates the deal sync) — nothing to update. Not an error.
    return new Response("Campaign has no linked HubSpot deal — skipping", { status: 200 });
  }

  // Running total = the campaign's CURRENT allocated_cents, read fresh rather
  // than derived from this one event — correct regardless of delivery timing
  // (net.http_post queues the request; by the time it's actually delivered,
  // the enclosing transaction — including apply_wallet_ledger_entry's update
  // to campaign_budgets — has already committed).
  const { data: budget, error: budgetErr } = await supabase
    .from("campaign_budgets")
    .select("allocated_cents")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (budgetErr) {
    console.error("[hubspot-sync-campaign-budget] budget lookup error:", budgetErr.message);
    return new Response(`budget lookup: ${budgetErr.message}`, { status: 500 });
  }

  const runningTotalCents = Number(budget?.allocated_cents ?? 0);
  const runningTotal = (runningTotalCents / 100).toFixed(2);

  const dealRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { amount: runningTotal } }),
  });
  if (!dealRes.ok) {
    const err = await dealRes.text();
    console.error("[hubspot-sync-campaign-budget] deal amount update error:", dealRes.status, err);
    return new Response(`HubSpot deal error: ${err}`, { status: 500 });
  }

  const eventAmount = (Math.abs(eventAmountCents) / 100).toFixed(2);
  const eventLabel = entryType === "deallocation"
    ? `-$${eventAmount} returned to wallet`
    : `+$${eventAmount} allocated`;
  const eventTimestamp = (record.created_at as string) ?? new Date().toISOString();

  const noteBody = [
    eventLabel,
    `Running total allocated: $${runningTotal}`,
    `At: ${eventTimestamp}`,
  ].join("\n");

  const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        hs_note_body: noteBody,
        hs_timestamp: new Date(eventTimestamp).getTime(),
      },
      associations: [
        {
          to: { id: dealId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL_ASSOCIATION_TYPE_ID }],
        },
      ],
    }),
  });
  if (!noteRes.ok) {
    const err = await noteRes.text();
    console.error("[hubspot-sync-campaign-budget] note create error:", noteRes.status, err);
    return new Response(`HubSpot note error: ${err}`, { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, hubspot_deal_id: dealId, running_total: runningTotal }),
    { headers: { "Content-Type": "application/json" } },
  );
});
