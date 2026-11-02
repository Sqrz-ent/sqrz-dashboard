import { Link } from "react-router";
import {
  type CampaignLite,
  type CampaignTemplate,
  budgetRangeDisplay,
  displayPriceText,
  outletPills,
  proIncludedText,
  templateAvailability,
  templateImageUrl,
  unlockProgressCount,
} from "~/lib/templates";

const ACCENT = "#F5A623";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "var(--text-muted)" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{value}</div>
    </div>
  );
}

function CardBody({ t, supabaseUrl }: { t: CampaignTemplate; supabaseUrl: string | null }) {
  const img = templateImageUrl(t.image_file, supabaseUrl ?? undefined);
  const pro = proIncludedText(t);
  const pills = outletPills(t);
  return (
    <>
      <div
        style={{
          position: "relative",
          height: 140,
          background: img
            ? `linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0)), url(${img}) center/cover`
            : `linear-gradient(135deg, rgba(245,166,35,0.35), rgba(245,166,35,0.08))`,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 17 }}>{t.name}</div>
          {t.subtitle && <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 13 }}>{t.subtitle}</div>}
        </div>
        {pills.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {pills.map((p) => (
              <span key={p} style={{ background: "rgba(0,0,0,0.45)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 999 }}>
                {p}
              </span>
            ))}
          </div>
        )}
        {t.visibility === "beta" && (
          <span style={{ position: "absolute", top: 10, right: 10, background: ACCENT, color: "#111", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 999 }}>
            BETA
          </span>
        )}
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        {t.description && <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>{t.description}</div>}
        {pro && <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>{pro}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <Stat label="Price" value={displayPriceText(t)} />
          <Stat label="Budget range" value={budgetRangeDisplay(t)} />
        </div>
      </div>
    </>
  );
}

// The Grow tab's template cards — same campaign_templates rows, order, lock and
// unlock rules as iOS (BoostView.templateCard). An open card starts the create
// flow; locked / unlock-gated / coming-soon cards are previews only.
export default function TemplateCards({
  templates,
  campaigns,
  supabaseUrl,
  createEnabled,
}: {
  templates: CampaignTemplate[];
  campaigns: CampaignLite[];
  supabaseUrl: string | null;
  // app_config.web_campaign_create_enabled. false → cards are display-only (no create link).
  createEnabled: boolean;
}) {
  if (templates.length === 0) {
    return <p style={{ fontSize: 14, color: "var(--text-muted)" }}>No campaign templates are available yet.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {templates.map((t) => {
        const a = templateAvailability(t, campaigns);
        const shell: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, overflow: "hidden" };

        if (a.kind === "coming_soon") {
          // iOS lockedTemplateRow: compact, greyed, not interactive.
          return (
            <div key={t.id} style={{ ...shell, opacity: 0.55, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
              <span aria-hidden>🔒</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                {t.subtitle && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t.subtitle}</div>}
              </div>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Coming soon</span>
            </div>
          );
        }

        if (a.kind === "unlock_gated") {
          const min = t.unlock_min_count ?? 0;
          return (
            <div key={t.id} style={{ ...shell, position: "relative" }}>
              <div style={{ opacity: 0.5 }}>
                <CardBody t={t} supabaseUrl={supabaseUrl} />
              </div>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, pointerEvents: "none" }}>
                <div style={{ background: "rgba(0,0,0,0.65)", color: "#fff", padding: "12px 16px", borderRadius: 14, textAlign: "center", fontSize: 13, fontWeight: 600 }}>
                  🔒 {a.label ?? `Unlock by running ${min} campaign${min === 1 ? "" : "s"}`}
                  <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.8, marginTop: 4 }}>
                    {unlockProgressCount(t, campaigns)} of {min} done
                  </div>
                </div>
              </div>
            </div>
          );
        }

        const long = t.long_description?.trim();
        return (
          <div key={t.id} style={shell}>
            {a.kind === "open" && createEnabled ? (
              <Link to={`/analytics/campaigns/new/${t.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                <CardBody t={t} supabaseUrl={supabaseUrl} />
                <div style={{ padding: "0 14px 14px", color: ACCENT, fontSize: 13, fontWeight: 700 }}>
                  {t.delivery === "contact" ? "Request this campaign →" : "Create campaign →"}
                </div>
              </Link>
            ) : (
              <>
                <CardBody t={t} supabaseUrl={supabaseUrl} />
                {a.kind === "app_only" && (
                  <p style={{ margin: 0, padding: "0 14px 14px", fontSize: 12, color: "var(--text-muted)" }}>Set up in the SQRZ app</p>
                )}
              </>
            )}
            {long && (
              <details style={{ borderTop: "1px solid var(--border)", padding: "10px 14px" }}>
                <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: ACCENT }}>More info</summary>
                <p style={{ margin: "10px 0 0", fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{long}</p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
