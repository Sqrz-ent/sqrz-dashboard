import { useState, useEffect } from "react";
import { useFetcher, useNavigate } from "react-router";
import { supabase as browserSupabase } from "~/lib/supabase.client";
import type { Campaign, BoostSectionData } from "~/lib/boost.server";

// Presentational Boost UI — a single-type campaign creation form (flat 20% SQRZ
// fee, no minimum, no activation fee) visible to every logged-in user on web,
// plus the list of existing campaigns (payment-resume + creative upload).
// Rendered by both `_app.boost` (standalone route) and `_app.analytics` (the Grow
// page's BOOST section). All data arrives via props; the create + content-save
// fetchers post to the `/boost` route action, and checkout is kicked off client-
// side against `/api/campaigns/checkout`.

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

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 13px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 14,
  color: "var(--text)",
  outline: "none",
  boxSizing: "border-box" as const,
  fontFamily: FONT_BODY,
  resize: "vertical" as const,
  lineHeight: 1.5,
};

// Budget preset pills (unchanged) — the ad-spend amount the flat 20% fee applies to.
const BUDGET_OPTIONS = [
  { value: 50, label: "$50" },
  { value: 100, label: "$100" },
  { value: 150, label: "$150" },
] as const;

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
  email,
  profile_slug,
  embedded = false,
}: BoostSectionProps) {
  const navigate = useNavigate();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Resume payment for an unpaid campaign created in the app. The server applies
  // a flat 20% SQRZ fee on the ad budget for every campaign type.
  async function handleRetryPayment(campaign: Campaign) {
    setRetryingId(campaign.id);
    try {
      const res = await fetch("/api/campaigns/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_type: campaign.campaign_type ?? "boost",
          budget_amount: campaign.budget_amount,
          campaign_id: campaign.id,
        }),
      });
      const data = await res.json();
      if (res.ok && data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    } catch { /* silent */ } finally {
      setRetryingId(null);
    }
  }

  // ── Campaign creation form (single type · flat 20% fee) ────────────────────
  const [promoteType, setPromoteType] = useState<string | null>(null);
  const [promoteLinkId, setPromoteLinkId] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState("");
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [boostSuccess, setBoostSuccess] = useState(false);
  const [boostError, setBoostError] = useState<string | null>(null);

  const createFetcher = useFetcher();
  const isSubmitting = createFetcher.state !== "idle";
  const actionData = createFetcher.data as {
    ok?: boolean; error?: string; campaignId?: string; budget_amount?: number;
  } | undefined;

  // After the /boost action creates the campaign row, kick off Stripe checkout
  // with the server-returned budget. The server computes the flat 20% fee.
  useEffect(() => {
    if (!actionData?.ok || boostSuccess || !actionData.campaignId) return;
    setBoostSuccess(true);
    setPromoteType(null);
    setPromoteLinkId("");
    setDuration(null);
    setGoal(null);
    setBudget(null);
    setTargetAudience("");
    setNotes("");
    fetch("/api/campaigns/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_type: "boost",
        budget_amount: actionData.budget_amount,
        campaign_id: actionData.campaignId,
      }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.checkout_url) window.location.href = d.checkout_url; })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData?.ok, actionData?.campaignId]);

  const canSubmit =
    !!promoteType &&
    (promoteType !== "link" || !!promoteLinkId) &&
    !!duration && !!goal && budget != null;

  function handleSubmit() {
    if (!canSubmit) {
      if (!promoteType) setBoostError("Please select what to promote.");
      else if (promoteType === "link" && !promoteLinkId) setBoostError("Please select a link.");
      else if (!goal) setBoostError("Please select a goal.");
      else if (!duration) setBoostError("Please select a duration.");
      else if (budget == null) setBoostError("Please select a budget.");
      return;
    }
    setBoostError(null);
    setBoostSuccess(false);
    const fd = new FormData();
    fd.append("campaign_type", "boost");
    fd.append("promote_type", promoteType!);
    fd.append("promote_link_id", promoteLinkId);
    fd.append("channels", "meta");
    fd.append("duration", duration!);
    fd.append("goal", goal!);
    fd.append("target_audience", targetAudience);
    fd.append("notes", notes);
    fd.append("budget_amount", String(budget));
    // Post to the /boost action regardless of which page hosts this component.
    createFetcher.submit(fd, { method: "post", action: "/boost" });
  }

  function pillStyle(selected: boolean): React.CSSProperties {
    return {
      padding: "8px 16px",
      borderRadius: 24,
      border: selected ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
      background: selected ? "rgba(245,166,35,0.1)" : "var(--bg)",
      color: selected ? ACCENT : "var(--text-muted)",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      fontFamily: FONT_BODY,
      transition: "all 0.15s",
      whiteSpace: "nowrap" as const,
    };
  }

  const promoteField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>What do you want to promote?</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        <button type="button" onClick={() => setPromoteType("profile")} style={pillStyle(promoteType === "profile")}>
          My Profile
        </button>
        <button type="button" onClick={() => setPromoteType("link")} style={pillStyle(promoteType === "link")}>
          A Private Link
        </button>
      </div>
      {promoteType === "link" && (
        <select
          value={promoteLinkId}
          onChange={(e) => setPromoteLinkId(e.target.value)}
          style={{
            marginTop: 10,
            width: "100%",
            padding: "10px 13px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 14,
            color: promoteLinkId ? "var(--text)" : "var(--text-muted)",
            outline: "none",
            boxSizing: "border-box" as const,
            fontFamily: FONT_BODY,
            cursor: "pointer",
          }}
        >
          <option value="">Select a link…</option>
          {privateLinks.map((link) => (
            <option key={link.id} value={link.id}>
              {link.label || link.link_slug}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  const channelField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Where do you want to be seen?</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        <button type="button" disabled style={{ ...pillStyle(true), opacity: 1, cursor: "default" }}>
          {channelLabel("meta")}
        </button>
      </div>
    </div>
  );

  const goalField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>What's your goal?</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {[
          { label: "Get Bookings", value: "bookings" },
          { label: "Get Visibility", value: "visibility" },
          { label: "Grow Audience", value: "audience" },
        ].map((g) => (
          <button key={g.value} type="button" onClick={() => setGoal(g.value)} style={pillStyle(goal === g.value)}>
            {g.label}
          </button>
        ))}
      </div>
    </div>
  );

  const durationField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Campaign Duration</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {["1 Week", "2 Weeks", "4 Weeks"].map((d) => (
          <button key={d} type="button" onClick={() => setDuration(d)} style={pillStyle(duration === d)}>
            {d}
          </button>
        ))}
      </div>
    </div>
  );

  const audienceField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Who is your target audience?</label>
      <textarea
        rows={3}
        value={targetAudience}
        onChange={(e) => setTargetAudience(e.target.value)}
        placeholder="e.g. Club promoters in Berlin, Festival organizers in France, Corporate event planners in NYC"
        style={textareaStyle}
      />
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
        Describe your ideal client in plain language — we handle the targeting.
      </p>
    </div>
  );

  const budgetField = (
    <div style={{ marginBottom: 20 }}>
      <label style={labelStyle}>Budget</label>
      <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
        {BUDGET_OPTIONS.map((o) => (
          <button key={o.value} type="button" onClick={() => setBudget(o.value)} style={pillStyle(budget === o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  // Flat 20% SQRZ fee on the ad budget — no activation fee, no minimum.
  const priceBreakdown = budget == null ? null : (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", marginBottom: 16, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 6 }}>
        <span>Ad budget</span><span style={{ fontFamily: "monospace" }}>${budget.toLocaleString()}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", marginBottom: 10 }}>
        <span>SQRZ fee (20%)</span><span style={{ fontFamily: "monospace" }}>+${(Math.round(budget * 0.20 * 100) / 100).toLocaleString()}</span>
      </div>
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "flex", justifyContent: "space-between", fontWeight: 600, color: "var(--text)", fontSize: 14 }}>
        <span>Total</span><span style={{ fontFamily: "monospace" }}>${(Math.round(budget * 1.20 * 100) / 100).toLocaleString()}</span>
      </div>
    </div>
  );

  const notesField = (
    <div style={{ marginBottom: 24 }}>
      <label style={labelStyle}>Notes (optional)</label>
      <textarea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Add a call to action, describe your style, mention specific dates, or anything else that helps us run a better campaign for you."
        style={textareaStyle}
      />
    </div>
  );

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
          onClick={() => navigate("/domain")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 12px",
            borderRadius: 20,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-muted)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            whiteSpace: "nowrap" as const,
            marginTop: 4,
          }}
        >
          🎯 Pixel Settings →
        </button>
      </div>

      {/* ── New Boost Campaign — create + pay ──────────────────────────────── */}
      <div style={card}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 14px" }}>
          New Boost Campaign
        </h2>

        {boostSuccess && (
          <div style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 10, padding: "14px 16px", marginBottom: 20, fontSize: 14, color: "#22c55e", lineHeight: 1.5 }}>
            Booking created — redirecting you to secure checkout…
          </div>
        )}

        {promoteField}
        {channelField}
        {goalField}
        {durationField}
        {audienceField}
        {budgetField}
        {priceBreakdown}
        {notesField}

        {actionData?.ok === false && (
          <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>
            {actionData.error ?? "Something went wrong. Please try again."}
          </p>
        )}
        {boostError && (
          <p style={{ fontSize: 13, color: "#ef4444", marginBottom: 12 }}>{boostError}</p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          style={{ width: "100%", padding: "14px", background: ACCENT, color: "#111", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY, letterSpacing: "0.02em", transition: "background 0.15s", opacity: isSubmitting ? 0.7 : 1 }}
        >
          {isSubmitting ? "Activating…" : "Activate Boost →"}
        </button>
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

              // Pending payment breakdown — mirror the server fee: a flat 20% SQRZ
              // fee on the ad budget for every campaign (no activation fee, no min).
              const pendingFee = Math.round(c.budget_amount * 0.20 * 100) / 100;
              const pendingTotal = c.budget_amount + pendingFee;
              const pendingFeeLabel = "SQRZ fee (20%)";

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
                        Your payment combines the ad budget and the SQRZ handling fee for running the campaign.
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

    </>
  );
}
