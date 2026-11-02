import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.analytics";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import CampaignPipeline from "~/components/CampaignPipeline";
import { loadCampaignPipeline, type CampaignPipelineData } from "~/lib/campaigns.server";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// The Grow page: a read-only view of the active profile's campaign pipeline
// (mirrors the iOS Grow tab's Campaigns pill — see CampaignPipeline). Creating,
// editing, funding and pausing campaigns happens in the SQRZ iOS app. The route
// path stays /analytics (old /boost, /links bookmarks redirect here).
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  // Read-only campaign pipeline for the ACTIVE profile (mirrors the iOS Grow
  // tab's Campaigns pill).
  const pipeline = await loadCampaignPipeline(supabase, profile.id as string);

  return Response.json({ pipeline }, { headers });
}

export default function AnalyticsPage() {
  const { pipeline } = useLoaderData<typeof loader>() as unknown as { pipeline: CampaignPipelineData };

  return (
    <div
      style={{
        padding: "28px 20px 60px",
        maxWidth: 640,
        margin: "0 auto",
        fontFamily: FONT_BODY,
        color: "var(--text)",
      }}
    >
      <h1
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 38,
          fontWeight: 800,
          color: ACCENT,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          margin: "0 0 8px",
          lineHeight: 1,
        }}
      >
        Grow
      </h1>
      {/* Campaigns — read-only pipeline (mirrors the iOS Grow tab's Campaigns pill) */}
      <section style={{ marginTop: 24 }}>
        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 26,
            fontWeight: 800,
            color: ACCENT,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            margin: "0 0 16px",
            lineHeight: 1,
          }}
        >
          Campaigns
        </h2>
        <CampaignPipeline
          campaigns={pipeline.campaigns}
          budgets={pipeline.budgets}
          templateNames={pipeline.templateNames}
          metrics={pipeline.metrics}
        />
      </section>
    </div>
  );
}
