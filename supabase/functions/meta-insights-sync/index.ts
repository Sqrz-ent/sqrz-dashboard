import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchMetaCampaignStatus, resolveIsPaused } from "../_shared/meta-delivery-status.ts";

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
// Two entry points now share this one function (2026-10-20):
//   1. The original scheduled sweep — unchanged. Guards on a shared secret
//      that lives only in Vault (meta_sync_secret), read via the
//      get_meta_sync_secret() SECURITY DEFINER RPC and sent by the pg_cron
//      caller in the x-sync-secret header. No campaign_id in the body.
//   2. A new user-triggered single-campaign refresh (the "Refresh" button on
//      an iOS campaign card) — auth is the caller's own Supabase JWT
//      (Authorization: Bearer), body is { campaign_id }. Ownership is
//      checked via the real user_owns_profile() RLS helper, called through a
//      short-lived client scoped to the caller's own JWT (so auth.uid()
//      resolves) — not reimplemented by hand. Reuses fetchInsights(...) and
//      writes the exact same stat_* columns via the shared writeStats(...)
//      helper, both unchanged/not duplicated from the sweep below. Rate
//      limited to one real Meta call per campaign per 60s — if
//      stats_updated_at is younger than that, returns the stored values
//      without calling Meta. Only attempts Meta at all when the campaign has
//      a meta_campaign_id.
// Deployed verify_jwt:false either way (custom auth for both paths — the
// sweep via the shared secret, the single-campaign path via its own manual
// JWT validation against GoTrue).
//
// Out of scope (per spec): currency reconciliation between budget_currency and
// the ad account's currency (USD is primary now), campaign/ad creation,
// Conversions API, any UI.
//
// Budget-exhaustion auto-stop (2026-10-22, end_mode='budget' campaigns only —
// see meta-campaign-create/the end-choice task): right after writing stats,
// if the campaign's total spend has reached its allocated budget
// (campaign_budgets.allocated_cents — the TOTAL pool, not daily_budget_cents,
// which is only the pacing rate), the Meta campaign is paused via the Graph
// API and marked is_paused/paused_at + status='completed' (see
// maybeStopForBudgetExhaustion's own comment for why 'completed', not just
// is_paused, and why this doesn't call meta-campaign-toggle directly). Runs
// in both the sweep and the user-triggered single-campaign refresh, since
// either path can be the one that pushes spend over the line.
//
// Real-Meta pause sync (2026-10-22 — bug fix): SQRZ's boost_campaigns.is_paused
// used to ONLY change via meta-campaign-toggle, so a campaign paused directly
// in Meta Ads Manager (bypassing SQRZ entirely) still showed "Live" with a
// "Pause" button forever — is_paused and meta_delivery_status both just sat
// stale. Both sync entry points (the cron sweep and the user-triggered
// refresh) now also read the campaign's real effective_status/status straight
// from the Graph API — via the ONE shared helper in
// ../_shared/meta-delivery-status.ts (also used by meta-campaign-toggle's own
// pre-flight check, so the two functions can never disagree on what "paused"
// means) — and write both meta_delivery_status (the raw value) and is_paused
// (mapped; see that file's own comment for the full mapping table and the
// reasoning behind each value) every time a campaign's token/ownership is
// already resolved for the insights call anyway, piggy-backing on that same
// Graph round trip rather than adding a second unrelated one.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Overridable without a code change. Bump GRAPH_VERSION when the pinned Graph
// API version nears end-of-life; swap DATE_PRESET (e.g. to "maximum") if lifetime
// totals are ever wanted instead of a rolling window.
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const DATE_PRESET = Deno.env.get("META_DATE_PRESET") ?? "maximum";

const LOOKBACK_DAYS = 28;
const PACING_MS = 250; // gentle gap between Meta calls (respect the BUC point system)
// User-triggered single-campaign refresh only — at most one real Meta call
// per campaign per this many seconds; a tap inside the window just returns
// the already-stored values. Separate from the sweep, which has no per-
// campaign cooldown of its own (it only runs once a day).
const USER_REFRESH_COOLDOWN_SECONDS = 60;

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
  end_mode: string | null;
  is_paused: boolean;
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

