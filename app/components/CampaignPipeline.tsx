import { Link } from "react-router";
import {
  type CampaignBudgetRow,
  type CampaignMetrics,
  type CampaignRow,
  type PipelineLane,
  LANE_TITLES,
  campaignDisplayName,
  campaignPath,
  formatCents,
  formatDate,
  inProgressRank,
  awaitsPayment,
  isManagedPending,
  keyMetrics,
  laneFor,
} from "~/lib/campaigns";
import { KeyMetricsGrid, ManageInAppNote, PaymentNote, StatusBadge } from "~/components/CampaignParts";

const ACCENT = "#F5A623";

function CampaignCard({
  c, budget, templateName, metrics,
}: {
  c: CampaignRow;
  budget: CampaignBudgetRow | undefined;
  templateName: string | undefined;
  metrics: CampaignMetrics | null;
}) {
  const name = campaignDisplayName(c, templateName);
  const started = formatDate(c.starts_at) ?? formatDate(c.created_at);
  const ends = formatDate(c.ends_at);
  const key = keyMetrics(c, metrics);
  const lane = laneFor(c);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <Link to={campaignPath(c.id)} style={{ color: "var(--text)", fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
            {name}
          </Link>
          {templateName && c.name?.trim() && c.name.trim() !== templateName && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{templateName}</div>
          )}
        </div>
        <StatusBadge campaign={c} />
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
        {started && <span>{c.starts_at ? "Starts" : "Created"} {started}</span>}
        {ends && <span>Ends {ends}</span>}
        <span>
          {budget && budget.allocated_cents > 0
            ? `${formatCents(budget.allocated_cents)} allocated${budget.spent_cents > 0 ? ` · ${formatCents(budget.spent_cents)} spent` : ""}`
            : "No budget allocated"}
        </span>
      </div>

      {c.status?.toLowerCase() === "needs_changes" && c.review_feedback && (
        <div style={{ background: "rgba(239,68,68,0.08)", borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#ef4444", letterSpacing: "0.05em", marginBottom: 4 }}>FEEDBACK FROM OUR TEAM</div>
          <div style={{ fontSize: 12, color: "var(--text)" }}>{c.review_feedback}</div>
        </div>
      )}

      {isManagedPending(c) && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>
          Requested — SQRZ will be in touch to set up your campaign.
        </p>
      )}

      <KeyMetricsGrid items={key} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        {/* Every lane has an iOS action (add content / budget / pause / reactivate). */}
        {awaitsPayment(c) ? <PaymentNote /> : <ManageInAppNote />}
        <Link to={campaignPath(c.id)} style={{ color: ACCENT, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
          {lane === "needsAction" ? "Details →" : "More info →"}
        </Link>
      </div>
    </div>
  );
}

// The read-only campaign pipeline (Needs action / In progress / Completed) shown
// inside Grow — data from loadCampaignPipeline (lib/campaigns.server.ts).
export default function CampaignPipeline({
  campaigns,
  budgets,
  templateNames,
  metrics,
}: {
  campaigns: CampaignRow[];
  budgets: Record<string, CampaignBudgetRow>;
  templateNames: Record<string, string>;
  metrics: Record<string, CampaignMetrics>;
}) {
  const lanes: PipelineLane[] = ["needsAction", "inProgress", "completed"];

  return (
    <>
      {campaigns.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 20 }}>
          <p style={{ margin: "0 0 10px", fontSize: 14 }}>No campaigns yet for this profile.</p>
          <ManageInAppNote />
        </div>
      ) : (
        lanes.map((lane) => {
          let items = campaigns.filter((c) => laneFor(c) === lane);
          if (lane === "inProgress") items = [...items].sort((a, b) => inProgressRank(a) - inProgressRank(b));
          return (
            <section key={lane} style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <h2 style={{ margin: 0, fontSize: 13, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: ACCENT }}>
                  {LANE_TITLES[lane]}
                </h2>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Nothing here.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {items.map((c) => (
                    <CampaignCard
                      key={c.id}
                      c={c}
                      budget={budgets[c.id]}
                      templateName={c.campaign_template ? templateNames[c.campaign_template] : undefined}
                      metrics={metrics[c.id] ?? null}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
