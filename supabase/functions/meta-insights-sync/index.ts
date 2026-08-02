import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-insights-sync
//
// Scheduled (daily) read-only pull of campaign performance from Meta's Insights
// API into the existing boost_campaigns.stat_* columns — replacing the manual
// entry that used to fill them, for any campaign with a meta_campaign_id set.
//
// Flow:
//   1. Per active ad account: insert a meta_insights_sync_log row (status
//      'running') and run a CONNECTIVITY CHECK — list the account's campaigns,
//      which validates the System User token + permissions and gives a logged
//      "N campaigns visible" count.
//   2. For each eligible boost_campaigns row, pull its insights and write the
//      stat_* columns. Ownership (which account's token to use) is resolved by
//      ATTEMPTING the insights call with each active account's token until one
//      succeeds — NOT by intersecting with the connectivity list. The list
//      edge is unreliable for this: it omits paused campaigns by default,
//      rejects a "DELETED" status filter, and can bury a target behind hundreds
//      of archived rows — while /{campaign_id}/insights works regardless of
//      status. The successful token's account owns the campaign; its per-account
//      campaigns_synced counter is incremented.
//   3. Finalize each account's log row (status success/error, campaigns_synced).
//
// "Eligible" = meta_campaign_id set AND (no end date OR ended within the last 28
// days). The 28-day window keeps recently-ended campaigns syncing long enough
// for Meta's attribution lookback to settle, without re-pulling ancient ones
// whose numbers are final. Not gated on status — a paused/completed campaign
// still needs syncing until it falls out of that window.
//
// Auth: not user-triggered. Guards on a shared secret that lives only in Vault
// (meta_sync_secret), read here via the get_meta_sync_secret() SECURITY DEFINER
// RPC and sent by the pg_cron caller in the x-sync-secret header. Deployed
// verify_jwt:false (custom auth), same shape as the other non-user-triggered
// functions in this project.
//
// Out of scope (per spec): currency reconciliation between budget_currency and
// the ad account's currency (USD is primary now), campaign/ad creation,
// Conversions API, any UI.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Overridable without a code change. Bump GRAPH_VERSION when the pinned Graph
// API version nears end-of-life; swap DATE_PRESET (e.g. to "maximum") if lifetime
// totals are ever wanted instead of a rolling window.
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const DATE_PRESET = Deno.env.get("META_DATE_PRESET") ?? "last_30d";

const LOOKBACK_DAYS = 28;
const PACING_MS = 250; // gentle gap between Meta calls (respect the BUC point system)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Meta returns every numeric metric as a STRING — always cast before writing.
const toInt = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Math.round(Number(v));
const toNum = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

type MetaAccount = {
  id: string;
  label: string;
  ad_account_id: string;
  system_user_token: string;
  currency: string | null;
};

type EligibleCampaign = {
  id: string;
  meta_campaign_id: string;
  ends_at: string | null;
};

async function metaGet(
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Token in the Authorization header (not the query string) so it never lands
  // in any URL log.
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) {
    throw new Error(
      `Meta ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`,
    );
  }
  return body;
}

// Connectivity check: number of campaigns visible under this account with this
// token (validates token + permissions). Default (active) listing is a fine
// health probe — this is NOT used for ownership resolution (see the module
// doc comment for why the list edge is unreliable for that).
async function countAccountCampaigns(
  adAccountId: string,
  token: string,
): Promise<number> {
  let count = 0;
  let after: string | undefined;
  do {
    const body = await metaGet(`${adAccountId}/campaigns`, token, {
      fields: "id",
      limit: "200",
      ...(after ? { after } : {}),
    });
    count += ((body.data as unknown[] | undefined) ?? []).length;
    const paging = body.paging as
      | { next?: string; cursors?: { after?: string } }
      | undefined;
    after = paging?.next ? paging.cursors?.after : undefined;
  } while (after);
  return count;
}

type Insights = {
  impressions: number | null;
  reach: number | null;
  link_clicks: number | null;
  cpc: number | null;
  cpm: number | null;
  spend: number | null;
};

// Returns the parsed insights row, or null when the token CAN access the
// campaign but it had no delivery in the window. Throws when the token cannot
// access the campaign (wrong account) — the caller treats a throw as "try the
// next account's token".
async function fetchInsights(
  campaignId: string,
  token: string,
): Promise<Insights | null> {
  // stat_link_clicks ← inline_link_clicks (link clicks specifically, not all
  // clicks); stat_cost_per_click ← Meta's cpc.
  const body = await metaGet(`${campaignId}/insights`, token, {
    fields: "impressions,reach,inline_link_clicks,cpc,cpm,spend",
    date_preset: DATE_PRESET,
  });
  const row = (body.data as Record<string, unknown>[] | undefined)?.[0];
  if (!row) return null;
  return {
    impressions: toInt(row.impressions),
    reach: toInt(row.reach),
    link_clicks: toInt(row.inline_link_clicks),
    cpc: toNum(row.cpc),
    cpm: toNum(row.cpm),
    spend: toNum(row.spend),
  };
}

