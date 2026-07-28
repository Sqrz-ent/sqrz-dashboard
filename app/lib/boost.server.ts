import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export type PrivateLink = {
  id: string;
  label: string | null;
  link_slug: string;
  page_type: string;
};

export type Campaign = {
  id: string;
  created_at: string;
  profile_id: string;
  promote_type: string;
  promote_link_id: string | null;
  promote_service_id: string | null;
  goal: string | null;
  budget_amount: number;
  budget_currency: string;
  notes: string | null;
  // Boost lifecycle: null (awaiting payment) → booked → in_review → needs_changes
  // → approved/live → completed. Grow keeps its own values (pending/preparing).
  status: string | null;
  review_feedback: string | null;
  creative_asset_url: string | null;
  status_updated_at: string | null;
  channel: string | null;
  channels: string[] | null;
  duration: string | null;
  utm_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  starts_at: string | null;
  ends_at: string | null;
  target_audience: string | null;
  campaign_type: string | null;
  fee_pct: number | null;
  fee_amount: number | null;
  stripe_payment_id: string | null;
  stripe_payment_status: string | null;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  requires_payment: boolean | null;
  payment_expires_at: string | null;
  data_source: "live" | "manual" | null;
  live_profile_visits: number | null;
  live_unique_visitors: number | null;
  live_visits_last_7_days: number | null;
  live_engaged: number | null;
  live_service_clicks: number | null;
  live_booking_modal_opens: number | null;
  live_chat_opens: number | null;
  live_download_clicks: number | null;
  campaign_days_elapsed: number | null;
  campaign_duration_days: number | null;
  campaign_days_remaining: number | null;
};

// Shape consumed by <BoostSection> — returned by the Boost route loader and the
// Grow page loader alike, so both render the identical Boost UI (app-download
// prompt + existing-campaign list). One query set, no drift.
export type BoostSectionData = {
  is_beta: boolean;
  campaign_count: number;
  campaigns: Campaign[];
  privateLinks: PrivateLink[];
  email: string;
  profile_id: string;
  profile_slug: string;
  referredByCode: string | null;
};

/**
 * Loads everything <BoostSection> needs for a given profile: the campaign list
 * (with live stats view), the profile's active private links, and the gating
 * flags. Shared by `_app.boost` (standalone route) and `_app.analytics` (the
 * Grow page's BOOST section) so the two never diverge.
 */
export async function loadBoostSectionData(
  supabase: SupabaseClient,
  profile: Record<string, unknown>
): Promise<BoostSectionData> {
  const [{ data: campaigns }, { data: privateLinks }, { count: campaignCount }] =
    await Promise.all([
      supabase
        .from("boost_campaign_stats")
        .select(`
          id, created_at, profile_id, promote_type, promote_link_id,
          promote_service_id, goal, budget_amount, budget_currency,
          notes, status, channel, channels, duration, utm_url, utm_source,
          utm_medium, utm_campaign, utm_content, starts_at, ends_at,
          target_audience, campaign_type, fee_pct, fee_amount,
          review_feedback, creative_asset_url, status_updated_at,
          stripe_payment_id, stripe_payment_status,
          stripe_payment_link_id, stripe_payment_link_url,
          requires_payment, payment_expires_at,
          live_profile_visits, live_unique_visitors,
          live_visits_last_7_days, live_engaged,
          live_service_clicks, live_booking_modal_opens,
          live_chat_opens, live_download_clicks,
          campaign_days_elapsed, campaign_duration_days,
          campaign_days_remaining, data_source
        `)
        .eq("profile_id", profile.id as string)
        .order("created_at", { ascending: false }),
      supabase
        .from("private_booking_links")
        .select("id, label, link_slug, page_type")
        .eq("profile_id", profile.id as string)
        .eq("is_active", true),
      supabase
        .from("boost_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profile.id as string),
    ]);

  return {
    is_beta: (profile.is_beta as boolean) ?? false,
    campaign_count: campaignCount ?? 0,
    campaigns: (campaigns ?? []) as unknown as Campaign[],
    privateLinks: (privateLinks ?? []) as unknown as PrivateLink[],
    email: (profile.email as string) ?? "",
    profile_id: profile.id as string,
    profile_slug: (profile.slug as string) ?? "",
    referredByCode: (profile.referred_by_code as string | null) ?? null,
  };
}

// Boost campaign lifecycle (matches boost_campaigns_status_check, boost rows only).
// 'booked' = paid, no content yet; 'in_review' = content submitted, awaiting review.
export type BoostStatus =
  | "booked"
  | "in_review"
  | "needs_changes"
  | "approved"
  | "live"
  | "completed"
  | "rejected";

/**
 * Single source of truth for boost status changes: writes status +
 * status_updated_at (and review_feedback / launched_at / completed_at where
 * relevant) via the service-role client. The status UPDATE fires the
 * on_boost_campaign_hubspot_sync trigger, which moves the HubSpot deal stage.
 * Used by both the artist submit/resubmit path and the admin review queue.
 *
 * No email is sent — the in-app "your campaigns" status view (including the
 * review feedback shown on needs_changes) is the sole notification path.
 */
export async function transitionBoostCampaign({
  campaignId,
  status,
  reviewFeedback = null,
}: {
  campaignId: string;
  status: BoostStatus;
  reviewFeedback?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const admin = createSupabaseAdminClient();

  const update: Record<string, unknown> = {
    status,
    status_updated_at: new Date().toISOString(),
  };
  if (status === "needs_changes") update.review_feedback = reviewFeedback;
  if (status === "live") update.launched_at = new Date().toISOString();
  if (status === "completed") update.completed_at = new Date().toISOString();

  // .select().single() so a non-existent campaign surfaces as an error.
  const { error } = await admin
    .from("boost_campaigns")
    .update(update)
    .eq("id", campaignId)
    .select("id")
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true };
}
