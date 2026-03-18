import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { supabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PanelKey = "profile" | "service" | "media" | "domain" | "account";

type Profile = Record<string, unknown>;

export type SubscriptionData = {
  planName: string;
  status: string | null;
  currentPeriodEnd: string | null;
};

interface DashboardPanelProps {
  panel: PanelKey | null;
  profile: Profile | null;
  userId: string;
  onClose: () => void;
  subscription: SubscriptionData;
  onUpgrade: () => void;
}

// ─── Panel titles ─────────────────────────────────────────────────────────────

const panelTitles: Record<PanelKey, string> = {
  profile: "Edit Profile",
  service: "Services",
  media: "Media Library",
  domain: "Custom Domain",
  account: "Account & Billing",
};

// ─── Shared input styles ──────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginBottom: 18,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  background: "#111111",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  fontSize: 14,
  color: "#ffffff",
  outline: "none",
  boxSizing: "border-box",
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "rgba(255,255,255,0.25)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  marginBottom: 14,
  marginTop: 4,
  paddingBottom: 10,
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

// ─── Placeholder panel ────────────────────────────────────────────────────────

function PlaceholderPanel({ title }: { title: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "64px 24px",
        color: "rgba(255,255,255,0.25)",
      }}
    >
      <div style={{ fontSize: 36, marginBottom: 16, opacity: 0.4 }}>🚧</div>
      <p style={{ fontSize: 14, margin: 0 }}>{title} — coming soon</p>
    </div>
  );
}

// ─── ProfilePanel ─────────────────────────────────────────────────────────────

type ProfileForm = {
  first_name: string;
  last_name: string;
  bio: string;
  city: string;
  social_instagram: string;
  social_youtube: string;
  social_tiktok: string;
  widget_spotify: string;
  widget_soundcloud: string;
  website_url: string;
};

const emptyForm: ProfileForm = {
  first_name: "",
  last_name: "",
  bio: "",
  city: "",
  social_instagram: "",
  social_youtube: "",
  social_tiktok: "",
  widget_spotify: "",
  widget_soundcloud: "",
  website_url: "",
};

function field(key: keyof ProfileForm, raw: Profile | null): string {
  return (raw?.[key] as string) ?? "";
}