// Same shape as meta-campaign-create's / meta-campaign-toggle's metaPost —
// token in the Authorization header, form-urlencoded body. Used only by
// maybeStopForBudgetExhaustion below (pausing an exhausted campaign) — this
// function otherwise never writes to Meta.
async function metaPost(
  path: string,
  token: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) {
    throw new Error(`POST ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`);
  }
  return body;
}

// Budget-exhaustion auto-stop (2026-10-22) — end_mode='budget' campaigns only.
// Compares stat_spend (Meta's insights spend, in the account's major currency
// unit, e.g. dollars) against campaign_budgets.allocated_cents (the TOTAL
// allocated pool, in cents — NOT daily_budget_cents, which is only the
// per-day pacing rate). Once spend reaches the allocated total, pauses the
// Meta campaign and marks the row completed.
//
// "Same mechanism as meta-campaign-toggle" (per the task) means the SAME
// Graph API action (POST the campaign id with status=PAUSED) and the SAME
// is_paused/paused_at columns — NOT a literal supabase.functions.invoke call
// to that function. meta-campaign-toggle requires a real end-user JWT for
// its own user_owns_profile ownership check; this sweep/refresh context is
// service-role/cron-authenticated with no end-user identity to forward, so
// calling it directly would just fail its own auth. The Graph API call and
// DB writes are duplicated here (small, same shape) rather than routed
// through a function that isn't designed to accept a trusted-but-user-less
// caller.
//
// Status used: is_paused=true + paused_at=now() (same columns meta-campaign-
// toggle writes) AND status='completed' — not just is_paused, because this
// is the campaign's budget actually running out (a natural end, same
// terminal status every other end-of-life path in this app already uses),
// not a deliberate temporary stop with intent to resume (which is what a
// manual pause via meta-campaign-toggle is, and why that path leaves status
// at 'live'). A 'completed' campaign already has an existing path back to
// life — allocate_campaign_budget's reactivation-via-allocation — so topping
// up more budget later naturally revives it through infrastructure that
// already exists, rather than needing a new one.
//
// Idempotent: the caller only invokes this when is_paused is not already
// true (see the two call sites) — skips re-pausing/re-marking a campaign
// that already stopped on a previous sync.
async function maybeStopForBudgetExhaustion(
  campaignId: string,
  metaCampaignId: string,
  token: string,
  spendDollars: number | null,
): Promise<void> {
  if (spendDollars == null) return;

  const { data: budget } = await supabase
    .from("campaign_budgets")
    .select("allocated_cents")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  const allocatedCents = Number(budget?.allocated_cents ?? 0);
  if (allocatedCents <= 0) return; // nothing allocated yet — nothing to exhaust

  const spendCents = Math.round(spendDollars * 100);
  if (spendCents < allocatedCents) return;

  console.log(
    `[meta-insights-sync] campaign ${campaignId} budget exhausted (spend ${spendCents}c >= allocated ${allocatedCents}c) — pausing`,
  );
  try {
    await metaPost(metaCampaignId, token, { status: "PAUSED" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-insights-sync] failed to pause exhausted campaign ${campaignId}:`, message);
    return; // don't mark completed if the actual Meta pause failed
  }

  const nowIso = new Date().toISOString();
  await supabase
    .from("boost_campaigns")
    .update({
      is_paused: true,
      paused_at: nowIso,
      status: "completed",
      status_updated_at: nowIso,
    })
    .eq("id", campaignId);
}

// Reads the campaign's REAL Meta status and writes meta_delivery_status +
// is_paused to match (see ../_shared/meta-delivery-status.ts for the mapping
// and the bug this fixes). Shared by both entry points below — the cron
// sweep's Phase 2 loop and handleUserTriggeredRefresh — so there's exactly
// one place that does this write. A failed read (network/Meta error) is
// logged and leaves both columns untouched rather than guessing; it does not
// throw, so it never aborts whatever stats-sync work is already in progress
// for this campaign in the same pass.
async function syncDeliveryStatus(
  campaignId: string,
  metaCampaignId: string,
  token: string,
): Promise<{ metaDeliveryStatus: string | null; isPaused: boolean | undefined }> {
  let s;
  try {
    s = await fetchMetaCampaignStatus(metaCampaignId, token, GRAPH_VERSION);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[meta-insights-sync] failed to read Meta delivery status for ${campaignId}:`, message);
    return { metaDeliveryStatus: null, isPaused: undefined };
  }

  const isPaused = resolveIsPaused(s);
  const update: Record<string, unknown> = { meta_delivery_status: s.effectiveStatus };
  if (isPaused !== undefined) update.is_paused = isPaused;

  const { error } = await supabase.from("boost_campaigns").update(update).eq("id", campaignId);
  if (error) {
    console.error(`[meta-insights-sync] failed to write delivery status for ${campaignId}:`, error.message);
  }
  return { metaDeliveryStatus: s.effectiveStatus, isPaused };
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

// The one place that writes stat_* from a fetched Insights row — shared by
// the sweep and the new user-triggered single-campaign path so the column
// mapping only exists once.
async function writeStats(
  campaignId: string,
  stats: Insights,
): Promise<string> {
  const stamp = new Date().toISOString();
  await supabase
    .from("boost_campaigns")
    .update({
      stat_impressions: stats.impressions,
      stat_reach: stats.reach,
      stat_link_clicks: stats.link_clicks,
      stat_cost_per_click: stats.cpc,
      stat_cpm: stats.cpm,
      stat_spend: stats.spend,
      stats_updated_at: stamp,
    })
    .eq("id", campaignId);
  return stamp;
}

type AccountState = {
  acct: MetaAccount;
  logId: number | null;
  synced: number;
  usable: boolean;
  visible: number;
};

type CampaignStatRow = {
  profile_id: string;
  meta_campaign_id: string | null;
  stat_impressions: number | null;
  stat_reach: number | null;
  stat_link_clicks: number | null;
  stat_cost_per_click: number | null;
  stat_cpm: number | null;
  stat_spend: number | null;
  stats_updated_at: string | null;
  end_mode: string | null;
  is_paused: boolean;
  meta_delivery_status: string | null;
};

// User-triggered single-campaign refresh — the "Refresh" button on an iOS
// campaign card. Auth: the caller's own Supabase JWT (Authorization: Bearer),
// validated against GoTrue via supabase.auth.getUser(jwt) (works through the
// service-role client — the token is passed explicitly, not read off the
// client's own header). Ownership is then checked by calling the real
// user_owns_profile() RLS helper through a client scoped to that SAME JWT
// (so auth.uid() resolves inside the RPC) — the service-role client above
// has no caller identity, so it can't be used for that check.
async function handleUserTriggeredRefresh(
  req: Request,
  campaignId: string,
): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(
    bearerToken,
  );
  if (userErr || !userData?.user) {
    return json({ error: "unauthorized" }, 401);
  }

  const { data: campaign, error: campErr } = await supabase
    .from("boost_campaigns")
    .select(
      "profile_id, meta_campaign_id, stat_impressions, stat_reach, stat_link_clicks, stat_cost_per_click, stat_cpm, stat_spend, stats_updated_at, end_mode, is_paused, meta_delivery_status",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (campErr) return json({ error: `campaign lookup: ${campErr.message}` }, 500);
  if (!campaign) return json({ error: "campaign not found" }, 404);
  const c = campaign as CampaignStatRow;

  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc(
    "user_owns_profile",
    { p_profile_id: c.profile_id },
  );
  if (ownsErr || owns !== true) {
    return json({ error: "unauthorized" }, 403);
  }

  let statImpressions = c.stat_impressions;
  let statReach = c.stat_reach;
  let statLinkClicks = c.stat_link_clicks;
  let statCostPerClick = c.stat_cost_per_click;
  let statCpm = c.stat_cpm;
  let statSpend = c.stat_spend;
  let statsUpdatedAt = c.stats_updated_at;
  let isPaused = c.is_paused;
  let metaDeliveryStatus = c.meta_delivery_status;

  let refreshed = false;
  let skippedReason: "not_linked" | "cooldown" | "unresolved" | undefined;

  if (!c.meta_campaign_id) {
    skippedReason = "not_linked";
  } else {
    const secondsSinceUpdate = statsUpdatedAt
      ? (Date.now() - new Date(statsUpdatedAt).getTime()) / 1000
      : Infinity;
    if (secondsSinceUpdate < USER_REFRESH_COOLDOWN_SECONDS) {
      skippedReason = "cooldown";
    } else {
      const { data: accounts, error: acctErr } = await supabase
        .from("meta_ad_accounts")
        .select("ad_account_id, system_user_token")
        .eq("is_active", true);
      if (acctErr) {
        return json({ error: `account query: ${acctErr.message}` }, 500);
      }

      let owned = false;
      let stats: Insights | null = null;
      let owningToken: string | null = null;
      for (
        const acct of (accounts ?? []) as
          { ad_account_id: string; system_user_token: string }[]
      ) {
        try {
          stats = await fetchInsights(c.meta_campaign_id, acct.system_user_token);
          owned = true;
          owningToken = acct.system_user_token;
          break;
        } catch (_e) {
          // This token can't access the campaign — try the next account.
        }
      }

      if (!owned) {
        skippedReason = "unresolved";
      } else {
        refreshed = true;
        if (stats) {
          statImpressions = stats.impressions;
          statReach = stats.reach;
          statLinkClicks = stats.link_clicks;
          statCostPerClick = stats.cpc;
          statCpm = stats.cpm;
          statSpend = stats.spend;
          statsUpdatedAt = await writeStats(campaignId, stats);
        }
        // Real-Meta pause sync — same shared helper + same "run it whenever
        // we have a resolved token" timing as the cron sweep, so a tap of
        // the Refresh button also catches a pause made directly in Meta Ads
        // Manager (the bug this task fixes), not just fresh insights.
        if (owningToken) {
          const delivery = await syncDeliveryStatus(campaignId, c.meta_campaign_id, owningToken);
          metaDeliveryStatus = delivery.metaDeliveryStatus;
          if (delivery.isPaused !== undefined) isPaused = delivery.isPaused;
        }
        if (stats && c.end_mode === "budget" && !c.is_paused && owningToken) {
          await maybeStopForBudgetExhaustion(campaignId, c.meta_campaign_id, owningToken, stats.spend);
        }
      }
    }
  }

  return json({
    ok: true,
    campaign_id: campaignId,
    refreshed,
    ...(skippedReason ? { skipped_reason: skippedReason } : {}),
    stat_impressions: statImpressions,
    stat_reach: statReach,
    stat_link_clicks: statLinkClicks,
    stat_cost_per_click: statCostPerClick,
    stat_cpm: statCpm,
    stat_spend: statSpend,
    stats_updated_at: statsUpdatedAt,
    is_paused: isPaused,
    meta_delivery_status: metaDeliveryStatus,
  });
}

Deno.serve(async (req) => {
  // Single-campaign, user-triggered path — dispatched first since it's the
  // only shape with a campaign_id in the body. The sweep below never sends
  // one (the cron job's body is always '{}'), so this is a clean split with
  // zero ambiguity, and the sweep's own shared-secret auth path is otherwise
  // completely untouched.
  let body: { campaign_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.campaign_id) {
    return await handleUserTriggeredRefresh(req, body.campaign_id);
  }

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
    .select("id, meta_campaign_id, ends_at, end_mode, is_paused")
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
          await writeStats(c.id, stats);
          st.synced++;
        }
        // Real-Meta pause sync — runs regardless of whether this campaign had
        // any delivery to report (a freshly-paused campaign may have no new
        // insights row at all), piggy-backing on the same resolved token.
        await syncDeliveryStatus(c.id, c.meta_campaign_id, st.acct.system_user_token);
        if (stats && c.end_mode === "budget" && !c.is_paused) {
          await maybeStopForBudgetExhaustion(c.id, c.meta_campaign_id, st.acct.system_user_token, stats.spend);
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
