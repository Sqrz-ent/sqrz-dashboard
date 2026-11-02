import type { SupabaseClient } from "@supabase/supabase-js";
import type { CampaignBudgetRow, CampaignMetrics, CampaignRow } from "~/lib/campaigns";
import { rendersStats } from "~/lib/campaigns";

export type CampaignPipelineData = {
  campaigns: CampaignRow[];
  budgets: Record<string, CampaignBudgetRow>;
  templateNames: Record<string, string>;
  metrics: Record<string, CampaignMetrics>;
};

// Read-only data for the Grow page's campaign pipeline, for ONE profile. Mirrors
// the sqrz-ios pipeline (Features/Boost/BoostView.swift loadCampaigns /
// loadBudgets / loadCampaignMetrics): boost_campaigns for the profile, each
// campaign's campaign_budgets row embedded, and get_campaign_metrics for the
// campaigns that show stats (Completed + live). All reads go through the
// user-scoped client, so RLS / the RPC's own ownership check apply. No writes.
export async function loadCampaignPipeline(
  supabase: SupabaseClient,
  profileId: string
): Promise<CampaignPipelineData> {
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

  return { campaigns: rows, budgets, templateNames, metrics };
}
