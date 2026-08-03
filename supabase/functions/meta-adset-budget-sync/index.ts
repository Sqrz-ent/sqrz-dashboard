import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-adset-budget-sync
//
// Keeps a campaign's Meta Ad Set budget current with the ALLOCATION-driven total,
// at every allocation event — the Meta-side twin of hubspot-sync-campaign-budget
// (which does the same for the HubSpot deal `amount`). Both run off the SAME
// wallet_ledger_entries insert events but as independent triggers/functions, so a
// Meta failure and a HubSpot failure never block each other.
//
// Triggered by on_wallet_ledger_entry_insert_meta_budget (2026-08-03) on any
// wallet_ledger_entries INSERT with entry_type IN ('allocation','deallocation') and
// a non-null campaign_id — i.e. every event that changes a campaign's
// campaign_budgets.allocated_cents (initial allocation, deallocation, reallocation
// = one of each on two campaigns). Reactivation doesn't insert a ledger row, so it
// has no direct step here; the allocation the user makes after reactivating fires
// this normally.
//
// For each event: read the campaign's meta_adset_id and its CURRENT allocated_cents
// (fresh, not derived from the event — correct regardless of pg_net delivery
// timing), then PATCH the ad set's lifetime_budget to max(allocated, floor). Skips
// silently (200) when the campaign has no meta_adset_id yet (not pushed to Meta, or
// not a Meta campaign) — same "no linked object, nothing to do" shape the HubSpot
// twin uses for a missing deal.
//
// Not user-invocable — guarded by the shared meta_sync_secret from Vault, injected
// as x-sync-secret by the trigger. Deploy verify_jwt:false (custom auth).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const FALLBACK_MIN_DAILY_CENTS = 100;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function metaGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) throw new Error(`GET ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`);
  return body;
}

function campaignDays(starts: string | null, ends: string | null): number {
  if (!starts || !ends) return 7;
  const days = Math.round((new Date(ends).getTime() - new Date(starts).getTime()) / 86_400_000);
  return days >= 1 ? days : 7;
}

Deno.serve(async (req) => {
  // Auth: shared secret from Vault (same as meta-insights-sync / meta-campaign-create).
  const provided = req.headers.get("x-sync-secret") ?? "";
  const { data: expected, error: secretErr } = await supabase.rpc("get_meta_sync_secret");
  if (secretErr || !expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  let campaignId: string | null;
  try {
    const payload = await req.json();
    campaignId = (payload.campaign_id as string) ?? null;
  } catch {
    return json({ error: "invalid payload" }, 400);
  }
  if (!campaignId) return json({ ok: true, skipped: "no campaign_id" });

  // Campaign's Meta ad set + schedule (for the lifetime-budget floor).
  const { data: campaign, error: campErr } = await supabase
    .from("boost_campaigns")
    .select("id, meta_adset_id, starts_at, ends_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) return json({ error: `campaign lookup: ${campErr.message}` }, 500);

  const adsetId = campaign?.meta_adset_id as string | null;
  if (!adsetId) {
    // Not pushed to Meta yet (or not a Meta campaign) — nothing to sync. Not an error.
    return json({ ok: true, skipped: "campaign has no meta_adset_id" });
  }

  // Running total = the campaign's CURRENT allocated_cents (read fresh, not derived
  // from this event) — correct regardless of pg_net async delivery timing.
  const { data: budget, error: budgetErr } = await supabase
    .from("campaign_budgets")
    .select("allocated_cents")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (budgetErr) return json({ error: `budget lookup: ${budgetErr.message}` }, 500);
  const allocatedCents = Number(budget?.allocated_cents ?? 0);

  // Active primary ad account for the token + the per-account budget floor.
  const { data: acct, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("ad_account_id, system_user_token")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr) return json({ error: `ad account lookup: ${acctErr.message}` }, 500);
  if (!acct) return json({ error: "no active ad account" }, 500);
  const token = acct.system_user_token as string;

  // Floor so an allocation of $0 (or below Meta's minimum) still yields a valid
  // lifetime budget. min_daily_budget × campaign days, mirroring meta-campaign-create.
  let minDaily = FALLBACK_MIN_DAILY_CENTS;
  try {
    const accBody = await metaGet(acct.ad_account_id as string, token, { fields: "min_daily_budget" });
    const m = Number(accBody.min_daily_budget);
    if (Number.isFinite(m) && m > 0) minDaily = m;
  } catch (_e) { /* keep fallback */ }
  const floor = minDaily * campaignDays(campaign?.starts_at ?? null, campaign?.ends_at ?? null);
  const lifetimeBudget = Math.max(allocatedCents, floor);

  // PATCH the ad set's budget (POST to the object id updates it in the Graph API).
  const res = await fetch(`${GRAPH}/${adsetId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ lifetime_budget: String(lifetimeBudget) }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) {
    const message = `adset budget PATCH → ${res.status}${err?.message ? ` ${err.message}` : ""}`;
    console.error(`[meta-adset-budget-sync] ${campaignId}:`, message);
    return json({ error: message }, 500);
  }

  return json({
    ok: true,
    campaign_id: campaignId,
    meta_adset_id: adsetId,
    lifetime_budget: lifetimeBudget,
  });
});
