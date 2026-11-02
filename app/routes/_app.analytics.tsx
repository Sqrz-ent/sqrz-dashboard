import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.analytics";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { pageContainerStyle } from "~/components/PageContainer";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import CampaignPipeline from "~/components/CampaignPipeline";
import GrowTabs from "~/components/GrowTabs";
import TemplateCards from "~/components/TemplateCards";
import GrowLinks from "~/components/GrowLinks";
import GrowAnalytics from "~/components/GrowAnalytics";
import { loadCampaignPipeline, type CampaignPipelineData } from "~/lib/campaigns.server";
import { loadAnalyticsPage, loadGrowTemplates, loadLinks } from "~/lib/grow.server";
import { ANALYTICS_RANGES, parseGrowTab, type AnalyticsPage, type GrowTab, type LinkRow } from "~/lib/grow";
import type { CampaignLite, CampaignTemplate } from "~/lib/templates";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// The Grow section — mirrors the iOS Grow tab: pills Grow · Campaigns · Links ·
// Analytics (?tab=). Grow = campaign template cards (start a campaign), Campaigns
// = the read-only pipeline, Links = read-only links + stats, Analytics = profile
// analytics. The ONLY iOS-exclusive action is paying for / activating a campaign.
// Route path stays /analytics (old /boost, /links bookmarks redirect here). Only
// the active tab's data is loaded.
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) return redirect("/login", { headers });
  const profileId = profile.id as string;

  const url = new URL(request.url);
  const tab = parseGrowTab(url.searchParams.get("tab"));
  const daysParam = Number(url.searchParams.get("days"));
  const days = (ANALYTICS_RANGES as readonly number[]).includes(daysParam) ? daysParam : 30;

  switch (tab) {
    case "campaigns":
      return Response.json({ tab, pipeline: await loadCampaignPipeline(supabase, profileId) }, { headers });
    case "links":
      return Response.json({ tab, slug: profile.slug as string, ...(await loadLinks(supabase, profileId)) }, { headers });
    case "analytics":
      return Response.json({ tab, days, analytics: await loadAnalyticsPage(supabase, profileId, days) }, { headers });
    default:
      return Response.json({ tab, ...(await loadGrowTemplates(supabase, profileId)) }, { headers });
  }
}

type GrowData =
  | { tab: "grow"; templates: CampaignTemplate[]; campaigns: CampaignLite[]; supabaseUrl: string | null; createEnabled: boolean }
  | { tab: "campaigns"; pipeline: CampaignPipelineData }
  | { tab: "links"; slug: string; links: LinkRow[]; stats: Record<string, { views: number; unique_visitors: number; clicks: number }> }
  | { tab: "analytics"; days: number; analytics: AnalyticsPage | null };

export default function GrowPage() {
  const data = useLoaderData<typeof loader>() as unknown as GrowData;
  const tab: GrowTab = data.tab;

  return (
    <div style={pageContainerStyle}>
      <h1
        style={{
          fontFamily: FONT_DISPLAY, fontSize: 38, fontWeight: 800, color: ACCENT, textTransform: "uppercase",
          letterSpacing: "0.03em", margin: "0 0 16px", lineHeight: 1,
        }}
      >
        Grow
      </h1>
      <GrowTabs active={tab} />

      {/* The kanban uses the full container; the other tabs stay narrow, centered INSIDE it,
          so the title and tab bar above never move when switching tabs. */}
      {data.tab === "campaigns" ? (
        <CampaignPipeline
          campaigns={data.pipeline.campaigns}
          budgets={data.pipeline.budgets}
          templateNames={data.pipeline.templateNames}
          metrics={data.pipeline.metrics}
        />
      ) : (
        <div>
          {data.tab === "grow" && <TemplateCards templates={data.templates} campaigns={data.campaigns} supabaseUrl={data.supabaseUrl} createEnabled={data.createEnabled} />}
          {data.tab === "links" && <GrowLinks links={data.links} stats={data.stats} slug={data.slug} />}
          {data.tab === "analytics" && <GrowAnalytics data={data.analytics} days={data.days} />}
        </div>
      )}
    </div>
  );
}
