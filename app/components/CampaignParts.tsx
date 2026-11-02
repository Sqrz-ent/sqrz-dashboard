import type { CampaignRow } from "~/lib/campaigns";
import { MANAGE_IN_APP_NOTE, statusLabel, statusTone } from "~/lib/campaigns";

const TONES: Record<string, string> = {
  green: "#22c55e",
  orange: "#f97316",
  muted: "var(--text-muted)",
  red: "#ef4444",
  blue: "#3b82f6",
  accent: "#F5A623",
};

export function StatusBadge({ campaign }: { campaign: CampaignRow }) {
  const color = TONES[statusTone(campaign)];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "4px 9px",
        borderRadius: 999,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(campaign)}
    </span>
  );
}

// iOS shows an action here (add content, allocate budget, pause, reactivate…);
// the web dashboard is read-only, so it points to the app instead.
export function ManageInAppNote() {
  return (
    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden>📱</span>
      {MANAGE_IN_APP_NOTE}
    </p>
  );
}

export function KeyMetricsGrid({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
        gap: 12,
        background: "var(--surface-muted)",
        borderRadius: 10,
        padding: 12,
      }}
    >
      {items.map((i) => (
        <div key={i.label}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{i.value}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{i.label}</div>
        </div>
      ))}
    </div>
  );
}
