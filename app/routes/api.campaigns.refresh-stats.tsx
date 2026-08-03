import type { Route } from "./+types/api.campaigns.refresh-stats";
import { redirect } from "react-router";
import { createSupabaseServerClient, createSupabaseBearerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { fetchInsightsResolvingAccount } from "~/lib/metaInsights.server";

// On-demand, single-campaign variant of the daily meta-insights-sync edge
// function — triggered by the user tapping "Refresh" on one pipeline card
// (currently the iOS "In Progress" column) instead of the scheduled job's
// full sweep. Reuses the exact same by-ID insights-fetch + account-resolution
// approach (see metaInsights.server.ts) so paused/edge-case campaigns behave
// identically to the scheduled sync. Also refreshes the SQRZ-native counts
// (get_boost_campaign_native_stats) in the same call — a "refresh" should
// update everything the card shows, not just the Meta half.
//
// Cooldown: gates ONLY the Meta Graph API call (the thing actually worth rate
// -limiting) off boost_campaigns.stats_updated_at — shared with the scheduled
// job, so a manual tap right after either a scheduled sync or a previous
// manual refresh is a no-op on the Meta side. The SQRZ-native counts are cheap
// same-DB COUNT queries with no external rate limit, so they're refreshed on
// every call regardless of cooldown. This keeps the common "impatient tap"
// case a normal 200 with the latest-available numbers, not an error — the
// response's `meta_refreshed` flag tells the client whether Meta was actually
// hit this time.
const META_REFRESH_COOLDOWN_SECONDS = 30;

type NativeStatsRow = {
  views_driven: number | null;
  ctas_clicked: number | null;
  booking_flow_opens: number | null;
};

export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
    if (!user) return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  let body: { campaign_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }
  if (!body.campaign_id) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }
  const campaignId = body.campaign_id;

  // Ownership check + current stats in one round trip — the RLS client can
  // only see the caller's own rows, so a null here = not theirs (same idiom
  // as api/campaigns/reactivate.tsx).
  const { data: campaign } = await supabase
    .from("boost_campaigns")
    .select(
      "id, profile_id, meta_campaign_id, stat_impressions, stat_reach, stat_link_clicks, stat_cost_per_click, stat_cpm, stat_spend, stats_updated_at",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.profile_id !== profile.id) {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }

  const admin = createSupabaseAdminClient();

  let statImpressions = campaign.stat_impressions as number | null;
  let statReach = campaign.stat_reach as number | null;
  let statLinkClicks = campaign.stat_link_clicks as number | null;
  let statCostPerClick = campaign.stat_cost_per_click as number | null;
  let statCpm = campaign.stat_cpm as number | null;
  let statSpend = campaign.stat_spend as number | null;
  let statsUpdatedAt = campaign.stats_updated_at as string | null;

  let metaRefreshed = false;
  let metaSkippedReason: "not_linked" | "cooldown" | "unresolved" | undefined;
  let metaCooldownSecondsRemaining: number | undefined;

  const metaCampaignId = campaign.meta_campaign_id as string | null;
  if (!metaCampaignId) {
    metaSkippedReason = "not_linked";
  } else {
    const secondsSinceUpdate = statsUpdatedAt
      ? (Date.now() - new Date(statsUpdatedAt).getTime()) / 1000
      : Infinity;
    if (secondsSinceUpdate < META_REFRESH_COOLDOWN_SECONDS) {
      metaSkippedReason = "cooldown";
      metaCooldownSecondsRemaining = Math.ceil(META_REFRESH_COOLDOWN_SECONDS - secondsSinceUpdate);
    } else {
      const { data: accounts, error: acctErr } = await admin
        .from("meta_ad_accounts")
        .select("ad_account_id, system_user_token")
        .eq("is_active", true);
      if (acctErr) {
        return Response.json({ error: `account query: ${acctErr.message}` }, { status: 500, headers });
      }

      const { owned, insights } = await fetchInsightsResolvingAccount(metaCampaignId, accounts ?? []);
      if (!owned) {
        metaSkippedReason = "unresolved";
      } else {
        metaRefreshed = true;
        // Matches the scheduled job: only write when there's an insights row —
        // no delivery in the window leaves the existing values (and timestamp)
        // in place rather than nulling them out.
        if (insights) {
          statImpressions = insights.impressions;
          statReach = insights.reach;
          statLinkClicks = insights.link_clicks;
          statCostPerClick = insights.cpc;
          statCpm = insights.cpm;
          statSpend = insights.spend;
          statsUpdatedAt = new Date().toISOString();

          const { error: updateErr } = await admin
            .from("boost_campaigns")
            .update({
              stat_impressions: statImpressions,
              stat_reach: statReach,
              stat_link_clicks: statLinkClicks,
              stat_cost_per_click: statCostPerClick,
              stat_cpm: statCpm,
              stat_spend: statSpend,
              stats_updated_at: statsUpdatedAt,
            })
            .eq("id", campaignId);
          if (updateErr) {
            return Response.json({ error: `stat update: ${updateErr.message}` }, { status: 500, headers });
          }
        }
      }
    }
  }

  // SQRZ-native counts — cheap same-DB COUNT queries (profile_views /
  // jitsu_events), no Meta call involved, so always refreshed regardless of
  // the cooldown above. Same RPC iOS already calls directly per-card.
  const { data: nativeRows, error: nativeErr } = await admin.rpc(
    "get_boost_campaign_native_stats",
    { p_campaign_id: campaignId },
  );
  if (nativeErr) {
    return Response.json({ error: `native stats: ${nativeErr.message}` }, { status: 500, headers });
  }
  const native = (nativeRows as NativeStatsRow[] | null)?.[0] ?? null;

  return Response.json(
    {
      campaign_id: campaignId,
      meta_refreshed: metaRefreshed,
      ...(metaSkippedReason ? { meta_skipped_reason: metaSkippedReason } : {}),
      ...(metaCooldownSecondsRemaining != null
        ? { meta_cooldown_seconds_remaining: metaCooldownSecondsRemaining }
        : {}),
      stat_impressions: statImpressions,
      stat_reach: statReach,
      stat_link_clicks: statLinkClicks,
      stat_cost_per_click: statCostPerClick,
      stat_cpm: statCpm,
      stat_spend: statSpend,
      stats_updated_at: statsUpdatedAt,
      native: native
        ? {
            views_driven: native.views_driven ?? 0,
            ctas_clicked: native.ctas_clicked ?? 0,
            booking_flow_opens: native.booking_flow_opens ?? 0,
          }
        : null,
    },
    { headers },
  );
}
