import { Link } from "react-router";
import type { LinkRow } from "~/lib/grow";

const ACCENT = "#F5A623";

// The Links tab, read-only: each private link with its last-30-day stats
// (visits / unique / clicks, from get_analytics_page.private_links — same as
// iOS LinksView) and a "More info" page (get_link_metrics). Creating, editing,
// starring and deleting links stays in the SQRZ app.
export default function GrowLinks({
  links,
  stats,
  slug,
}: {
  links: LinkRow[];
  stats: Record<string, { views: number; unique_visitors: number; clicks: number }>;
  slug: string;
}) {
  return (
    <div>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)" }}>
        Read-only. Create and manage links in the SQRZ app. Stats: last 30 days.
      </p>
      {links.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 20, fontSize: 14, color: "var(--text-muted)" }}>
          No private links yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {links.map((l) => {
            const s = stats[l.id] ?? { views: 0, unique_visitors: 0, clicks: 0 };
            const kind = l.external_url ? "External" : "Page";
            return (
              <div key={l.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px", opacity: l.is_active ? 1 : 0.6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <Link to={`/grow/links/${l.id}`} style={{ color: "var(--text)", fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
                    {l.title || l.link_slug}
                  </Link>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{kind}{l.is_active ? "" : " · inactive"}</span>
                </div>
                <a href={`https://${slug}.sqrz.com/${l.link_slug}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>
                  /{l.link_slug}
                </a>
                <div style={{ display: "flex", gap: 20, margin: "12px 0 8px" }}>
                  {[["Visits", s.views], ["Unique", s.unique_visitors], ["Clicks", s.clicks]].map(([label, v]) => (
                    <div key={label as string}>
                      <div style={{ fontSize: 15, fontWeight: 800 }}>{(v as number).toLocaleString("en-US")}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</div>
                    </div>
                  ))}
                </div>
                <Link to={`/grow/links/${l.id}`} style={{ color: ACCENT, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                  More info →
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
