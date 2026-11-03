// ─────────────────────────────────────────────────────────────────────────────
// Per-campaign insights shared by campaign-advisor and profile-advisor —
// template/status/budget/dates, the Meta-reported stat_* numbers ("Meta
// insights"), and the SQRZ site-side engagement numbers ("funnel", sourced
// from the get_analytics_page RPC — the same source that powers the campaign
// Analytics "SQRZ · site-side" panel). Both functions gathered this
// identically before; moved here so neither copies the other's query/shape.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export type CampaignMetaStats = {
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  link_clicks: number | null;
  landing_page_views: number | null;
  cpm: number | null;
};

export type CampaignFunnel = {
  views_driven: number;
  // null for campaigns — jitsu page_view is cookieless, so unique visitors is
  // not measurable. Treat null as "unknown", never as zero.
  unique_visitors: number | null;
  booking_flow_opens: number;
  cta_clicks: number;
  widget_opens: number;
};

export type CampaignInsights = {
  id: string;
  // Resolved via effectiveTemplate — goal is deprecated, never sent to the
  // model directly. See effectiveTemplate's own comment.
  template: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  budget_amount: number | null;
  budget_currency: string | null;
  meta_stats: CampaignMetaStats;
  funnel: CampaignFunnel;
};

// boost_campaigns.goal is deprecated (2026-10-24) — campaigns are defined by
// campaign_template now, never by goal. This is ONLY the legacy-compat path
// for a row created before campaign_template existed (NULL); it's never
// consulted for a row that already has a real campaign_template. 'audience'
// has no template equivalent (no creation path has ever produced it) and
// correctly falls through to null.
export function effectiveTemplate(campaignTemplate: string | null, goal: string | null): string | null {
  if (campaignTemplate) return campaignTemplate;
  switch (goal) {
    case "visibility": return "template_01";
    case "bookings":   return "template_02";
    default:           return null;
  }
}

/**
 * Gathers CampaignInsights for every boost_campaigns row belonging to
 * `profileId` — or, when `campaignIds` is given, only those rows. One
 * boost_campaigns query + one get_analytics_page RPC call regardless of how
 * many campaigns are returned. `admin` must be a service-role client (the
 * RPC call relies on that — see can_read_profile_analytics).
 */
export async function gatherCampaignInsights(
  admin: SupabaseLike,
  profileId: string,
  campaignIds?: string[],
): Promise<CampaignInsights[]> {
  let query = admin
    .from("boost_campaigns")
    .select(
      "id, campaign_template, goal, status, budget_amount, budget_currency, stat_spend, stat_impressions, stat_reach, stat_link_clicks, stat_profile_visits, stat_cpm, starts_at, ends_at",
    )
    .eq("profile_id", profileId)
    .order("starts_at", { ascending: false, nullsFirst: false });
  if (campaignIds) query = query.in("id", campaignIds);

  const { data: campaignRows } = await query;
  const rows = (campaignRows ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  // SQRZ site-side numbers — reuse the exact source that powers the campaign
  // Analytics "SQRZ · site-side" panel (get_analytics_page → boost_campaigns).
  // The boost_campaign_stats view's live_* columns are hardcoded NULL and are
  // NOT the real source, so they are deliberately not used here.
  const { data: page } = await admin.rpc("get_analytics_page", {
    p_profile_id: profileId,
    p_days: 3650,
  });
  const campaignsFromPage = (page?.boost_campaigns ?? []) as Array<Record<string, unknown>>;
  const sqrzById = new Map(campaignsFromPage.map((c) => [c.id as string, c]));
  const num = (v: unknown): number => Number(v ?? 0) || 0;

  return rows.map((c) => {
    const sqrzRow = sqrzById.get(c.id as string);
    return {
      id: c.id as string,
      template: effectiveTemplate(c.campaign_template as string | null, c.goal as string | null),
      status: (c.status as string | null) ?? null,
      starts_at: (c.starts_at as string | null) ?? null,
      ends_at: (c.ends_at as string | null) ?? null,
      budget_amount: c.budget_amount == null ? null : Number(c.budget_amount),
      budget_currency: (c.budget_currency as string | null)?.toUpperCase() ?? null,
      meta_stats: {
        spend: c.stat_spend == null ? null : Number(c.stat_spend),
        impressions: c.stat_impressions == null ? null : Number(c.stat_impressions),
        reach: c.stat_reach == null ? null : Number(c.stat_reach),
        link_clicks: c.stat_link_clicks == null ? null : Number(c.stat_link_clicks),
        landing_page_views: c.stat_profile_visits == null ? null : Number(c.stat_profile_visits),
        cpm: c.stat_cpm == null ? null : Number(c.stat_cpm),
      },
      funnel: {
        views_driven: num(sqrzRow?.driven_views),
        unique_visitors: sqrzRow?.driven_unique == null ? null : num(sqrzRow?.driven_unique),
        booking_flow_opens: num(sqrzRow?.modal_opens),
        cta_clicks: num(sqrzRow?.cta_clicks),
        widget_opens: num(sqrzRow?.widget_opens),
      },
    };
  });
}
