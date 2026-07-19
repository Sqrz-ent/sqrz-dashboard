import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/_app.analytics";
import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// ─── Types ────────────────────────────────────────────────────────────────────

type CountryRow = { country_code: string; count: number };
type SourceRow = { source: string; count: number };
type CityRow = { city: string; country_code: string | null; count: number };
type LeadRow = { email: string; collected_at: string };

type PrivateLinkStat = {
  id: string;
  title: string;
  link_slug: string;
  page_type: string;
  is_active: boolean;
  profile_slug: string;
  views: number;
  unique_visitors: number;
  clicks: number;
  leads: number;
};

type BoostCampaignStat = {
  id: string;
  promote_type: string;
  status: string;
  budget_amount: number;
  budget_currency: string;
  starts_at: string | null;
  ends_at: string | null;
  utm_campaign: string | null;
  // SQRZ site-side measurement. driven_views comes from jitsu page_view (one per
  // real load — matches Meta). driven_unique is null for campaigns: jitsu is
  // cookieless, so unique visitors is not measurable (reason carried alongside).
  driven_views: number | null;
  driven_unique: number | null;
  driven_unique_reason: string | null;
  modal_opens: number | null;
  chat_opens: number | null;
  service_clicks: number | null;
  cta_clicks: number | null;
  widget_opens: number | null;
  // Platform-reported (entered from the ad platform, e.g. Meta Ads Manager)
  stat_impressions: number | null;
  stat_reach: number | null;
  stat_profile_visits: number | null;
  stat_link_clicks: number | null;
  stat_cost_per_click: number | null;
  stat_cpm: number | null;
  stat_channel_breakdown: Record<string, unknown> | unknown[] | null;
  stat_creative_breakdown: Record<string, unknown> | unknown[] | null;
};

// Cookieless engagement (session_id: null by design) — aggregated straight
// from jitsu_events by profile_id + event_type, no session join.
type WidgetPlatformStat = {
  platform: string; // 'spotify' | 'soundcloud'
  visible: number;
  plays: number;
  pauses: number;
  finishes: number;
  m25: number;
  m50: number;
  m75: number;
};

type CtaStat = { label: string; url: string; count: number };

type CookielessMetrics = {
  widgets: WidgetPlatformStat[];
  page: {
    exits: number;
    avg_time_on_page_seconds: number;
    avg_max_scroll_depth_pct: number;
  };
  cta: CtaStat[];
};

type AnalyticsData = {
  views_total: number;
  views_prev_period: number;
  unique_visitors: number;
  booking_requests: number;
  confirmed_bookings: number;
  top_countries: CountryRow[];
  top_sources: SourceRow[];
  top_cities: CityRow[];
  chat_opens: number;
  service_clicks: number;
  booking_modal_opens: number;
  external_link_clicks: number;
  payment_gate_clicks: number;
  payment_gate_unlocks: number;
  requests_sent: number;
  leads: LeadRow[];
  private_links: PrivateLinkStat[];
  boost_campaigns: BoostCampaignStat[];
};

// ─── Cookieless aggregation ─────────────────────────────────────────────────

const COOKIELESS_EVENT_TYPES = [
  "widget_visible",
  "widget_play",
  "widget_pause",
  "widget_finish",
  "widget_progress",
  "page_exit",
  "cta_click",
] as const;

type RawEvent = { event_type: string; event_properties: Record<string, unknown> | null };

