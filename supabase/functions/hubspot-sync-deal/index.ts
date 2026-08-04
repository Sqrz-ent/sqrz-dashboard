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

  let payload: { type: string; record: { id?: string } };
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { type } = payload;
  const campaignId = payload.record?.id;

  if (type !== "INSERT" && type !== "UPDATE") {
    return new Response("Ignored", { status: 200 });
  }
  if (!campaignId) {
    return new Response("No campaign id in payload — skipping", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Re-fetch the current COMMITTED row rather than trusting the trigger
  // payload — net.http_post is async/queued, so by the time this call is
  // actually delivered, a later write (including this campaign's own
  // hubspot_deal_id write-back from a still-in-flight earlier invocation) may
  // already have landed. Deciding create-vs-patch off a stale snapshot is
  // exactly what let rapid-fire/concurrent invocations each independently
  // conclude "no deal yet" and each create a duplicate — see this function's
  // migration header (20260804_fix_hubspot_deal_sync_duplication.sql) for the
  // confirmed incident this fixes.
  const { data: campaign, error: campaignErr } = await supabase
    .from("boost_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignErr) {
    console.error("[hubspot-sync-deal] campaign lookup error:", campaignErr.message);
    return new Response(`campaign lookup: ${campaignErr.message}`, { status: 500 });
  }
  if (!campaign) {
    return new Response("Campaign not found — skipping", { status: 200 });
  }

  // Both Boost and Grow sync as deals in the same "Boost Campaigns" pipeline
  // (unified visibility). The status→stage gate below still limits this to paid
  // campaigns (booked onward). Grow ad execution stays fully manual.
  const campaignType = (campaign.campaign_type as string) ?? "boost";
  const isGrow = campaignType === "grow";

  // Only sync once the campaign has a status that maps to a pipeline stage
  // (a paid booking onward). Unpaid boosts have null status → nothing to sync.
  const status = (campaign.status as string) ?? "";
  const dealStage = BOOST_STAGE_IDS[status];
  if (!dealStage) {
    return new Response(`No pipeline stage for status '${status}' — skipping`, { status: 200 });
  }

  // Owner profile — for the artist name + contact association.
  const { data: profile } = await supabase
    .from("profiles")
    .select("hubspot_contact_id, brand_name, name, first_name, last_name, slug")
    .eq("id", campaign.profile_id as string)
    .single();

  const artistName =
    (profile?.brand_name as string) ||
    (profile?.name as string) ||
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    (profile?.slug as string) ||
    "Unknown";

  const goalRaw = (campaign.goal as string) ?? "";
  const goalLabel = GOAL_LABELS[goalRaw] ?? goalRaw;

  // Campaign naming became required at creation 2026-08-03, so prefer the
  // user's own name for dealname — falls back to the old composed
  // "Boost/Grow — artist — goal" name for legacy rows that predate it
  // (name null/blank), so nothing breaks on those.
  const campaignName = (campaign.name as string | null)?.trim();
  const dealName = campaignName
    ? campaignName
    : [isGrow ? "Grow" : "Boost", artistName, goalLabel].filter(Boolean).join(" — ");

  // Plain-text description — a human-readable reference block (no custom props).
  const channelList = Array.isArray(campaign.channels) ? (campaign.channels as string[]) : [];
  const channelText = channelList.length ? channelList.join(", ") : (campaign.channel as string | null) ?? "";
  const descriptionLines = [
    isGrow
      ? "Pricing: Grow — 20% management fee on ad spend"
      : "Pricing: Boost — flat activation fee + ad spend",
    channelText ? `Channels: ${channelText}` : null,
    (campaign.starts_at && campaign.ends_at) ? `Campaign dates: ${campaign.starts_at} – ${campaign.ends_at}` : null,
    campaign.target_audience ? `Target audience: ${campaign.target_audience}` : null,
    campaign.notes ? `Notes: ${campaign.notes}` : null,
    campaign.creative_asset_url ? `Creative: ${campaign.creative_asset_url}` : null,
    `SQRZ Campaign ID: ${campaign.id}`,
  ].filter(Boolean);
  const description = descriptionLines.join("\n");

  // Default HubSpot deal properties only.
  //
  // `amount` is deliberately NOT set here (2026-08-03) — pricing moved to the
  // wallet allocation flow, so budget_amount is never populated at creation
  // anymore and writing it here would permanently stale `amount` at 0 (or
  // worse, CLOBBER the allocation-driven running total on every unrelated
  // boost_campaigns update). hubspot-sync-campaign-budget owns `amount` now,
  // updating it at every allocation event instead — see that function's
  // header comment.
  const dealProperties: Record<string, string | number> = {
    dealname: dealName,
    dealstage: dealStage,
    pipeline: BOOST_PIPELINE_ID,
    deal_currency_code: ((campaign.budget_currency as string) ?? "USD").toUpperCase(),
    description,
  };
  // closedate = campaign end date (default property) so deals are sortable and
  // filterable by when the campaign ends, directly in HubSpot views.
  if (campaign.ends_at) {
    dealProperties.closedate = new Date(campaign.ends_at as string).toISOString();
  }

  const existingDealId = campaign.hubspot_deal_id as string | null;

  // ── Existing deal: PATCH only. Idempotent by construction — applying the
  // same properties twice (e.g. two near-simultaneous invocations both PATCHing)
  // is harmless, no synchronization needed on this branch.
  if (existingDealId) {
    const hsRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${existingDealId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: dealProperties }),
    });
    if (!hsRes.ok) {
      const err = await hsRes.text();
      console.error("[hubspot-sync-deal] HubSpot PATCH error:", hsRes.status, err);
      return new Response(`HubSpot deal error: ${err}`, { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, hubspot_deal_id: existingDealId }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── No deal yet: atomic claim before creating.
  //
  // This is the actual fix for the duplication bug — a conditional UPDATE with
  // WHERE hubspot_deal_id IS NULL AND hubspot_sync_status IS NULL is evaluated
  // atomically by Postgres against the row's live state at UPDATE time
  // (regardless of what our SELECT above saw), so if two invocations race here,
  // exactly one of these UPDATEs can ever match and succeed — the other affects
  // 0 rows and yields. This makes "at most one deal ever gets created per
  // campaign" hold regardless of how many times the row was touched or how
  // close together those touches were, closing the exact gap the campaign
  // duplication incident exploited.
  const { data: claimed, error: claimErr } = await supabase
    .from("boost_campaigns")
    .update({ hubspot_sync_status: "creating" })
    .eq("id", campaignId)
    .is("hubspot_deal_id", null)
    .is("hubspot_sync_status", null)
    .select("id");
  if (claimErr) {
    console.error("[hubspot-sync-deal] claim error:", claimErr.message);
    return new Response(`claim error: ${claimErr.message}`, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    // Someone else already owns this campaign's sync (mid-creation, or
    // finished between our SELECT and this UPDATE) — yield rather than risk
    // a duplicate. No HubSpot call is made on this path.
    return new Response("Sync already in progress for this campaign — skipping", { status: 200 });
  }

  const hsRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
    method: "POST",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: dealProperties }),
  });

  if (!hsRes.ok) {
    const err = await hsRes.text();
    console.error("[hubspot-sync-deal] HubSpot create error:", hsRes.status, err);
    // Release the claim so a later sync event can retry.
    await supabase.from("boost_campaigns").update({ hubspot_sync_status: null }).eq("id", campaignId);
    return new Response(`HubSpot deal error: ${err}`, { status: 500 });
  }

  const hsData = await hsRes.json();
  const hubspotDealId = hsData.id as string;

  await supabase
    .from("boost_campaigns")
    .update({ hubspot_deal_id: hubspotDealId, hubspot_sync_status: null })
    .eq("id", campaignId);

  // Contact association — still uses profiles.hubspot_contact_id via the
  // default deal↔contact association.
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

  return new Response(JSON.stringify({ ok: true, hubspot_deal_id: hubspotDealId }), {
    headers: { "Content-Type": "application/json" },
  });
});
