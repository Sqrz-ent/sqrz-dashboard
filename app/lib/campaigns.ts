// Read-only campaign helpers for the web dashboard (2026-11) — a port of the
// display logic in sqrz-ios Features/Boost/BoostView.swift and
// Models/BoostCampaign.swift. Same tables (boost_campaigns, campaign_budgets,
// campaign_templates) and the same RPC (get_campaign_metrics); NO numbers are
// derived here — every metric comes straight from the database / RPC. Only the
// status wording, pipeline grouping and formatting are mirrored.

export type CampaignRow = {
  id: string;
  profile_id: string | null;
  name: string | null;
  status: string | null;
  campaign_template: string | null;
  budget_amount: number | null;
  budget_currency: string | null;
  is_managed: boolean | null;
  is_paused: boolean | null;
  review_feedback: string | null;
  creative_asset_url: string | null;
  existing_post_id: string | null;
  existing_post_source: string | null;
  video_link_url: string | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string | null;
  stat_link_clicks: number | null;
  stat_spend: number | null;
  stat_impressions: number | null;
  stat_reach: number | null;
};

export type CampaignBudgetRow = {
  allocated_cents: number;
  spent_cents: number;
  status: string;
};

export type FunnelRow = { key: string; label: string; value: string };
export type FunnelStage = { stage: string; rows: FunnelRow[] };

// get_campaign_metrics(p_campaign_id) — mirrors Models/CampaignMetrics.swift.
export type CampaignMetrics = {
  campaign_id: string;
  meta: {
    spend: number | null;
    link_clicks: number | null;
    cost_per_link_click: number | null;
    reach: number | null;
    impressions: number | null;
  };
  sqrz: { visits: number; cost_per_visit: number | null };
  funnel: FunnelStage[];
};

// ─── Pipeline (BoostView.PipelineLane / lane(for:)) ──────────────────────────

export type PipelineLane = "needsAction" | "inProgress" | "completed";

export function laneFor(c: Pick<CampaignRow, "status">): PipelineLane {
  switch (c.status?.toLowerCase()) {
    case "booked":
    case "needs_changes":
    case "rejected":
    case "awaiting_budget":
      return "needsAction";
    case "completed":
      return "completed";
    default:
      return "inProgress";
  }
}

export const LANE_TITLES: Record<PipelineLane, string> = {
  needsAction: "Needs action",
  inProgress: "In progress",
  completed: "Completed",
};

// In Progress sort order — proximity to actually running (BoostView.inProgressRank).
export function inProgressRank(c: Pick<CampaignRow, "status">): number {
  switch (c.status?.toLowerCase()) {
    case "live": return 0;
    case "approved": return 1;
    case "in_review": return 2;
    default: return 3;
  }
}

// iOS rendersStats: only Completed and live In Progress campaigns show metrics.
export function rendersStats(c: Pick<CampaignRow, "status">): boolean {
  const lane = laneFor(c);
  if (lane === "completed") return true;
  if (lane === "inProgress") return c.status?.toLowerCase() === "live";
  return false;
}

// ─── Status (BoostCampaign.statusLabel / displayStatusLabel) ─────────────────

export function isManagedPending(c: Pick<CampaignRow, "is_managed" | "status">): boolean {
  return !!c.is_managed && (c.status == null || c.status.toLowerCase() === "pending");
}

export function isCurrentlyPaused(c: Pick<CampaignRow, "is_paused" | "status">): boolean {
  return !!c.is_paused && c.status?.toLowerCase() === "live";
}

export function statusLabel(c: CampaignRow): string {
  if (isCurrentlyPaused(c)) return "Paused";
  if (isManagedPending(c)) return "Requested";
  switch (c.status?.toLowerCase()) {
    case "booked": return "Add content";
    case "in_review": return "In review";
    case "needs_changes": return "Needs changes";
    case "approved": return "Approved";
    case "live": return "Live";
    case "completed": return "Completed";
    case "rejected": return "Declined";
    case "awaiting_budget": return "Awaiting budget";
    case "preparing": return "Preparing";
    default: return "Getting ready";
  }
}

// Badge colour key (BoostView.statusBadge).
export function statusTone(c: CampaignRow): "green" | "orange" | "muted" | "red" | "blue" | "accent" {
  if (isCurrentlyPaused(c)) return "orange";
  switch ((c.status ?? "").toLowerCase()) {
    case "approved":
    case "live": return "green";
    case "completed": return "muted";
    case "rejected":
    case "needs_changes": return "red";
    case "in_review":
    case "preparing": return "blue";
    default: return "accent";
  }
}

