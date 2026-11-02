// Shared (client + server) Grow-section constants and types.

export const GROW_TABS = ["grow", "campaigns", "links", "analytics"] as const;
export type GrowTab = (typeof GROW_TABS)[number];
export const GROW_TAB_LABELS: Record<GrowTab, string> = {
  grow: "Grow",
  campaigns: "Campaigns",
  links: "Links",
  analytics: "Analytics",
};

export function parseGrowTab(raw: string | null): GrowTab {
  return (GROW_TABS as readonly string[]).includes(raw ?? "") ? (raw as GrowTab) : "grow";
}

export const ANALYTICS_RANGES = [1, 7, 30, 90] as const; // same pills as iOS AnalyticsView

// ── Analytics (get_analytics_page) ───────────────────────────────────────────
export type AnalyticsPage = {
  views_total: number;
  views_prev_period: number;
  unique_visitors: number;
  chat_opens: number;
  service_clicks: number;
  booking_modal_opens: number;
  external_link_clicks: number;
  requests_sent: number;
  views_by_day: Array<{ date: string; count: number }>;
  top_countries: Array<{ country_code: string; count: number }>;
  top_cities: Array<{ city: string; country_code: string | null; count: number }>;
  top_sources: Array<{ source: string; provider: string | null; count: number }>;
  widget_stats?: Array<{ widget_type: string; plays?: number; seen?: number; plays_tracked?: boolean }> | null;
  top_ctas?: Array<{ label: string; count: number }> | null;
  attention?: { visits: number; median_seconds: number | null; avg_scroll_pct: number | null } | null;
  action_button_clicks?: Array<{ source: string; provider?: string | null; count: number }> | null;
  shop_stats?: Array<{ provider: string; seen?: number; clicks?: number }> | null;
  private_links: Array<{
    id: string;
    title: string;
    link_slug: string;
    page_type: string;
    is_active: boolean;
    views: number;
    unique_visitors: number;
    clicks: number;
  }>;
};

// ── Links tab ────────────────────────────────────────────────────────────────
export type LinkRow = {
  id: string;
  title: string;
  link_slug: string;
  page_type: string;
  external_url: string | null;
  is_active: boolean;
  created_at: string | null;
};

// get_link_metrics(p_link_id) — Models/LinkMetrics.swift
export type LinkMetrics = {
  link_id: string;
  sources: Array<{ source: string; visits: number }>;
  funnel: Array<{ stage: string; rows: Array<{ key: string; label: string; value: string }> }>;
};