type AccountState = {
  acct: MetaAccount;
  logId: number | null;
  synced: number;
  usable: boolean;
  visible: number;
};

Deno.serve(async (req) => {
  // ── Auth: shared secret from Vault ─────────────────────────────────────────
  const provided = req.headers.get("x-sync-secret") ?? "";
  const { data: expected, error: secretErr } = await supabase.rpc(
    "get_meta_sync_secret",
  );
  if (secretErr || !expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  // ── Eligible campaigns (28-day lookback, any status) ───────────────────────
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: campaigns, error: campErr } = await supabase
    .from("boost_campaigns")
    .select("id, meta_campaign_id, ends_at")
    .not("meta_campaign_id", "is", null)
    .or(`ends_at.is.null,ends_at.gte.${cutoff}`);
  if (campErr) return json({ error: `campaign query: ${campErr.message}` }, 500);
  const eligible = (campaigns ?? []) as EligibleCampaign[];

  // ── Active ad accounts (never hardcode a single account) ───────────────────
  const { data: accounts, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("id, label, ad_account_id, system_user_token, currency")
    .eq("is_active", true);
  if (acctErr) return json({ error: `account query: ${acctErr.message}` }, 500);

  // ── Phase 1: per-account connectivity check + open a log row ───────────────
  const states: AccountState[] = [];
  for (const acct of (accounts ?? []) as MetaAccount[]) {
    const { data: logRow } = await supabase
      .from("meta_insights_sync_log")
      .insert({
        ad_account_id: acct.ad_account_id,
        started_at: new Date().toISOString(),
        status: "running",
      })
      .select("id")
      .single();
    const logId = (logRow?.id as number | undefined) ?? null;
    try {
      const visible = await countAccountCampaigns(
        acct.ad_account_id,
        acct.system_user_token,
      );
      console.log(
        `[${acct.label}] ${acct.ad_account_id}: connectivity ok, ${visible} campaign(s) visible`,
      );
      states.push({ acct, logId, synced: 0, usable: true, visible });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${acct.label}] connectivity failed: ${message}`);
      await supabase
        .from("meta_insights_sync_log")
        .update({
          completed_at: new Date().toISOString(),
          status: "error",
          campaigns_synced: 0,
          error: `connectivity: ${message}`,
        })
        .eq("id", logId);
      states.push({ acct, logId, synced: 0, usable: false, visible: 0 });
    }
    await sleep(PACING_MS);
  }

  const usable = states.filter((s) => s.usable);

  // ── Phase 2: sync each eligible campaign via its owning account's token ─────
  let unresolved = 0;
  for (const c of eligible) {
    let owned = false;
    for (const st of usable) {
      try {
        const stats = await fetchInsights(
          c.meta_campaign_id,
          st.acct.system_user_token,
        );
        owned = true; // no throw = this token can access the campaign
        if (stats) {
          await supabase
            .from("boost_campaigns")
            .update({
              stat_impressions: stats.impressions,
              stat_reach: stats.reach,
              stat_link_clicks: stats.link_clicks,
              stat_cost_per_click: stats.cpc,
              stat_cpm: stats.cpm,
              stat_spend: stats.spend,
              stats_updated_at: new Date().toISOString(),
            })
            .eq("id", c.id);
          st.synced++;
        }
        await sleep(PACING_MS);
        break; // resolved to this account — don't try the others
      } catch (_e) {
        // This token can't access the campaign — try the next account.
        await sleep(PACING_MS);
      }
    }
    if (!owned) {
      unresolved++;
      console.warn(
        `campaign ${c.id} (meta ${c.meta_campaign_id}): no active account token could access it`,
      );
    }
  }

  // ── Phase 3: finalize each usable account's log row ────────────────────────
  for (const st of usable) {
    await supabase
      .from("meta_insights_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        status: "success",
        campaigns_synced: st.synced,
      })
      .eq("id", st.logId);
  }

  return json({
    ok: true,
    ran_at: new Date().toISOString(),
    eligible_campaigns: eligible.length,
    unresolved_campaigns: unresolved,
    accounts: states.map((s) => ({
      account: s.acct.label,
      ok: s.usable,
      campaigns_visible: s.visible,
      campaigns_synced: s.synced,
    })),
  });
});
