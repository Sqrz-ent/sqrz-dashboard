import { redirect, useLoaderData, useNavigate } from "react-router";
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
type LeadRow = { email: string; link_slug: string | null; created_at: string };

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
  live_profile_visits: number | null;
  live_booking_modal_opens: number | null;
  live_chat_opens: number | null;
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
  download_clicks: number;
  requests_sent: number;
  leads: LeadRow[];
  private_links: PrivateLinkStat[];
  boost_campaigns: BoostCampaignStat[];
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id, request);
  if (!profile) return redirect("/login", { headers });

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") ?? "30");

  const admin = createSupabaseAdminClient();
  const { data } = await admin.rpc("get_analytics_page", {
    p_profile_id: profile.id,
    p_days: days,
  });

  const analytics = (data as unknown as AnalyticsData) ?? null;

  return Response.json(
    { analytics, days, profile },
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { analytics, days, profile } = useLoaderData() as { analytics: AnalyticsData | null; days: number; profile: Record<string, unknown> };
  const slug = profile.slug as string;
  const navigate = useNavigate();

  function setDays(d: number) {
    navigate(`/analytics?days=${d}`, { replace: true });
  }

  const a = analytics;

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
          <InlineStat label="Chat Opens" value={a?.chat_opens ?? 0} />
          <InlineStat label="Booking Modal Opens" value={a?.booking_modal_opens ?? 0} />
          <InlineStat label="Download Clicks" value={a?.download_clicks ?? 0} />
          <InlineStat label="Requests Sent" value={a?.requests_sent ?? 0} />
        </div>
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
              No leads captured yet — add a lead gate to your private links
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
                  {["Email", "Link"].map((h) => (
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
                      }}
                    >
                      {row.link_slug ?? "—"}
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
          {(a?.boost_campaigns?.length ?? 0) === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "24px 0" }}>
              No campaigns yet — start a Boost campaign to track performance
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(a?.boost_campaigns ?? []).map((c, i) => {
                const statusColors: Record<string, { color: string; bg: string }> = {
                  pending:   { color: ACCENT,      bg: "rgba(245,166,35,0.12)" },
                  preparing: { color: ACCENT,      bg: "rgba(245,166,35,0.12)" },
                  live:      { color: "#22c55e",   bg: "rgba(34,197,94,0.1)"  },
                  completed: { color: "var(--text-muted)", bg: "rgba(136,136,136,0.12)" },
                  cancelled: { color: "#ef4444",   bg: "rgba(239,68,68,0.1)"  },
                };
                const sc = statusColors[c.status] ?? statusColors.pending;
                const statParts = [
                  (c.live_profile_visits ?? 0) > 0 ? `${(c.live_profile_visits ?? 0).toLocaleString()} views driven` : null,
                  (c.live_booking_modal_opens ?? 0) > 0 ? `${(c.live_booking_modal_opens ?? 0).toLocaleString()} modal opens` : null,
                  (c.live_chat_opens ?? 0) > 0 ? `${(c.live_chat_opens ?? 0).toLocaleString()} chat opens` : null,
                ].filter(Boolean).join(" · ");
                const dateRange = c.starts_at
                  ? `${fmtDate(c.starts_at)}${c.ends_at ? ` – ${fmtDate(c.ends_at)}` : ""}`
                  : null;
                return (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 20,
                      padding: "14px 0",
                      borderBottom: i < (a?.boost_campaigns?.length ?? 0) - 1 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, minWidth: 0 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", textTransform: "capitalize" }}>
                          {c.promote_type} Campaign
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {c.budget_amount.toLocaleString()} {c.budget_currency.toUpperCase()} budget
                        {dateRange && <span style={{ marginLeft: 8 }}>{dateRange}</span>}
                      </div>
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
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: sc.bg,
                        color: sc.color,
                      }}>
                        {c.status}
                      </span>
                      {statParts && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{statParts}</div>
                      )}
                    </div>
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
