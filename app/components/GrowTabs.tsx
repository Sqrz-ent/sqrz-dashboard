import { Link } from "react-router";
import { GROW_TABS, GROW_TAB_LABELS, type GrowTab } from "~/lib/grow";

const ACCENT = "#F5A623";

// The iOS Grow tab's pill bar: Grow · Campaigns · Links · Analytics.
export default function GrowTabs({ active }: { active: GrowTab }) {
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", margin: "0 0 24px", paddingBottom: 2 }}>
      {GROW_TABS.map((tab) => {
        const isActive = tab === active;
        return (
          <Link
            key={tab}
            to={tab === "grow" ? "/analytics" : `/analytics?tab=${tab}`}
            prefetch="intent"
            style={{
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: 999,
              border: `1px solid ${isActive ? ACCENT : "var(--border)"}`,
              background: isActive ? ACCENT : "transparent",
              color: isActive ? "#111" : "var(--text-muted)",
              whiteSpace: "nowrap",
            }}
          >
            {GROW_TAB_LABELS[tab]}
          </Link>
        );
      })}
    </div>
  );
}
