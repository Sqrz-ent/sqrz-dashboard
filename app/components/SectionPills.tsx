import { Link } from "react-router";
import type { NavPill } from "~/lib/nav";

const ACCENT = "#F5A623";

// The sub-section pill row under a page title — the style the Grow tab introduced,
// now used for every tab that has sub-sections (iOS: a horizontally scrolling pill bar).
export default function SectionPills({ pills }: { pills: NavPill[] }) {
  if (pills.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", margin: "0 0 24px", paddingBottom: 2 }}>
      {pills.map((pill) => (
        <Link
          key={pill.label}
          to={pill.to}
          prefetch="intent"
          aria-current={pill.active ? "page" : undefined}
          style={{
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 600,
            padding: "8px 16px",
            borderRadius: 999,
            border: `1px solid ${pill.active ? ACCENT : "var(--border)"}`,
            background: pill.active ? ACCENT : "transparent",
            color: pill.active ? "#111" : "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {pill.label}
        </Link>
      ))}
    </div>
  );
}