export function campaignDisplayName(c: Pick<CampaignRow, "name">, templateName?: string | null): string {
  const n = c.name?.trim();
  return n || templateName || "Untitled campaign";
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function currencySymbol(code: string | null | undefined): string {
  switch ((code ?? "").toUpperCase()) {
    case "": return "$";
    case "USD": return "$";
    case "EUR": return "€";
    case "GBP": return "£";
    default: return `${code} `;
  }
}

export function money(v: number | null | undefined, sym = "$"): string {
  return v == null ? "—" : `${sym}${v.toFixed(2)}`;
}

export function count(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString("en-US");
}

// Same as BoostView.formatCents (USD; no decimals for whole dollars).
export function formatCents(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

// ─── "Only non-zero values" ───────────────────────────────────────────────────

// Funnel values arrive pre-formatted from the backend ("12", "28s"); a value is
// zero/empty when its numeric part is 0 or there is none.
export function isZeroValue(v: string | number | null | undefined): boolean {
  if (v == null) return true;
  if (typeof v === "number") return v === 0;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) || n === 0;
}

// One-line explanations, keyed by the backend's stable row key — copied from
// sqrz-ios Models/FunnelMetrics.swift (FunnelExplanations.byKey).
export const FUNNEL_EXPLANATIONS: Record<string, string> = {
  visits: "People who landed on your page.",
  people: "Unique people behind those visits.",
  scrolled: "Visitors who scrolled down the page.",
  saw_content: "Visitors who saw an embedded widget (music, video, etc.).",
  avg_time_on_page: "How long visitors stayed, on average.",
  played_video: "Visitors who started playing a video or audio widget.",
  reached_50: "Visitors who got halfway through.",
  reached_75: "Visitors who got three-quarters of the way through.",
  watched_end: "Visitors who finished the video or audio.",
  tapped_button: "Visitors who tapped a call-to-action button.",
  opened_another_page: "Visitors who explored another page on your profile.",
  tapped_external_link: "Visitors who clicked through to an outside link.",
  opened_booking: "Visitors who opened the booking form.",
  tapped_service: "Visitors who tapped one of your services.",
  opened_chat: "Visitors who opened the chat widget.",
  converted_leads: "Booking requests or inquiries this directly produced.",
};

export type MetricsRowView = { label: string; value: string; explanation: string };
export type MetricsSectionView = { title: string; rows: MetricsRowView[] };

// BoostView.metricsSections(for:) with zero/absent rows dropped (web shows only
// non-zero values). Sections left empty are omitted.
export function buildMetricsSections(
  m: CampaignMetrics | null,
  currency: string | null | undefined
): MetricsSectionView[] {
  if (!m) return [];
  const sym = currencySymbol(currency);
  const metaRows: Array<MetricsRowView & { raw: number | null }> = [
    { label: "Spent", raw: m.meta.spend, value: money(m.meta.spend, sym), explanation: "What Meta charged for this campaign." },
    { label: "Link clicks", raw: m.meta.link_clicks, value: count(m.meta.link_clicks), explanation: "People who tapped your ad." },
    { label: "Cost per link click", raw: m.meta.cost_per_link_click, value: money(m.meta.cost_per_link_click, sym), explanation: "Spend divided by link clicks." },
    { label: "Reach", raw: m.meta.reach, value: count(m.meta.reach), explanation: "People who saw your ad at least once." },
    { label: "Impressions", raw: m.meta.impressions, value: count(m.meta.impressions), explanation: "Total times your ad was shown." },
  ];
  const sections: MetricsSectionView[] = [];
  const meta = metaRows.filter((r) => !isZeroValue(r.raw)).map(({ label, value, explanation }) => ({ label, value, explanation }));
  if (meta.length) sections.push({ title: "From the ad (Meta)", rows: meta });

  for (const stage of m.funnel ?? []) {
    const rows = stage.rows
      .filter((r) => !isZeroValue(r.value))
      .map((r) => ({ label: r.label, value: r.value, explanation: FUNNEL_EXPLANATIONS[r.key] ?? "" }));
    if (rows.length) sections.push({ title: stage.stage, rows });
  }
  return sections;
}

// The compact card's key metrics (BoostView.campaignStatsRow): Spent / Link
// clicks / Visits / Cost per visit — only those with a non-zero value.
export function keyMetrics(
  c: CampaignRow,
  m: CampaignMetrics | null
): Array<{ label: string; value: string }> {
  const sym = currencySymbol(c.budget_currency);
  const items: Array<{ label: string; raw: number | null | undefined; value: string }> = [
    { label: "Spent", raw: c.stat_spend, value: money(c.stat_spend, sym) },
    { label: "Link clicks", raw: c.stat_link_clicks, value: count(c.stat_link_clicks) },
    { label: "Visits", raw: m?.sqrz.visits, value: count(m?.sqrz.visits) },
    { label: "Cost / visit", raw: m?.sqrz.cost_per_visit, value: money(m?.sqrz.cost_per_visit, sym) },
  ];
  return items.filter((i) => !isZeroValue(i.raw)).map(({ label, value }) => ({ label, value }));
}

// Campaigns live INSIDE Grow (the iOS Grow tab's Campaigns pill): Grow is the
// /analytics route (nav label "Grow"), the detail page is a sub-route of it.
export const GROW_PATH = "/analytics";
export const GROW_CAMPAIGNS_PATH = "/analytics?tab=campaigns";
export function campaignPath(id: string): string {
  return `${GROW_PATH}/campaigns/${id}`;
}

export const MANAGE_IN_APP_NOTE = "Manage this campaign in the SQRZ app";
export const COMPLETE_PAYMENT_NOTE = "Complete payment in the SQRZ app";

// A self-serve campaign saved on the web (or in the app) before its activation
// purchase: status 'booked', not a managed request. Payment is app-only (IAP).
export function awaitsPayment(c: Pick<CampaignRow, "status" | "is_managed">): boolean {
  return c.status?.toLowerCase() === "booked" && !c.is_managed;
}

// get_link_metrics → same section shape as the campaign metrics (zero rows dropped).
export function buildLinkMetricsSections(m: {
  sources: Array<{ source: string; visits: number }>;
  funnel: FunnelStage[];
} | null): MetricsSectionView[] {
  if (!m) return [];
  const sections: MetricsSectionView[] = [];
  const sources = (m.sources ?? []).filter((s) => s.visits > 0);
  if (sources.length) {
    sections.push({
      title: "Where they came from",
      rows: sources.map((s) => ({ label: s.source, value: s.visits.toLocaleString("en-US"), explanation: "" })),
    });
  }
  for (const stage of m.funnel ?? []) {
    const rows = stage.rows
      .filter((r) => !isZeroValue(r.value))
      .map((r) => ({ label: r.label, value: r.value, explanation: FUNNEL_EXPLANATIONS[r.key] ?? "" }));
    if (rows.length) sections.push({ title: stage.stage, rows });
  }
  return sections;
}