function aggregateCookieless(rows: RawEvent[]): CookielessMetrics {
  const widgetMap = new Map<string, WidgetPlatformStat>();
  const getWidget = (platform: string): WidgetPlatformStat => {
    let w = widgetMap.get(platform);
    if (!w) {
      w = { platform, visible: 0, plays: 0, pauses: 0, finishes: 0, m25: 0, m50: 0, m75: 0 };
      widgetMap.set(platform, w);
    }
    return w;
  };

  let scrollSum = 0;
  let timeSum = 0;
  let exits = 0;

  const ctaMap = new Map<string, CtaStat>();

  for (const row of rows) {
    const p = row.event_properties ?? {};
    switch (row.event_type) {
      case "widget_visible":
        getWidget(String(p.widget_type ?? "unknown")).visible++;
        break;
      case "widget_play":
        getWidget(String(p.widget_type ?? "unknown")).plays++;
        break;
      case "widget_pause":
        getWidget(String(p.widget_type ?? "unknown")).pauses++;
        break;
      case "widget_finish":
        getWidget(String(p.widget_type ?? "unknown")).finishes++;
        break;
      case "widget_progress": {
        const w = getWidget(String(p.widget_type ?? "unknown"));
        const m = Number(p.milestone_pct);
        if (m === 25) w.m25++;
        else if (m === 50) w.m50++;
        else if (m === 75) w.m75++;
        break;
      }
      case "page_exit": {
        exits++;
        timeSum += Number(p.time_on_page_seconds) || 0;
        scrollSum += Number(p.max_scroll_depth_pct) || 0;
        break;
      }
      case "cta_click": {
        const url = String(p.link_url ?? "");
        const label = String(p.link_label ?? url ?? "link");
        const key = `${label}${url}`;
        const c = ctaMap.get(key) ?? { label, url, count: 0 };
        c.count++;
        ctaMap.set(key, c);
        break;
      }
    }
  }

  const widgets = [...widgetMap.values()].sort(
    (a, b) => b.plays + b.visible - (a.plays + a.visible)
  );
  const cta = [...ctaMap.values()].sort((a, b) => b.count - a.count);

  return {
    widgets,
    page: {
      exits,
      avg_time_on_page_seconds: exits ? Math.round(timeSum / exits) : 0,
      avg_max_scroll_depth_pct: exits ? Math.round(scrollSum / exits) : 0,
    },
    cta,
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") ?? "30");

  const admin = createSupabaseAdminClient();
  const { data } = await admin.rpc("get_analytics_page", {
    p_profile_id: profile.id,
    p_days: days,
  });

  const analytics = (data as unknown as AnalyticsData) ?? null;

  // New cookieless events are queried directly from jitsu_events (no migration).
  // They carry session_id: null by design, so we aggregate by profile_id +
  // event_type within the window — never joining on session_id.
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: rawEvents } = await admin
    .from("jitsu_events")
    .select("event_type, event_properties")
    .eq("profile_id", profile.id)
    .gte("created_at", sinceIso)
    .in("event_type", COOKIELESS_EVENT_TYPES as unknown as string[])
    .limit(50_000);

  const cookieless = aggregateCookieless((rawEvents as RawEvent[]) ?? []);

  // Latest stored advisor run per campaign — rendered immediately on load so a
  // prior result is just there (no click-to-reveal). One bounded query per
  // campaign (there are only a handful of live/completed campaigns).
  const boostIds = ((analytics?.boost_campaigns ?? []) as Array<{ id: string }>).map(
    (c) => c.id
  );
  const advisorRuns: Record<string, unknown> = {};
  if (boostIds.length > 0) {
    const runs = await Promise.all(
      boostIds.map((id) =>
        admin
          .from("campaign_advisor_runs")
          .select("result")
          .eq("boost_campaign_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      )
    );
    boostIds.forEach((id, i) => {
      const r = runs[i]?.data?.result;
      if (r) advisorRuns[id] = r;
    });
  }

  return Response.json(
    { analytics, cookieless, days, profile, advisorRuns },
    { headers }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFlag(cc: string): string {
  return cc
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397))
    .join("");
}

function sourceIcon(source: string): string {
  const s = source.toLowerCase();
  if (s === "direct" || s === "(direct)" || s === "") return "🔗";
  if (s.includes("instagram")) return "📸";
  if (s.includes("tiktok")) return "🎵";
  if (s.includes("facebook") || s.includes("fb")) return "📘";
  if (s.includes("twitter") || s.includes("x.com")) return "🐦";
  if (s.includes("youtube")) return "▶️";
  if (s.includes("linkedin")) return "💼";
  if (s.includes("google")) return "🔍";
  if (s.includes("spotify")) return "🎧";
  if (s.includes("whatsapp")) return "💬";
  return "🌐";
}

function trendLabel(current: number, prev: number): { text: string; up: boolean } | null {
  if (!prev) return null;
  const pct = Math.round(((current - prev) / prev) * 100);
  return { text: `${pct >= 0 ? "+" : ""}${pct}%`, up: pct >= 0 };
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const page: React.CSSProperties = {
  padding: "28px 20px 60px",
  maxWidth: 860,
  margin: "0 auto",
  fontFamily: FONT_BODY,
  color: "var(--text)",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginBottom: 12,
  display: "block",
};

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: "18px 20px",
};

const statValue: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 36,
  fontWeight: 800,
  lineHeight: 1,
  color: "var(--text)",
  marginBottom: 4,
};

const statLabel: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  fontWeight: 500,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  trend,
}: {
  label: string;
  value: number;
  trend?: { text: string; up: boolean } | null;
}) {
  return (
    <div style={card}>
      <div style={statValue}>{value.toLocaleString()}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={statLabel}>{label}</span>
        {trend && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: trend.up ? "#22c55e" : "#ef4444",
              background: trend.up ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              borderRadius: 6,
              padding: "2px 6px",
            }}
          >
            {trend.text}
          </span>
        )}
      </div>
    </div>
  );
}

