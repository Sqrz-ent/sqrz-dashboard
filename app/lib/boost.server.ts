import { createSupabaseAdminClient } from "~/lib/supabase.server";

// Boost campaign lifecycle (matches boost_campaigns_status_check, boost rows only).
// 'booked' = paid, no content yet; 'in_review' = content submitted, awaiting review.
export type BoostStatus =
  | "booked"
  | "in_review"
  | "needs_changes"
  | "approved"
  | "live"
  | "completed";

const EDIT_URL = `${process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com"}/boost`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(heading: string, body: string): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:8px 4px;color:#1a1a1a;line-height:1.55;">
    <h1 style="font-size:20px;font-weight:800;margin:0 0 12px;">${heading}</h1>
    ${body}
    <p style="margin-top:28px;font-size:13px;color:#888;">— The SQRZ team</p>
  </div>`;
}

/** Build the transactional email for a transition. Returns null when the state has no email (draft/submitted, and the completed stub). */
function buildStatusEmail(
  status: BoostStatus,
  artistName: string,
  reviewFeedback: string | null
): { subject: string; html: string } | null {
  switch (status) {
    case "in_review":
      return {
        subject: "We're reviewing your campaign",
        html: shell(
          `Hi ${escapeHtml(artistName)}, we're on it 👀`,
          `<p>Thanks for submitting your Boost campaign — our team is reviewing it now. We'll be in touch shortly with next steps.</p>`
        ),
      };
    case "needs_changes":
      return {
        subject: "A quick tweak on your campaign",
        html: shell(
          `Hi ${escapeHtml(artistName)}, one small thing`,
          `<p>We took a look at your campaign and there's a quick change we'd suggest before it goes live:</p>
           <blockquote style="margin:14px 0;padding:12px 14px;background:#faf6ef;border-left:3px solid #F5A623;border-radius:6px;font-size:15px;">${escapeHtml(
             reviewFeedback ?? ""
           )}</blockquote>
           <p><a href="${EDIT_URL}" style="display:inline-block;margin-top:6px;padding:11px 20px;background:#F5A623;color:#111;text-decoration:none;border-radius:8px;font-weight:700;">Update your campaign →</a></p>`
        ),
      };
    case "approved":
    case "live":
      return {
        subject: "Your campaign is live! 🎉",
        html: shell(
          `${escapeHtml(artistName)}, you're live! 🎉`,
          `<p>Your Boost campaign has been approved and is going live. We'll keep an eye on it and share results as they come in.</p>`
        ),
      };
    case "completed":
      // Stub — the performance summary email lands here once sync-back stats exist.
      return null;
    default:
      return null;
  }
}

async function sendStatusEmail(to: string, email: { subject: string; html: string }): Promise<void> {
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "SQRZ <campaigns@sqrz.com>",
      to,
      subject: email.subject,
      html: email.html,
    });
  } catch (err) {
    console.error("[boost] status email send failed:", err);
    // Non-fatal — the transition still stands.
  }
}

/**
 * Single source of truth for boost status changes: writes status +
 * status_updated_at (and review_feedback / launched_at / completed_at where
 * relevant) via the service-role client, then fires the transactional email.
 * Used by both the artist submit/resubmit path and the admin review queue.
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

  const { data: campaign, error } = await admin
    .from("boost_campaigns")
    .update(update)
    .eq("id", campaignId)
    .select("id, profile_id, review_feedback")
    .single();

  if (error || !campaign) {
    return { ok: false, error: error?.message ?? "Campaign not found" };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("email, name, brand_name")
    .eq("id", campaign.profile_id as string)
    .single();

  const email = buildStatusEmail(
    status,
    (profile?.brand_name as string) || (profile?.name as string) || "there",
    (campaign.review_feedback as string | null) ?? null
  );
  if (profile?.email && email) {
    await sendStatusEmail(profile.email as string, email);
  }

  return { ok: true };
}
