import { redirect, useLoaderData, Link } from "react-router";
import type { Route } from "./+types/_app.campaigns";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import {
  type CampaignBudgetRow,
  type CampaignMetrics,
  type CampaignRow,
  type PipelineLane,
  LANE_TITLES,
  campaignDisplayName,
  formatCents,
  formatDate,
  inProgressRank,
  isManagedPending,
  keyMetrics,
  laneFor,
  rendersStats,
} from "~/lib/campaigns";
import { KeyMetricsGrid, ManageInAppNote, StatusBadge } from "~/components/CampaignParts";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// Read-only campaigns list for the ACTIVE profile (header switcher). Mirrors the
// sqrz-ios pipeline (Features/Boost/BoostView.swift loadCampaigns /
// loadBudgets / loadCampaignMetrics): boost_campaigns for the profile, each
// campaign's campaign_budgets row embedded, and get_campaign_metrics for the
// campaigns that show stats (Completed + live). All reads go through the user-
// scoped client, so RLS / the RPC's own ownership check apply. No writes.
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) return redirect("/login", { headers });
  const profileId = profile.id as string;

  const [{ data: campaigns }, { data: budgetRows }, { data: templates }] = await Promise.all([
    supabase
      .from("boost_campaigns")
      .select("*")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false }),
    supabase
      .from("boost_campaigns")
      .select("id, campaign_budgets(allocated_cents, spent_cents, status)")
      .eq("profile_id", profileId),
    supabase.from("campaign_templates").select("id, name"),
  ]);

  const rows = (campaigns ?? []) as CampaignRow[];

  const budgets: Record<string, CampaignBudgetRow> = {};
  for (const r of (budgetRows ?? []) as Array<{ id: string; campaign_budgets: CampaignBudgetRow | CampaignBudgetRow[] | null }>) {
    const b = Array.isArray(r.campaign_budgets) ? r.campaign_budgets[0] : r.campaign_budgets;
    if (b) budgets[r.id] = b;
  }

  const templateNames: Record<string, string> = {};
  for (const t of (templates ?? []) as Array<{ id: string; name: string }>) templateNames[t.id] = t.name;

  const metrics: Record<string, CampaignMetrics> = {};
  await Promise.all(
    rows.filter(rendersStats).map(async (c) => {
      const { data } = await supabase.rpc("get_campaign_metrics", { p_campaign_id: c.id });
      if (data) metrics[c.id] = data as CampaignMetrics;
    })
  );

  return Response.json({ campaigns: rows, budgets, templateNames, metrics }, { headers });
}

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
          <Link to={`/campaigns/${c.id}`} style={{ color: "var(--text)", fontWeight: 700, fontSize: 15, textDecoration: "none" }}>
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
        <ManageInAppNote />
        <Link to={`/campaigns/${c.id}`} style={{ color: ACCENT, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
          {lane === "needsAction" ? "Details →" : "More info →"}
        </Link>
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const { campaigns, budgets, templateNames, metrics } = useLoaderData<typeof loader>() as unknown as {
    campaigns: CampaignRow[];
    budgets: Record<string, CampaignBudgetRow>;
    templateNames: Record<string, string>;
    metrics: Record<string, CampaignMetrics>;
  };

  const lanes: PipelineLane[] = ["needsAction", "inProgress", "completed"];

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 38, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 6px", lineHeight: 1 }}>
        Campaigns
      </h1>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 28px", lineHeight: 1.5 }}>
        A read-only view of your campaigns. Start, edit, fund and pause them in the SQRZ app.
      </p>

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
    </div>
  );
}