function ProfilePanel({ userId }: { userId: string }) {
  const [form, setForm] = useState<ProfileForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Fetch fresh profile data on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("profiles")
      .select(
        "first_name, last_name, bio, city, social_instagram, social_youtube, social_tiktok, widget_spotify, widget_soundcloud, website_url"
      )
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          setForm({
            first_name: field("first_name", data),
            last_name: field("last_name", data),
            bio: field("bio", data),
            city: field("city", data),
            social_instagram: field("social_instagram", data),
            social_youtube: field("social_youtube", data),
            social_tiktok: field("social_tiktok", data),
            widget_spotify: field("widget_spotify", data),
            widget_soundcloud: field("widget_soundcloud", data),
            website_url: field("website_url", data),
          });
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId]);

  function set(key: keyof ProfileForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setSaveError("");

    const { error } = await supabase
      .from("profiles")
      .update({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        // Keep `name` in sync as the display name
        name: [form.first_name.trim(), form.last_name.trim()].filter(Boolean).join(" ") || null,
        bio: form.bio.trim(),
        city: form.city.trim(),
        social_instagram: form.social_instagram.trim(),
        social_youtube: form.social_youtube.trim(),
        social_tiktok: form.social_tiktok.trim(),
        widget_spotify: form.widget_spotify.trim(),
        widget_soundcloud: form.widget_soundcloud.trim(),
        website_url: form.website_url.trim(),
      })
      .eq("user_id", userId);

    setSaving(false);
    if (error) {
      setSaveError("Save failed — " + error.message);
    } else {
      setSaved(true);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: "32px 0", display: "flex", justifyContent: "center" }}>
        <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 14 }}>Loading…</span>
      </div>
    );
  }

  return (
    <div>
      {/* ── Basics ── */}
      <p style={sectionHeadingStyle}>Basics</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>First name</label>
          <input
            value={form.first_name}
            onChange={(e) => set("first_name", e.target.value)}
            placeholder="Will"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Last name</label>
          <input
            value={form.last_name}
            onChange={(e) => set("last_name", e.target.value)}
            placeholder="Villa"
            style={inputStyle}
          />
        </div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>Bio</label>
        <textarea
          value={form.bio}
          onChange={(e) => set("bio", e.target.value)}
          placeholder="Sound engineer, DJ, producer…"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.55 }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>City</label>
          <input
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Berlin"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Website</label>
          <input
            value={form.website_url}
            onChange={(e) => set("website_url", e.target.value)}
            placeholder="https://…"
            style={inputStyle}
          />
        </div>
      </div>

      {/* ── Social ── */}
      <p style={{ ...sectionHeadingStyle, marginTop: 8 }}>Social</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>Instagram</label>
          <input
            value={form.social_instagram}
            onChange={(e) => set("social_instagram", e.target.value)}
            placeholder="@handle"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>TikTok</label>
          <input
            value={form.social_tiktok}
            onChange={(e) => set("social_tiktok", e.target.value)}
            placeholder="@handle"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>YouTube</label>
          <input
            value={form.social_youtube}
            onChange={(e) => set("social_youtube", e.target.value)}
            placeholder="Channel URL"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Spotify</label>
          <input
            value={form.widget_spotify}
            onChange={(e) => set("widget_spotify", e.target.value)}
            placeholder="Artist or playlist URL"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>SoundCloud</label>
          <input
            value={form.widget_soundcloud}
            onChange={(e) => set("widget_soundcloud", e.target.value)}
            placeholder="Profile URL"
            style={inputStyle}
          />
        </div>
      </div>

      {/* ── Save ── */}
      {saveError && (
        <p style={{ color: "#ef4444", fontSize: 13, marginTop: 4, marginBottom: 10 }}>
          {saveError}
        </p>
      )}
      {saved && (
        <p style={{ color: "#4ade80", fontSize: 13, marginTop: 4, marginBottom: 10 }}>
          ✓ Profile saved
        </p>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: "100%",
          padding: "13px",
          background: "#F5A623",
          color: "#111111",
          border: "none",
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 700,
          cursor: saving ? "default" : "pointer",
          opacity: saving ? 0.6 : 1,
          marginTop: 8,
        }}
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}

// ─── AccountPanel ─────────────────────────────────────────────────────────────