function BarRow({
  label,
  prefix,
  count,
  max,
}: {
  label: string;
  prefix?: string;
  count: number;
  max: number;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 13,
          marginBottom: 4,
          color: "var(--text)",
        }}
      >
        <span>
          {prefix && <span style={{ marginRight: 6 }}>{prefix}</span>}
          {label}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{count.toLocaleString()}</span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: "var(--surface-muted)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: ACCENT,
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}

function InlineStat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        ...card,
        textAlign: "center",
        flex: "1 1 0",
        minWidth: 0,
        padding: "14px 12px",
      }}
    >
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 28,
          fontWeight: 800,
          color: "var(--text)",
          lineHeight: 1,
          marginBottom: 4,
        }}
      >
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{label}</div>
    </div>
  );
}

// Defensive flattener for the platform-reported breakdown JSONB. Its exact
// shape isn't set yet (always null so far), so handle both an array of objects
// and a plain object map without assuming a schema.
function breakdownToMetrics(data: unknown): { label: string; value: string | null }[] {
  if (data == null) return [];
  if (Array.isArray(data)) {
    return data.map((item, idx) => {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const label = String(o.name ?? o.label ?? o.channel ?? o.creative ?? `#${idx + 1}`);
        const val = o.value ?? o.impressions ?? o.clicks ?? o.spend;
        return { label, value: val != null ? String(val) : JSON.stringify(o) };
      }
      return { label: `#${idx + 1}`, value: String(item) };
    });
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
      label: k,
      value: v != null && typeof v !== "object" ? String(v) : JSON.stringify(v),
    }));
  }
  return [{ label: "value", value: String(data) }];
}

type AdvisorInsight = {
  type: "working" | "watch" | "action";
  text: string;
};
type AdvisorActionItem = {
  action: string;
  reason: string;
  confidence: "high" | "medium" | "low";
};
type AdvisorResponse = {
  health?: "excellent" | "good" | "mixed" | "needs_attention";
  summary?: string;
  insights?: AdvisorInsight[];
  actions?: AdvisorActionItem[];
  error?: string;
};

