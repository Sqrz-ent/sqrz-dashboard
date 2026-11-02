import { redirect, useLoaderData, Link } from "react-router";
import type { Route } from "./+types/_app.campaigns.$id";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import {
  type CampaignBudgetRow,
  type CampaignMetrics,
  type CampaignRow,
  buildMetricsSections,
  campaignDisplayName,
  formatCents,
  formatDate,
  laneFor,
  rendersStats,
} from "~/lib/campaigns";
import { ManageInAppNote, StatusBadge } from "~/components/CampaignParts";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// Read-only campaign detail: the same key metrics + impact funnel as the iOS
// "More info" sheet (BoostView.metricsSections → get_campaign_metrics), with
// zero values dropped. Scoped to the ACTIVE profile — a campaign belonging to a
// different profile of the same login 404s until that profile is selected.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: campaign } = await supabase
    .from("boost_campaigns")
    .select("*")
    .eq("id", params.id)
    .eq("profile_id", profile.id as string)
    .maybeSingle();
  if (!campaign) throw new Response("Campaign not found", { status: 404, headers });
  const c = campaign as CampaignRow;

  const [{ data: budgetRow }, templateRes, metricsRes] = await Promise.all([
    supabase.from("campaign_budgets").select("allocated_cents, spent_cents, status").eq("campaign_id", c.id).maybeSingle(),
    c.campaign_template
      ? supabase.from("campaign_templates").select("name").eq("id", c.campaign_template).maybeSingle()
      : Promise.resolve({ data: null }),
    rendersStats(c)
      ? supabase.rpc("get_campaign_metrics", { p_campaign_id: c.id })
      : Promise.resolve({ data: null }),
  ]);

  return Response.json(
    {
      campaign: c,
      budget: (budgetRow as CampaignBudgetRow | null) ?? null,
      templateName: (templateRes.data as { name: string } | null)?.name ?? null,
      metrics: (metricsRes.data as CampaignMetrics | null) ?? null,
    },
    { headers }
  );
}

function youTubeId(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: "16px 18px",
  marginBottom: 16,
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: ACCENT,
};

function Preview({ c }: { c: CampaignRow }) {
  // sqrz-ios only shows the creative inside its (editable) content sheet; here it
  // is a read-only preview of whatever the campaign promotes.
  const video = youTubeId(c.video_link_url);
  if (c.creative_asset_url) {
    return <img src={c.creative_asset_url} alt="Campaign creative" style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 10, display: "block" }} />;
  }
  if (video) {
    return (
      <a href={c.video_link_url ?? "#"} target="_blank" rel="noopener noreferrer">
        <img src={`https://img.youtube.com/vi/${video}/hqdefault.jpg`} alt="Video thumbnail" style={{ maxWidth: "100%", borderRadius: 10, display: "block" }} />
      </a>
    );
  }
  if (c.existing_post_id) {
    const src = (c.existing_post_source ?? "facebook") === "instagram" ? "Instagram" : "Facebook";
    return <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Promotes an existing {src} post.</p>;
  }
  return null;
}

export default function CampaignDetail() {
  const { campaign: c, budget, templateName, metrics } = useLoaderData<typeof loader>() as unknown as {
    campaign: CampaignRow;
    budget: CampaignBudgetRow | null;
    templateName: string | null;
    metrics: CampaignMetrics | null;
  };

  const sections = buildMetricsSections(metrics, c.budget_currency);
  const name = campaignDisplayName(c, templateName);
  const created = formatDate(c.created_at);
  const hasPreview = !!(c.creative_asset_url || c.video_link_url || c.existing_post_id);
  const showStats = rendersStats(c);
  const remaining = budget ? Math.max(budget.allocated_cents - budget.spent_cents, 0) : 0;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <Link to="/campaigns" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Campaigns</Link>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, margin: "12px 0 6px" }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: 0, lineHeight: 1.05 }}>
          {name}
        </h1>
        <StatusBadge campaign={c} />
      </div>
      <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {templateName ? `${templateName} · ` : ""}
        {created ? `Created ${created}` : ""}
        {c.starts_at ? ` · Starts ${formatDate(c.starts_at)}` : ""}
        {c.ends_at ? ` · Ends ${formatDate(c.ends_at)}` : ""}
      </p>

      {c.status?.toLowerCase() === "needs_changes" && c.review_feedback && (
        <div style={{ ...card, background: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" }}>
          <h2 style={{ ...sectionTitle, color: "#ef4444" }}>Feedback from our team</h2>
          <p style={{ margin: 0, fontSize: 14 }}>{c.review_feedback}</p>
        </div>
      )}

      <div style={card}>
        <h2 style={sectionTitle}>Budget</h2>
        {budget && budget.allocated_cents > 0 ? (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div><div style={{ fontWeight: 800 }}>{formatCents(budget.allocated_cents)}</div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Allocated</div></div>
            <div><div style={{ fontWeight: 800 }}>{formatCents(budget.spent_cents)}</div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Spent</div></div>
            <div><div style={{ fontWeight: 800 }}>{formatCents(remaining)}</div><div style={{ fontSize: 11, color: "var(--text-muted)" }}>Remaining</div></div>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>No budget allocated.</p>
        )}
      </div>

      {hasPreview && (
        <div style={card}>
          <h2 style={sectionTitle}>Creative</h2>
          <Preview c={c} />
          {(c.headline || c.primary_text || c.description) && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              {c.headline && <div style={{ fontWeight: 700, marginBottom: 4 }}>{c.headline}</div>}
              {c.primary_text && <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{c.primary_text}</div>}
              {c.description && <div style={{ color: "var(--text-muted)" }}>{c.description}</div>}
            </div>
          )}
        </div>
      )}

      {showStats ? (
        sections.length > 0 ? (
          sections.map((s) => (
            <div key={s.title} style={{ marginBottom: 16 }}>
              <h2 style={sectionTitle}>{s.title}</h2>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
                {s.rows.map((r, i) => (
                  <div key={r.label} style={{ padding: "12px 16px", borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{r.label}</span>
                      <span style={{ fontSize: 14, fontWeight: 800 }}>{r.value}</span>
                    </div>
                    {r.explanation && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{r.explanation}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div style={card}>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>No results to show yet — numbers appear here once the campaign has traffic.</p>
          </div>
        )
      ) : (
        laneFor(c) !== "completed" && (
          <div style={card}>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>Results appear here once the campaign is live.</p>
          </div>
        )
      )}

      <div style={{ ...card, marginBottom: 0 }}>
        <ManageInAppNote />
      </div>
    </div>
  );
}
