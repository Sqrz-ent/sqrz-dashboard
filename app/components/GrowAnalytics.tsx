import { useState } from "react";
import { Link } from "react-router";
import { ANALYTICS_RANGES, type AnalyticsPage } from "~/lib/grow";

const ACCENT = "#F5A623";

const card: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px" };
const sectionTitle: React.CSSProperties = { margin: "0 0 10px", fontSize: 12, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: ACCENT };

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-US");

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BarList({ title, rows }: { title: string; rows: Array<{ label: string; count: number }> }) {
  const visible = rows.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  const max = Math.max(...visible.map((r) => r.count));
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={sectionTitle}>{title}</h2>
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map((r) => (
          <div key={r.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{r.label}</span>
              <span style={{ fontWeight: 700 }}>{n(r.count)}</span>
            </div>
            <div style={{ height: 4, background: "var(--surface-muted)", borderRadius: 2, marginTop: 4 }}>
              <div style={{ width: `${Math.max(4, (r.count / max) * 100)}%`, height: 4, background: ACCENT, borderRadius: 2 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Top countries, but each row is clickable (tap/click again to clear) —
// mirrors the iOS Analytics tab's "tap a country to filter Top Cities".
function CountryList({
  rows,
  selected,
  onSelect,
}: {
  rows: Array<{ code: string; count: number }>;
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  const visible = rows.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  const max = Math.max(...visible.map((r) => r.count));
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={sectionTitle}>Top countries</h2>
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map((r) => {
          const isSelected = selected === r.code;
          const dimmed = selected != null && !isSelected;
          return (
            <button
              key={r.code}
              type="button"
              onClick={() => onSelect(r.code)}
              style={{
                background: "none", border: "none", padding: 0, margin: 0,
                textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
                opacity: dimmed ? 0.4 : 1,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>{r.code}{isSelected ? " ✕" : ""}</span>
                <span style={{ fontWeight: 700 }}>{n(r.count)}</span>
              </div>
              <div style={{ height: 4, background: "var(--surface-muted)", borderRadius: 2, marginTop: 4 }}>
                <div style={{ width: `${Math.max(4, (r.count / max) * 100)}%`, height: 4, background: ACCENT, borderRadius: 2 }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Top cities, optionally filtered to one country — shows a clearable chip in
// the header when a filter is active.
function CityList({
  rows,
  filterCode,
  onClear,
}: {
  rows: Array<{ label: string; count: number }>;
  filterCode: string | null;
  onClear: () => void;
}) {
  const visible = rows.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  const max = Math.max(...visible.map((r) => r.count));
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h2 style={{ ...sectionTitle, margin: 0 }}>Top cities</h2>
        {filterCode && (
          <button
            type="button"
            onClick={onClear}
            style={{
              background: "transparent", border: `1px solid ${ACCENT}`, borderRadius: 999,
              color: ACCENT, fontSize: 11, fontWeight: 700, padding: "2px 10px", cursor: "pointer",
            }}
          >
            {filterCode} ✕
          </button>
        )}
      </div>
      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map((r) => (
          <div key={r.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{r.label}</span>
              <span style={{ fontWeight: 700 }}>{n(r.count)}</span>
            </div>
            <div style={{ height: 4, background: "var(--surface-muted)", borderRadius: 2, marginTop: 4 }}>
              <div style={{ width: `${Math.max(4, (r.count / max) * 100)}%`, height: 4, background: ACCENT, borderRadius: 2 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Profile-level analytics (get_analytics_page) — the iOS Analytics pill: views,
// audience/locations, engagement, content & clicks. Read-only; only non-empty
// sections render, like iOS.
export default function GrowAnalytics({ data, days }: { data: AnalyticsPage | null; days: number }) {
  if (!data) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Analytics aren't available right now.</p>;
  }
  const trend = data.views_prev_period > 0 ? Math.round(((data.views_total - data.views_prev_period) / data.views_prev_period) * 100) : null;
  const maxDay = Math.max(1, ...data.views_by_day.map((d) => d.count));
  const engagement: Array<[string, number]> = [
    ["Chat opens", data.chat_opens],
    ["Service clicks", data.service_clicks],
    ["Booking form opens", data.booking_modal_opens],
    ["External link clicks", data.external_link_clicks],
    ["Requests sent", data.requests_sent],
  ];
  const att = data.attention;

  // Tap a country to filter Top Cities to just that country's cities (mirrors
  // the iOS Analytics tab). Re-tapping the same country, or the clear chip in
  // Top Cities' header, clears it. top_cities_by_country (up to 12 per
  // country) is what's filtered, falling back to the global top_cities list
  // if that field is absent.
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  function selectCountry(code: string) {
    setSelectedCountry((prev) => (prev === code ? null : code));
  }
  const cityPool = data.top_cities_by_country ?? data.top_cities;
  const visibleCities = selectedCountry ? cityPool.filter((c) => c.country_code === selectedCountry) : data.top_cities;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, margin: "0 0 20px", flexWrap: "wrap" }}>
        {ANALYTICS_RANGES.map((d) => (
          <Link
            key={d}
            to={`/grow?tab=analytics&days=${d}`}
            style={{
              textDecoration: "none", fontSize: 13, fontWeight: 600, padding: "6px 14px", borderRadius: 999,
              border: `1px solid ${d === days ? ACCENT : "var(--border)"}`,
              background: d === days ? ACCENT : "transparent", color: d === days ? "#111" : "var(--text-muted)",
            }}
          >
            {d === 1 ? "24h" : `${d}d`}
          </Link>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Stat label="Profile views" value={n(data.views_total)} sub={trend == null ? undefined : `${trend >= 0 ? "▲" : "▼"} ${Math.abs(trend)}% vs previous period`} />
        <Stat label="Unique visitors" value={n(data.unique_visitors)} />
      </div>

      {data.views_by_day.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h2 style={sectionTitle}>Views by day</h2>
          <div style={{ ...card, display: "flex", alignItems: "flex-end", gap: 3, height: 110 }}>
            {data.views_by_day.map((d) => (
              <div key={d.date} title={`${d.date}: ${d.count}`} style={{ flex: 1, minWidth: 2, height: `${Math.max(3, (d.count / maxDay) * 100)}%`, background: ACCENT, borderRadius: 2 }} />
            ))}
          </div>
        </div>
      )}

      <BarList title="Top sources" rows={data.top_sources.map((s) => ({ label: s.provider ? `${s.source} · ${s.provider}` : s.source, count: s.count }))} />

      {engagement.some(([, v]) => v > 0) && (
        <div style={{ marginBottom: 20 }}>
          <h2 style={sectionTitle}>Engagement</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            {engagement.filter(([, v]) => v > 0).map(([label, v]) => <Stat key={label} label={label} value={n(v)} />)}
          </div>
        </div>
      )}

      <BarList title="Top buttons" rows={(data.top_ctas ?? []).map((c) => ({ label: c.label, count: c.count }))} />
      <BarList title="Action button" rows={(data.action_button_clicks ?? []).map((c) => ({ label: c.provider ? `${c.source} · ${c.provider}` : c.source, count: c.count }))} />
      <BarList title="Music & video plays" rows={(data.widget_stats ?? []).map((w) => ({ label: w.widget_type, count: w.plays ?? 0 }))} />
      <BarList title="Shop clicks" rows={(data.shop_stats ?? []).map((s) => ({ label: s.provider, count: s.clicks ?? 0 }))} />

      {att && (att.median_seconds || att.avg_scroll_pct) ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
          {att.median_seconds ? <Stat label="Median time on page" value={`${Math.round(att.median_seconds)}s`} /> : null}
          {att.avg_scroll_pct ? <Stat label="Avg. scroll depth" value={`${Math.round(att.avg_scroll_pct)}%`} /> : null}
        </div>
      ) : null}

      {/* Locations — last on the page; countries are clickable to filter the cities below them. */}
      <CountryList
        rows={data.top_countries.map((c) => ({ code: c.country_code, count: c.count }))}
        selected={selectedCountry}
        onSelect={selectCountry}
      />
      <CityList
        rows={visibleCities.map((c) => ({ label: c.country_code ? `${c.city}, ${c.country_code}` : c.city, count: c.count }))}
        filterCode={selectedCountry}
        onClear={() => setSelectedCountry(null)}
      />
    </div>
  );
}