function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function AccountPanel({
  profile,
  subscription,
  onUpgrade,
}: {
  profile: Profile | null;
  subscription: SubscriptionData;
  onUpgrade: () => void;
}) {
  const connectFetcher = useFetcher();
  const loginFetcher = useFetcher();

  const connectStatus = (profile?.stripe_connect_status as string | undefined) ?? "not_connected";
  const isActive = connectStatus === "active";
  const isPending = connectStatus === "pending";

  const isConnecting = connectFetcher.state !== "idle";
  const isOpeningDashboard = loginFetcher.state !== "idle";

  const planId = profile?.plan_id as number | null | undefined;
  const showUpgrade = planId == null || planId <= 1;

  const subStatusLabel =
    subscription.status === "active" ? "Active"
    : subscription.status === "trialing" ? "Trialing"
    : subscription.status === "past_due" ? "Past due"
    : subscription.status === "cancelled" ? "Cancelled"
    : subscription.status
      ? subscription.status.charAt(0).toUpperCase() + subscription.status.slice(1)
      : "Free";

  const subStatusColor =
    subscription.status === "active" || subscription.status === "trialing"
      ? "#4ade80"
      : subscription.status === "past_due"
      ? "#fb923c"
      : subscription.status === "cancelled"
      ? "#ef4444"
      : "rgba(255,255,255,0.4)";

  const renewsOn = formatPeriodEnd(subscription.currentPeriodEnd);

  return (
    <div>
      {/* ── Subscription ── */}
      <p style={sectionHeadingStyle}>Subscription</p>

      <div
        style={{
          background: "#111111",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: "16px 18px",
          marginBottom: 24,
        }}
      >
        {/* Plan name + status */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: renewsOn ? 8 : 0 }}>
          <span style={{ color: "#ffffff", fontSize: 14, fontWeight: 600 }}>
            {subscription.planName}
          </span>
          <span style={{ color: subStatusColor, fontSize: 12, fontWeight: 600 }}>
            {subStatusLabel}
          </span>
        </div>

        {/* Renewal date */}
        {renewsOn && (
          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, margin: "0 0 14px" }}>
            Renews on {renewsOn}
          </p>
        )}

        {/* Upgrade button */}
        {showUpgrade && (
          <button
            onClick={onUpgrade}
            style={{
              marginTop: renewsOn ? 0 : 12,
              padding: "10px 18px",
              background: "#F5A623",
              color: "#111111",
              border: "none",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Upgrade plan →
          </button>
        )}
      </div>

      {/* ── Payments / Stripe Connect ── */}
      <p style={{ ...sectionHeadingStyle, marginTop: 8 }}>Payments</p>

      <div
        style={{
          background: "#111111",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: "16px 18px",
        }}
      >
        {isActive ? (
          /* ── Active ── */
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={{ color: "#4ade80", fontSize: 13, margin: 0, fontWeight: 600 }}>
              ✓ Payments active
            </p>
            <loginFetcher.Form method="post" action="/api/stripe/connect/login">
              <button
                type="submit"
                disabled={isOpeningDashboard}
                style={{
                  background: "none",
                  border: "none",
                  color: isOpeningDashboard ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.45)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isOpeningDashboard ? "default" : "pointer",
                  padding: 0,
                  textDecoration: "underline",
                }}
              >
                {isOpeningDashboard ? "Opening…" : "Manage payouts →"}
              </button>
            </loginFetcher.Form>
          </div>
        ) : isPending ? (
          /* ── Pending ── */
          <>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: "0 0 12px" }}>
              Onboarding in progress…
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting}
                style={{
                  padding: "10px 18px",
                  background: "rgba(255,255,255,0.07)",
                  color: isConnecting ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.7)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isConnecting ? "default" : "pointer",
                }}
              >
                {isConnecting ? "Redirecting…" : "Continue setup →"}
              </button>
            </connectFetcher.Form>
          </>
        ) : (
          /* ── Not connected ── */
          <>
            <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: "0 0 12px" }}>
              Connect your bank account to receive payments from bookings.
            </p>
            <connectFetcher.Form method="post" action="/api/stripe/connect">
              <button
                type="submit"
                disabled={isConnecting}
                style={{
                  padding: "10px 18px",
                  background: "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: isConnecting ? "default" : "pointer",
                  opacity: isConnecting ? 0.6 : 1,
                }}
              >
                {isConnecting ? "Redirecting…" : "Connect Bank Account →"}
              </button>
            </connectFetcher.Form>
          </>
        )}
      </div>
    </div>
  );
}

// ─── DashboardPanel (centered modal) ─────────────────────────────────────────

export default function DashboardPanel({
  panel,
  profile: _profile,
  userId,
  onClose,
  subscription,
  onUpgrade,
}: DashboardPanelProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Escape key
  useEffect(() => {
    if (!panel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = panel ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [panel]);

  if (!panel) return null;

  const title = panelTitles[panel];

  function renderContent() {
    switch (panel) {
      case "profile":
        return <ProfilePanel userId={userId} />;
      case "service":
        return <PlaceholderPanel title="Services" />;
      case "media":
        return <PlaceholderPanel title="Media Library" />;
      case "domain":
        return <PlaceholderPanel title="Custom Domain" />;
      case "account":
        return <AccountPanel profile={_profile} subscription={subscription} onUpgrade={onUpgrade} />;
      default:
        return null;
    }
  }

  return (
    <>
      {/* Backdrop — click outside to close */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.72)",
          zIndex: 40,
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
          animation: "fadeIn 0.18s ease",
        }}
      />

      {/* Centered modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(620px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 64px)",
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 18,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          animation: "modalIn 0.2s ease",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "18px 22px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            flexShrink: 0,
          }}
        >
          <h2 style={{ color: "#ffffff", fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "none",
              color: "rgba(255,255,255,0.6)",
              fontSize: 18,
              cursor: "pointer",
              padding: "0",
              width: 28,
              height: 28,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px 24px" }}>
          {renderContent()}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes modalIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
      `}</style>
    </>
  );
}
