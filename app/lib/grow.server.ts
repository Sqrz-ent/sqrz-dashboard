import type { SupabaseClient } from "@supabase/supabase-js";
import type { CampaignLite, CampaignTemplate } from "~/lib/templates";
import { visibleTemplates } from "~/lib/templates";
import type { AnalyticsPage, LinkRow } from "~/lib/grow";

// Data for the web Grow section's tabs (Grow · Campaigns · Links · Analytics) —
// the same tables/RPCs the iOS Grow tab reads (campaign_templates,
// private_booking_links, get_analytics_page, get_link_metrics). All reads go
// through the user-scoped client, so RLS / the RPCs' ownership checks apply.

// ── Grow tab: template cards ──────────────────────────────────────────────────
export async function loadGrowTemplates(supabase: SupabaseClient, profileId: string) {
  const [{ data: rows }, { data: camps }] = await Promise.all([
    supabase.from("campaign_templates").select("*").order("sort_order", { ascending: true }),
    supabase.from("boost_campaigns").select("campaign_template, status").eq("profile_id", profileId),
  ]);
  return {
    templates: visibleTemplates((rows ?? []) as CampaignTemplate[]),
    campaigns: (camps ?? []) as CampaignLite[],
    supabaseUrl: process.env.SUPABASE_URL ?? null,
  };
}

export async function loadAnalyticsPage(supabase: SupabaseClient, profileId: string, days: number) {
  const { data } = await supabase.rpc("get_analytics_page", {
    p_profile_id: profileId.toLowerCase(),
    p_days: days,
  });
  return (data ?? null) as AnalyticsPage | null;
}

export async function loadLinks(supabase: SupabaseClient, profileId: string) {
  const [{ data: links }, analytics] = await Promise.all([
    supabase
      .from("private_booking_links")
      .select("id, title, link_slug, page_type, external_url, is_active, created_at")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false }),
    loadAnalyticsPage(supabase, profileId, 30), // iOS shows "Last 30 days" next to each link
  ]);
  const stats: Record<string, { views: number; unique_visitors: number; clicks: number }> = {};
  for (const l of analytics?.private_links ?? []) stats[l.id] = { views: l.views, unique_visitors: l.unique_visitors, clicks: l.clicks };
  return { links: (links ?? []) as LinkRow[], stats };
}

