import { useEffect, useLayoutEffect, useRef } from "react";
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

  return (
    <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
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
      </div>
    </div>
  );
}

// The board is the one exception to the standard page container: it breaks out of the
// 680px column and spans the page width, with the same 16px side padding as the header,
// so it never touches the screen edges. The title and pills above it stay in the container.
// Width/offset are measured from the real page width (excluding the scrollbar — a plain
// 100vw would overshoot by the scrollbar's width on desktop); the CSS values below are the
// no-JS / first-paint fallback.
const BOARD_SIDE_PADDING = 16;
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function useFullWidthBreakout(ref: React.RefObject<HTMLDivElement | null>) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.marginLeft = "0px";
      el.style.width = "auto";
      const left = el.getBoundingClientRect().left; // where the container would put it
      el.style.marginLeft = `${BOARD_SIDE_PADDING - left}px`;
      el.style.width = `${document.documentElement.clientWidth - BOARD_SIDE_PADDING * 2}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [ref]);
}

// Board layout. Narrow: columns scroll horizontally with snapping (86% wide, the next
// one peeking — like iOS). Wide (the board itself ≥ 600px): the three columns share the
// width equally, all visible, no scrolling. A container query on the board's own width
// (not the viewport) decides, so it's correct whatever the page padding is.
const KANBAN_CSS = `
.kb-wrap { container-type: inline-size; container-name: kb; margin-left: calc(50% - 50vw + 16px); width: calc(100vw - 32px); }
.kb-board { display: flex; align-items: flex-start; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 8px; }
.kb-col { flex: 0 0 min(86%, 360px); scroll-snap-align: start; background: var(--surface); border-radius: 12px; overflow: hidden; min-width: 0; overflow-wrap: anywhere; }
@container kb (min-width: 600px) {
  .kb-board { overflow-x: visible; scroll-snap-type: none; }
  .kb-col { flex: 1 1 0; }
}
`;

// The read-only campaign pipeline (Needs Action / In Progress / Completed kanban) shown
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
  const boardRef = useRef<HTMLDivElement>(null);
  useFullWidthBreakout(boardRef);

  return (
    <>
      {campaigns.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 20 }}>
          <p style={{ margin: "0 0 10px", fontSize: 14 }}>No campaigns yet for this profile.</p>
          <ManageInAppNote />
        </div>
      ) : (
        // The iOS kanban board: lanes side by side as columns that scroll
        // horizontally (snapping, a peek of the next column) — never stacked.
        <div className="kb-wrap" ref={boardRef}>
        <style>{KANBAN_CSS}</style>
        <div className="kb-board">
          {lanes.map((lane) => {
            let items = campaigns.filter((c) => laneFor(c) === lane);
            // In Progress sorts by proximity to running (live, approved, in review, rest);
            // the other lanes keep the newest-first order they load in — same as iOS.
            if (lane === "inProgress") items = [...items].sort((a, b) => inProgressRank(a) - inProgressRank(b));
            return (
              <section
                key={lane}
                className="kb-col"
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
                  <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: ACCENT }}>
                    {LANE_TITLES[lane]}
                  </h2>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <p style={{ margin: 0, padding: 16, fontSize: 14, color: "var(--text-muted)" }}>Nothing here yet</p>
                ) : (
                  items.map((c, i) => (
                    <div
                      key={c.id}
                      style={{
                        borderTop: i === 0 ? "none" : "1px solid var(--border)",
                        // iOS gives In Progress extra separation between its taller cards.
                        paddingTop: i === 0 || lane !== "inProgress" ? 0 : 10,
                      }}
                    >
                      <CampaignCard
                        c={c}
                        budget={budgets[c.id]}
                        templateName={c.campaign_template ? templateNames[c.campaign_template] : undefined}
                        metrics={metrics[c.id] ?? null}
                      />
                    </div>
                  ))
                )}
              </section>
            );
          })}
        </div>
        </div>
      )}
    </>
  );
}
