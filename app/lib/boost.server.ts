import { createSupabaseAdminClient } from "~/lib/supabase.server";

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