const HEALTH_META: Record<string, { label: string; color: string; bg: string }> = {
  excellent: { label: "Excellent", color: "#22c55e", bg: "rgba(34,197,94,0.14)" },
  good: { label: "Good", color: "#22c55e", bg: "rgba(34,197,94,0.10)" },
  mixed: { label: "Mixed", color: ACCENT, bg: "rgba(245,166,35,0.14)" },
  needs_attention: { label: "Needs attention", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};
const CONFIDENCE_COLOR: Record<string, string> = {
  high: "#22c55e",
  medium: ACCENT,
  low: "var(--text-muted)",
};
const INSIGHT_META: Record<string, { icon: string; color: string }> = {
  working: { icon: "✓", color: "#22c55e" },
  watch: { icon: "⚠", color: ACCENT },
  action: { icon: "🔴", color: "#ef4444" },
};

// AI Advisor card — sits BELOW the raw metric panels: the user reads the stats
// first, then optionally clicks for interpretation. Manual trigger only — no
// auto-run, no polling, no caching. Renders the structured advisor response
// (health badge, working/watch, action cards, warnings, numbered next steps).
function CampaignAdvisorCard({
  campaignId,
  initialResult,
}: {
  campaignId: string;
  initialResult?: AdvisorResponse;
}) {
  const fetcher = useFetcher<AdvisorResponse>();
  const loading = fetcher.state !== "idle";
  // A stored result renders immediately; once a fresh call returns, its
  // response takes over. The button below always triggers a new call.
  const data = fetcher.data ?? initialResult;
  const hasResult =
    !!data &&
    !data.error &&
    !!(data.summary || data.health || data.insights?.length || data.actions?.length);
  const health = data?.health ? HEALTH_META[data.health] : null;

  function run() {
    fetcher.submit(
      { campaign_id: campaignId },
      { method: "post", action: "/api/campaign-advisor" }
    );
  }

  return (
    <div
      style={{
        background: "var(--surface-muted)",
        border: `1px solid ${ACCENT}`,
        borderRadius: 10,
        padding: "14px 16px",
        marginTop: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: hasResult || loading ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 14 }}>✨</span>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text)" }}>
            AI Advisor
          </span>
          {!loading && health && (
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 8px", borderRadius: 999, background: health.bg, color: health.color, marginLeft: 4 }}>
              {health.label}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 12px",
            borderRadius: 8,
            border: "none",
            background: ACCENT,
            color: "#fff",
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.7 : 1,
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {loading ? "Analyzing…" : hasResult ? "Refresh insights" : "Get advisor insights"}
        </button>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Reading your campaign numbers…
        </div>
      )}

      {!loading && data?.error && (
        <div style={{ fontSize: 13, color: "#ef4444" }}>
          Couldn’t generate insights right now. Please try again.
        </div>
      )}

      {!loading && hasResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {data?.summary && (
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap" }}>
              {data.summary}
            </div>
          )}

          {(data?.insights?.length ?? 0) > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {data!.insights!.map((it, i) => {
                const meta = INSIGHT_META[it.type] ?? INSIGHT_META.watch;
                return (
                  <div key={i} style={{ display: "flex", gap: 7, fontSize: 13, lineHeight: 1.5, color: "var(--text)" }}>
                    <span style={{ color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                    <span>{it.text}</span>
                  </div>
                );
              })}
            </div>
          )}

          {(data?.actions?.length ?? 0) > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data!.actions!.map((a, i) => (
                <div
                  key={i}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "10px 12px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 3 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{a.action}</div>
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: CONFIDENCE_COLOR[a.confidence] ?? "var(--text-muted)", flexShrink: 0, whiteSpace: "nowrap" }}>
                      {a.confidence} confidence
                    </span>
                  </div>
                  {a.reason && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{a.reason}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A labelled group of metric rows for a boost campaign — used to keep the
// two measurement sources (SQRZ site-side vs platform-reported) visually
// separate. Renders a muted empty state when the source has no data yet.
function CampaignMetricPanel({
  title,
  subtitle,
  accent,
  metrics,
}: {
  title: string;
  subtitle: string;
  accent: string;
  metrics: { label: string; value: string | null }[];
}) {
  const shown = metrics.filter((m) => m.value !== null);
  return (
    <div
      style={{
        flex: "1 1 220px",
        minWidth: 0,
        background: "var(--surface-muted)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: accent,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: "var(--text)",
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 10 }}>{subtitle}</div>
      {shown.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No data yet</div>
      ) : (
        shown.map((m) => (
          <div
            key={m.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 13,
              padding: "4px 0",
              color: "var(--text)",
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>{m.label}</span>
            <span style={{ fontWeight: 600 }}>{m.value}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { analytics, cookieless, days, profile, advisorRuns } = useLoaderData() as {
    analytics: AnalyticsData | null;
    cookieless: CookielessMetrics | null;
    days: number;
    profile: Record<string, unknown>;
    advisorRuns: Record<string, AdvisorResponse>;
  };
  const slug = profile.slug as string;
  const navigate = useNavigate();

  const cl = cookieless;
  const hasWidgetData = (cl?.widgets?.length ?? 0) > 0;
  // Page-exit count still gates the section; the raw count is no longer displayed.
  const hasPageData = (cl?.page?.exits ?? 0) > 0;
  const widgetIcon = (platform: string) =>
    platform === "spotify" ? "🎧"
    : platform === "soundcloud" ? "🔊"
    : platform === "youtube" ? "▶️"
    : "🎵";

  function setDays(d: number) {
    navigate(`/analytics?days=${d}`, { replace: true });
  }

  const a = analytics;

  // Only campaigns that have actually started show stats — approved/
  // needs_changes/pending haven't run yet.
  const boostCampaigns = (a?.boost_campaigns ?? []).filter(
    (c) => c.status === "live" || c.status === "completed"
  );

  const viewsTrend = a ? trendLabel(a.views_total, a.views_prev_period) : null;

  const maxCountry = a?.top_countries?.[0]?.count ?? 1;
  const maxSource = a?.top_sources?.[0]?.count ?? 1;

  const hasAudience =
    a && (
      (a.top_countries?.length ?? 0) > 0 ||
      (a.top_sources?.length ?? 0) > 0 ||
      (a.top_cities?.length ?? 0) > 0
    );

  return (
    <div style={page}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h1
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 38,
            fontWeight: 800,
            color: ACCENT,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            margin: 0,
            lineHeight: 1,
          }}
        >
          Analytics
        </h1>

        <div style={{ display: "flex", gap: 6 }}>
          {[1, 7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: "7px 16px",
                borderRadius: 999,
                border: `1px solid ${days === d ? ACCENT : "var(--border)"}`,
                background: days === d ? ACCENT : "transparent",
                color: days === d ? "#fff" : "var(--text-muted)",
                fontFamily: FONT_BODY,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* ── Overview ───────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Overview</span>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
          }}
        >
          <StatCard
            label="Profile Views"
            value={a?.views_total ?? 0}
            trend={viewsTrend}
          />
          <StatCard label="Unique Visitors" value={a?.unique_visitors ?? 0} />
          <StatCard label="Booking Requests" value={a?.booking_requests ?? 0} />
          <StatCard label="Confirmed Bookings" value={a?.confirmed_bookings ?? 0} />
        </div>
      </section>

      {/* ── Audience ───────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Audience</span>

        {!hasAudience ? (
          <div
            style={{
              ...card,
              color: "var(--text-muted)",
              fontSize: 14,
              textAlign: "center",
              padding: "32px 20px",
            }}
          >
            No audience data yet
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginBottom: 12,
              }}
            >
              {/* Top Countries */}
              <div style={card}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    marginBottom: 14,
                  }}
                >
                  Top Countries
                </div>
                {(a?.top_countries ?? []).slice(0, 8).map((row) => (
                  <BarRow
                    key={row.country_code}
                    label={row.country_code}
                    prefix={toFlag(row.country_code)}
                    count={row.count}
                    max={maxCountry}
                  />
                ))}
                {(a?.top_countries?.length ?? 0) === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No data yet</div>
                )}
              </div>

              {/* Top Sources */}
              <div style={card}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    marginBottom: 14,
                  }}
                >
                  Top Sources
                </div>
                {(a?.top_sources ?? []).slice(0, 8).map((row) => (
                  <BarRow
                    key={row.source}
                    label={row.source || "Direct"}
                    prefix={sourceIcon(row.source)}
                    count={row.count}
                    max={maxSource}
                  />
                ))}
                {(a?.top_sources?.length ?? 0) === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No data yet</div>
                )}
              </div>
            </div>

            {/* Top Cities */}
            {(a?.top_cities?.length ?? 0) > 0 && (
              <div style={card}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    marginBottom: 14,
                  }}
                >
                  Top Cities
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                    gap: "6px 20px",
                  }}
                >
                  {(a?.top_cities ?? []).slice(0, 12).map((row, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 13,
                        padding: "5px 0",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    >
                      <span>
                        {row.city}
                        {row.country_code && (
                          <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                            {row.country_code}
                          </span>
                        )}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>{row.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Engagement ─────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Engagement</span>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
          }}
        >
          <InlineStat label="Booking Modal Opens" value={a?.booking_modal_opens ?? 0} />
          <InlineStat label="External Link Clicks" value={a?.external_link_clicks ?? 0} />
          <InlineStat label="Payment Gate Clicks" value={a?.payment_gate_clicks ?? 0} />
          <InlineStat label="Requests Sent" value={a?.requests_sent ?? 0} />
        </div>
      </section>

      {/* ── Widget Engagement (cookieless) ─────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Widget Engagement</span>
        {!hasWidgetData ? (
          <div style={{ ...card, color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "32px 20px" }}>
            No music widget engagement yet
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {(cl?.widgets ?? []).map((w) => {
              // Finishes and the 25/50/75% listen-through block are intentionally
              // not shown: users sample on SQRZ and move to Spotify/SoundCloud to
              // actually listen through, so low finish/listen-through numbers read
              // as "broken tracking" rather than the normal behaviour they are.
              // Spotify iframes expose no playback API at all, so they show only
              // Seen plus a note.
              const playbackMeasurable = w.platform !== "spotify";
              // Stat tiles sit in a single row.
              const tileRow: React.CSSProperties = {
                display: "flex",
                gap: 8,
              };
              return (
                <div key={w.platform} style={card}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ fontSize: 16 }}>{widgetIcon(w.platform)}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", textTransform: "capitalize" }}>
                      {w.platform}
                    </span>
                  </div>
                  {playbackMeasurable ? (
                    <div style={tileRow}>
                      <InlineStat label="Seen" value={w.visible} />
                      <InlineStat label="Plays" value={w.plays} />
                    </div>
                  ) : (
                    <>
                      <div style={{ ...tileRow, marginBottom: 12 }}>
                        <InlineStat label="Seen" value={w.visible} />
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        Play and pause aren’t measurable via Spotify embeds.
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Page Engagement (cookieless) ───────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Page Engagement</span>
        {!hasPageData ? (
          <div style={{ ...card, color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "32px 20px" }}>
            No page engagement data yet
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <div style={{ ...card, textAlign: "center", flex: "1 1 0", minWidth: 0, padding: "14px 12px" }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 800, color: "var(--text)", lineHeight: 1, marginBottom: 4 }}>
                {fmtDuration(cl?.page.avg_time_on_page_seconds ?? 0)}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>Avg Time on Page</div>
            </div>
            <div style={{ ...card, textAlign: "center", flex: "1 1 0", minWidth: 0, padding: "14px 12px" }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 800, color: "var(--text)", lineHeight: 1, marginBottom: 4 }}>
                {cl?.page.avg_max_scroll_depth_pct ?? 0}%
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>Avg Scroll Depth</div>
            </div>
          </div>
        )}
      </section>

      {/* ── Private Links ──────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Private Links</span>
        <div style={card}>
          {(a?.private_links?.length ?? 0) === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "24px 0" }}>
              No private links yet
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(a?.private_links ?? []).map((link, i) => {
                const pageTypeIcon = link.page_type === "book" ? "📅" : link.page_type === "event" ? "🎤" : "📥";
                const statParts = [
                  `${link.views.toLocaleString()} views`,
                  `${link.unique_visitors.toLocaleString()} unique`,
                  link.clicks > 0 ? `${link.clicks.toLocaleString()} clicks` : null,
                  link.leads > 0 ? `${link.leads.toLocaleString()} leads` : null,
                ].filter(Boolean).join(" · ");
                return (
                  <div
                    key={link.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 20,
                      padding: "14px 0",
                      borderBottom: i < (a?.private_links?.length ?? 0) - 1 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, minWidth: 0 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                          {pageTypeIcon} {link.title}
                        </span>
                      </div>
                      <a
                        href={`https://${slug}.sqrz.com/${link.link_slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12, color: ACCENT, textDecoration: "none" }}
                      >
                        {slug}.sqrz.com/{link.link_slug}
                      </a>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: 7,
                        flexShrink: 0,
                        textAlign: "right",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                        <span
                          style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: link.page_type === "book" ? "rgba(34,197,94,0.1)" : link.page_type === "event" ? "rgba(245,166,35,0.12)" : "rgba(136,136,136,0.12)",
                          color: link.page_type === "book" ? "#22c55e" : link.page_type === "event" ? ACCENT : "var(--text-muted)",
                          }}
                        >
                          {link.page_type}
                        </span>
                        <span
                          style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: link.is_active ? "rgba(34,197,94,0.1)" : "rgba(136,136,136,0.1)",
                          color: link.is_active ? "#22c55e" : "var(--text-muted)",
                          }}
                        >
                          {link.is_active ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {statParts}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── Leads ──────────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <span style={sectionLabel}>Leads</span>
        <div style={card}>
          {(a?.leads?.length ?? 0) === 0 ? (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                textAlign: "center",
                padding: "24px 0",
              }}
            >
              No leads captured yet — emails from your profile and private links will appear here
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
                fontFamily: FONT_BODY,
              }}
            >
              <thead>
                <tr>
                  {["Email", "Collected"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "0 0 10px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(a?.leads ?? []).slice(0, 50).map((row, i) => (
                  <tr key={i}>
                    <td
                      style={{
                        padding: "10px 0",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    >
                      {row.email}
                    </td>
                    <td
                      style={{
                        padding: "10px 0",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--text-muted)",
                        paddingRight: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.collected_at ? fmtDate(row.collected_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ── Boost Campaigns ────────────────────────────────────────────────── */}
      <section>
        <span style={sectionLabel}>Boost Campaigns</span>
        <div style={card}>
          {boostCampaigns.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "24px 0" }}>
              No live or completed campaigns yet — stats appear once a Boost campaign starts
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {boostCampaigns.map((c, i) => {
                const statusColors: Record<string, { color: string; bg: string }> = {
                  pending:   { color: ACCENT,      bg: "rgba(245,166,35,0.12)" },
                  preparing: { color: ACCENT,      bg: "rgba(245,166,35,0.12)" },
                  live:      { color: "#22c55e",   bg: "rgba(34,197,94,0.1)"  },
                  completed: { color: "var(--text-muted)", bg: "rgba(136,136,136,0.12)" },
                  cancelled: { color: "#ef4444",   bg: "rgba(239,68,68,0.1)"  },
                };
                const sc = statusColors[c.status] ?? statusColors.pending;
                const cur = (c.budget_currency ?? "").toUpperCase();
                const money = (v: number | null) =>
                  v != null ? `${cur} ${Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : null;
                const dateRange = c.starts_at
                  ? `${fmtDate(c.starts_at)}${c.ends_at ? ` – ${fmtDate(c.ends_at)}` : ""}`
                  : null;

                // SQRZ site-side — always shown (0 is a real measurement).
                // "Booking flow opens" = booking_modal_open, which already
                // includes every service-listing click (each fires both a
                // service_click and a modal open), so the two are unified into
                // this one line rather than double-counted. Chat opens omitted
                // until the mobile app ships (tracking still recorded).
                const siteMetrics = [
                  { label: "Views driven", value: (c.driven_views ?? 0).toLocaleString() },
                  // Kept as a row (not removed) even though it's null — campaign
                  // traffic is cookieless, so unique visitors can't be measured.
                  { label: "Unique visitors", value: c.driven_unique != null ? c.driven_unique.toLocaleString() : "n/a — cookieless" },
                  { label: "Booking flow opens", value: (c.modal_opens ?? 0).toLocaleString() },
                  { label: "CTA clicks", value: (c.cta_clicks ?? 0).toLocaleString() },
                  { label: "Widget opens", value: (c.widget_opens ?? 0).toLocaleString() },
                ];
                // Platform-reported — shown only when the platform has reported it.
                const platformMetrics = [
                  { label: "Impressions", value: c.stat_impressions != null ? c.stat_impressions.toLocaleString() : null },
                  { label: "Reach", value: c.stat_reach != null ? c.stat_reach.toLocaleString() : null },
                  { label: "Landing page views", value: c.stat_profile_visits != null ? c.stat_profile_visits.toLocaleString() : null },
                  { label: "Link clicks", value: c.stat_link_clicks != null ? c.stat_link_clicks.toLocaleString() : null },
                  { label: "Cost / click", value: money(c.stat_cost_per_click) },
                  { label: "CPM", value: money(c.stat_cpm) },
                ];

                return (
                  <div
                    key={c.id}
                    style={{
                      padding: "16px 0",
                      borderBottom: i < boostCampaigns.length - 1 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    {/* Header: campaign identity + status */}
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 12 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", textTransform: "capitalize", marginBottom: 4 }}>
                          {c.promote_type} Campaign
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {c.budget_amount.toLocaleString()} {cur} budget
                          {dateRange && <span style={{ marginLeft: 8 }}>{dateRange}</span>}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: sc.bg,
                        color: sc.color,
                        flexShrink: 0,
                      }}>
                        {c.status}
                      </span>
                    </div>

                    {/* Two separate measurement sources — never merged. */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      <CampaignMetricPanel
                        title="SQRZ · site-side"
                        subtitle="Measured on your profile"
                        accent={ACCENT}
                        metrics={siteMetrics}
                      />
                      <CampaignMetricPanel
                        title="Meta reports"
                        subtitle="Platform-reported · may differ from site-side"
                        accent="#3b82f6"
                        metrics={platformMetrics}
                      />
                    </div>

                    {/* Platform-reported breakdowns (rendered only when present) */}
                    {(c.stat_channel_breakdown != null || c.stat_creative_breakdown != null) && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
                        {c.stat_channel_breakdown != null && (
                          <CampaignMetricPanel
                            title="Meta · channels"
                            subtitle="Platform-reported breakdown"
                            accent="#3b82f6"
                            metrics={breakdownToMetrics(c.stat_channel_breakdown)}
                          />
                        )}
                        {c.stat_creative_breakdown != null && (
                          <CampaignMetricPanel
                            title="Meta · creatives"
                            subtitle="Platform-reported breakdown"
                            accent="#3b82f6"
                            metrics={breakdownToMetrics(c.stat_creative_breakdown)}
                          />
                        )}
                      </div>
                    )}

                    {/* AI Advisor — below the raw stats: interpretation on demand. */}
                    <CampaignAdvisorCard campaignId={c.id} initialResult={advisorRuns?.[c.id]} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
