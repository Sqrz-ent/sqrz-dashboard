import { useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { supabase as browserSupabase } from "~/lib/supabase.client";
import UpgradeModal from "~/components/UpgradeModal";
import type { Campaign, BoostSectionData } from "~/lib/boost.server";

// Presentational Boost UI — campaign creation now lives exclusively in the native
// SQRZ app, so the web dashboard shows an app-download prompt plus the read-only
// list of existing campaigns (payment-resume + creative upload for campaigns that
// were created in the app). Rendered by both `_app.boost` (standalone route) and
// `_app.analytics` (the Grow page's BOOST section). All data arrives via props;
// the content-save fetcher posts to the `/boost` route action.

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "22px 24px",
  marginBottom: 20,
};

const sectionTitle: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 30,
  fontWeight: 800,
  color: ACCENT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.03em",
  margin: "0 0 18px",
  lineHeight: 1.1,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 8,
};

export type BoostSectionProps = BoostSectionData & {
  // When true, renders content-only (no centered page wrapper, no big "Boost"
  // page heading) so it can sit as a section inside the Grow page.
  embedded?: boolean;
};

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  // Boost lifecycle
  booked:          { label: "Add Content",     color: ACCENT,    bg: "rgba(245,166,35,0.15)"  },
  in_review:       { label: "In Review",       color: ACCENT,    bg: "rgba(245,166,35,0.12)"  },
  needs_changes:   { label: "Needs Changes",   color: "#ef4444", bg: "rgba(239,68,68,0.12)"   },
  approved:        { label: "Approved",        color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  rejected:        { label: "Declined",        color: "#ef4444", bg: "rgba(239,68,68,0.12)"   },
  // Shared / Grow
  draft:           { label: "Draft",           color: "#888",    bg: "rgba(136,136,136,0.12)" },
  pending:         { label: "Pending Payment", color: ACCENT,    bg: "rgba(245,166,35,0.15)"  },
  pending_payment: { label: "Pending Payment", color: ACCENT,    bg: "rgba(245,166,35,0.15)"  },
  preparing:       { label: "Preparing",       color: ACCENT,    bg: "rgba(245,166,35,0.12)"  },
  live:            { label: "Live",            color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  completed:       { label: "Completed",       color: "#888",    bg: "rgba(136,136,136,0.12)" },
};

// Ad channel labels for the campaign list rows.
const ALL_CHANNELS = [
  { value: "meta", label: "Meta (Facebook + Instagram)" },
  { value: "google", label: "Google" },
] as const;

function channelLabel(value: string): string {
  return ALL_CHANNELS.find((c) => c.value === value)?.label ?? value;
}
function channelsLabel(values: string[] | null | undefined): string {
  return (values ?? []).map(channelLabel).join(", ");
}

// Campaign creation (Boost + Grow) lives in the native SQRZ app. The web
// dashboard points users to the app's public TestFlight beta.
const TESTFLIGHT_URL = "https://testflight.apple.com/join/qSyFdnSd";

// ── Content form on a booked / needs_changes campaign ─────────────────────────
const CREATIVE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime"];
const CREATIVE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB — matches the profile-media bucket limit; room for short ad video

function BoostContentSection({ campaign: c }: { campaign: Campaign }) {
  const fetcher = useFetcher();
  const needsChanges = c.status === "needs_changes";
  const inReview = c.status === "in_review";

  const [open, setOpen] = useState(needsChanges); // needs_changes opens revised view directly
  const [creativeUrl, setCreativeUrl] = useState<string | null>(c.creative_asset_url ?? null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const busy = fetcher.state !== "idle";
  const data = fetcher.data as { ok?: boolean; error?: string; contentSaved?: boolean } | undefined;
  const submitted = !!data?.contentSaved;

  const rejected = c.status === "rejected";
  const sectionStyle: React.CSSProperties = { borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 };

  // Declined — read-only. This is now the sole notification of a rejection.
  if (rejected) {
    return (
      <div style={sectionStyle}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
          Declined
        </div>
        <p style={{ fontSize: 13, color: "var(--text)", margin: 0, lineHeight: 1.5 }}>
          We're not able to run this campaign as submitted. You won't be charged — we'll take care of your refund manually. You're welcome to start a fresh campaign anytime.
        </p>
      </div>
    );
  }

  // In review — read-only (unless a fresh submit just happened, handled below).
  if (inReview && !submitted) {
    return (
      <div style={sectionStyle}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
          👀 Your content is in review — this page updates as soon as our team responds.
        </p>
      </div>
    );
  }

  async function uploadCreative(file: File) {
    if (!CREATIVE_TYPES.includes(file.type)) {
      setUploadError("Use a JPG, PNG, WebP, GIF, MP4, or MOV.");
      return;
    }
    if (file.size > CREATIVE_MAX_BYTES) {
      setUploadError("File must be under 50 MB.");
      return;
    }
    setUploadError(null);
    setUploading(true);
    const ext = file.name.split(".").pop() || "bin";
    const path = `${c.profile_id}/boost/${c.id}.${ext}`;
    const { error } = await browserSupabase.storage
      .from("profile-media")
      .upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      setUploadError(error.message);
      setUploading(false);
      return;
    }
    const { data: { publicUrl } } = browserSupabase.storage.from("profile-media").getPublicUrl(path);
    // Cache-bust so a re-upload to the same path shows immediately.
    setCreativeUrl(`${publicUrl}?v=${Date.now()}`);
    setUploading(false);
  }

  function submit() {
    const fd = new FormData();
    fd.append("intent", "save_content");
    fd.append("campaign_id", c.id);
    if (creativeUrl) fd.append("creative_asset_url", creativeUrl);
    // Post to the /boost action regardless of which page hosts this component.
    fetcher.submit(fd, { method: "post", action: "/boost" });
  }

  if (submitted) {
    return (
      <div style={sectionStyle}>
        <p style={{ fontSize: 14, color: "#22c55e", fontWeight: 600, margin: 0 }}>
          Got it! Our team is reviewing your campaign 🎉
        </p>
      </div>
    );
  }

  return (
    <div style={sectionStyle}>
      {needsChanges && c.review_feedback && (
        <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>
            Feedback from our team
          </div>
          <div style={{ fontSize: 13, color: "var(--text)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{c.review_feedback}</div>
        </div>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ background: ACCENT, color: "#111", border: "none", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          {needsChanges ? "See feedback and update →" : "Add your content →"}
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Creative</label>
            {creativeUrl ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <a href={creativeUrl} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, fontSize: 13, fontWeight: 600 }}>View uploaded creative →</a>
                <label style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer", textDecoration: "underline" }}>
                  Replace
                  <input type="file" accept={CREATIVE_TYPES.join(",")} style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCreative(f); e.target.value = ""; }} />
                </label>
              </div>
            ) : (
              <label style={{ display: "block", border: "2px dashed var(--border)", borderRadius: 10, padding: "16px", textAlign: "center", cursor: uploading ? "default" : "pointer", background: "var(--bg)", fontSize: 13, color: "var(--text-muted)" }}>
                {uploading ? "Uploading…" : "Upload image or video (JPG, PNG, WebP, GIF, MP4, MOV · max 50 MB)"}
                <input type="file" accept={CREATIVE_TYPES.join(",")} style={{ display: "none" }} disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCreative(f); e.target.value = ""; }} />
              </label>
            )}
            {uploadError && <p style={{ fontSize: 12, color: "#ef4444", margin: "5px 0 0" }}>{uploadError}</p>}
          </div>

          {data?.error && <p style={{ fontSize: 12, color: "#ef4444", margin: 0 }}>{data.error}</p>}

          <button
            type="button"
            onClick={submit}
            disabled={busy || uploading}
            style={{ background: busy || uploading ? "var(--surface-muted)" : ACCENT, color: busy || uploading ? "var(--text-muted)" : "#111", border: "none", borderRadius: 9, padding: "11px 18px", fontSize: 14, fontWeight: 700, cursor: busy || uploading ? "not-allowed" : "pointer", fontFamily: FONT_BODY }}
          >
            {busy ? "Submitting…" : "Submit for review"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function BoostSection({
  campaigns,
  privateLinks,
  plan_id,
  email,
  profile_slug,
  referredByCode,
  creatorMonthlyPriceId,
  creatorYearlyPriceId,
  embedded = false,
}: BoostSectionProps) {
  const navigate = useNavigate();
  const [showPixelUpgrade, setShowPixelUpgrade] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Resume payment for an unpaid campaign created in the app. Reads the campaign's
  // real type so the server applies the correct fee: Grow = 20% management fee,
  // Boost = flat $25 activation fee.
  async function handleRetryPayment(campaign: Campaign) {
    setRetryingId(campaign.id);
    try {
      const res = await fetch("/api/campaigns/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          campaign.campaign_type === "grow"
            ? { campaign_type: "grow", budget_amount: campaign.budget_amount, campaign_id: campaign.id }
            : { campaign_type: "boost", budget_amount: campaign.budget_amount, campaign_id: campaign.id, is_reactivation: false }
        ),
      });
      const data = await res.json();
      if (res.ok && data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    } catch { /* silent */ } finally {
      setRetryingId(null);
    }
  }

  const outerStyle: React.CSSProperties = embedded
    ? { fontFamily: FONT_BODY, color: "var(--text)" }
    : { maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" };

  return (
    <>
    <div style={outerStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: embedded ? "flex-end" : "space-between", marginBottom: embedded ? 16 : 28, gap: 12, flexWrap: "wrap" as const }}>
        {!embedded && (
          <div>
            <h1 style={{ ...sectionTitle, marginBottom: 6 }}>Boost</h1>
          </div>
        )}
        <button
          type="button"
          onClick={() => plan_id ? navigate("/domain") : setShowPixelUpgrade(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 12px",
            borderRadius: 20,
            border: "1px solid var(--border)",
            background: plan_id ? "var(--surface)" : "rgba(245,166,35,0.07)",
            color: plan_id ? "var(--text-muted)" : ACCENT,
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            whiteSpace: "nowrap" as const,
            marginTop: 4,
          }}
        >
          🎯 {plan_id ? "Pixel Settings →" : "Add Retargeting Pixel"}
          {!plan_id && (
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              background: "rgba(245,166,35,0.15)",
              color: ACCENT,
              borderRadius: 20,
              padding: "1px 6px",
              letterSpacing: "0.04em",
              textTransform: "uppercase" as const,
            }}>
              Creator
            </span>
          )}
        </button>
      </div>

      {/* ── New campaigns are created in the native app ────────────────────── */}
      <div style={{ ...card, textAlign: "center" as const }}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 800, color: "var(--text)", textTransform: "uppercase" as const, letterSpacing: "0.04em", margin: "0 0 10px" }}>
          Campaigns are in the app
        </h2>
        <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, margin: "0 0 18px" }}>
          Download the SQRZ app to access campaigns.
        </p>
        <a
          href={TESTFLIGHT_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-block", padding: "13px 22px", background: ACCENT, color: "#111", borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY, letterSpacing: "0.02em" }}
        >
          Get the SQRZ App →
        </a>
      </div>

      {/* ── Active Campaigns ─────────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 16px" }}>
          Active Campaigns
        </h2>

        {campaigns.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No active campaigns</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {campaigns.map((c) => {
              const badge = STATUS_BADGE[c.status ?? ""] ?? STATUS_BADGE.pending;
              // Boost unpaid = null status; Grow unpaid = 'pending'/'draft'.
              const isPending = !c.status || c.status === "draft" || c.status === "pending" || c.status === "pending_payment";
              const isBoost = c.campaign_type === "boost";
              const boostPaidStatuses = ["booked", "in_review", "needs_changes", "approved", "live", "completed"];
              const isPaid = c.status === "live" || c.status === "preparing" || (isBoost && boostPaidStatuses.includes(c.status ?? ""));
              // Content step — purely status-based (Boost & Grow behave identically here).
              const canAddContent = c.status === "booked" || c.status === "needs_changes";
              const isContentInReview = c.status === "in_review";
              const isContentRejected = c.status === "rejected";
              const paymentUrl = c.stripe_payment_link_url
                ? `${c.stripe_payment_link_url}?client_reference_id=${c.id}&prefilled_email=${encodeURIComponent(email)}`
                : null;

              // Pending payment breakdown — mirror the server fee logic so the card
              // shows the real total before checkout: Grow = 20% management fee,
              // Boost = flat $25 activation fee.
              const pendingFee = c.campaign_type === "grow"
                ? Math.round(c.budget_amount * 0.20 * 100) / 100
                : 25;
              const pendingTotal = c.budget_amount + pendingFee;
              const pendingFeeLabel = c.campaign_type === "grow" ? "Management fee (20%)" : "Activation fee";

              return (
                <div
                  key={c.id}
                  style={{
                    background: "var(--bg)",
                    borderRadius: 12,
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column" as const,
                    gap: 0,
                  }}
                >
                  {/* Campaign header row */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" as const }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                        {c.campaign_type === "grow" ? "Grow Campaign" : c.promote_type === "link" ? "Private Link Boost" : "Profile Boost"}
                      </div>
                      {(() => {
                        const chText = c.channels?.length ? channelsLabel(c.channels) : (c.channel ?? "");
                        return chText ? (
                          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                            {chText}{c.duration ? ` · ${c.duration}` : ""}
                          </div>
                        ) : null;
                      })()}
                      {c.target_audience && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                          {c.target_audience}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                        ${c.budget_amount} {c.budget_currency}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                        {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {isPaid && (
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>
                          Paid ✓
                        </span>
                      )}
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase" as const,
                        padding: "4px 10px",
                        borderRadius: 20,
                        background: badge.bg,
                        color: badge.color,
                      }}>
                        {badge.label}
                      </span>
                    </div>
                  </div>

                  {/* Payment section for pending campaigns */}
                  {isPending && (
                    <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 14 }}>
                      <div style={{ marginBottom: 12, fontSize: 13 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 6 }}>
                          <span>Ad budget</span>
                          <span style={{ fontFamily: "monospace" }}>${c.budget_amount.toLocaleString()}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 10 }}>
                          <span>{pendingFeeLabel}</span>
                          <span style={{ fontFamily: "monospace" }}>+${pendingFee.toLocaleString()}</span>
                        </div>
                        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", justifyContent: "space-between", fontWeight: 600, color: "var(--text)", fontSize: 14 }}>
                          <span>Total</span>
                          <span style={{ fontFamily: "monospace" }}>${pendingTotal.toLocaleString()}</span>
                        </div>
                      </div>
                      {paymentUrl ? (
                        <a
                          href={paymentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "12px",
                            background: ACCENT,
                            color: "#111",
                            borderRadius: 10,
                            fontSize: 14,
                            fontWeight: 700,
                            textAlign: "center" as const,
                            textDecoration: "none",
                            cursor: "pointer",
                            fontFamily: FONT_BODY,
                            boxSizing: "border-box" as const,
                            marginBottom: 8,
                          }}
                        >
                          Pay ${pendingTotal.toLocaleString()} →
                        </a>
                      ) : (
                        <button
                          onClick={() => handleRetryPayment(c)}
                          disabled={retryingId === c.id}
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "12px",
                            background: ACCENT,
                            color: "#111",
                            border: "none",
                            borderRadius: 10,
                            fontSize: 14,
                            fontWeight: 700,
                            textAlign: "center" as const,
                            cursor: retryingId === c.id ? "wait" : "pointer",
                            fontFamily: FONT_BODY,
                            boxSizing: "border-box" as const,
                            marginBottom: 8,
                            opacity: retryingId === c.id ? 0.7 : 1,
                          }}
                        >
                          {retryingId === c.id ? "Redirecting…" : `Pay $${pendingTotal.toLocaleString()} →`}
                        </button>
                      )}
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                        Ad budget is separate from your SQRZ subscription. It goes directly toward running your campaigns.
                      </p>
                    </div>
                  )}

                  {/* Campaign destination */}
                  <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10 }}>
                    {(() => {
                      let destination: string;
                      if (c.promote_type === "link" && c.promote_link_id) {
                        const pl = privateLinks.find((l) => l.id === c.promote_link_id);
                        destination = pl
                          ? `${profile_slug}.sqrz.com/${pl.link_slug}`
                          : `${profile_slug}.sqrz.com`;
                      } else if (c.utm_url) {
                        destination = c.utm_url.split("?")[0].replace(/^https?:\/\//, "");
                      } else {
                        destination = `${profile_slug}.sqrz.com`;
                      }
                      return (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.07em", marginBottom: 4 }}>
                            Campaign Destination
                          </div>
                          <div style={{ fontSize: 13, color: "var(--text)" }}>
                            {destination}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Content step: booked → add content, needs_changes → feedback +
                      revise, in_review + rejected → read-only status. */}
                  {(canAddContent || isContentInReview || isContentRejected) && (
                    <BoostContentSection campaign={c} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>

    {showPixelUpgrade && (
      <UpgradeModal
        onClose={() => setShowPixelUpgrade(false)}
        upgradeContext="creator"
        monthlyPriceId={creatorMonthlyPriceId}
        yearlyPriceId={creatorYearlyPriceId}
        referredByCode={referredByCode}
      />
    )}
    </>
  );
}
