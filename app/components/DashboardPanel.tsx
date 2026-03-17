import { useEffect, useRef, useState } from "react";
import { supabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PanelKey = "profile" | "service" | "media" | "domain" | "account";

type Profile = Record<string, unknown>;

interface DashboardPanelProps {
  panel: PanelKey | null;
  profile: Profile | null;
  userId: string;
  onClose: () => void;
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
  fontSize: 12,
  fontWeight: 600,
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  background: "#111111",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  fontSize: 15,
  color: "#ffffff",
  outline: "none",
  boxSizing: "border-box",
};

const saveButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "13px",
  background: "#F5A623",
  color: "#111111",
  border: "none",
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  marginTop: 8,
};

// ─── Placeholder panel ────────────────────────────────────────────────────────

function PlaceholderPanel({ title }: { title: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "48px 24px",
        color: "rgba(255,255,255,0.25)",
      }}
    >
      <div style={{ fontSize: 36, marginBottom: 16, opacity: 0.4 }}>🚧</div>
      <p style={{ fontSize: 15, margin: 0 }}>{title} — coming soon</p>
    </div>
  );
}

// ─── ProfilePanel ─────────────────────────────────────────────────────────────

function ProfilePanel({
  profile,
  userId,
}: {
  profile: Profile | null;
  userId: string;
}) {
  // Split stored `name` into first / last on mount
  const fullName = (profile?.name as string) ?? "";
  const nameParts = fullName.trim().split(/\s+/);
  const initialFirst = nameParts[0] ?? "";
  const initialLast = nameParts.slice(1).join(" ");

  const [firstName, setFirstName] = useState(initialFirst);
  const [lastName, setLastName] = useState(initialLast);
  const [bio, setBio] = useState((profile?.bio as string) ?? "");
  const [city, setCity] = useState((profile?.city as string) ?? "");
  const [country, setCountry] = useState((profile?.country as string) ?? "");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setSaveError("");

    const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");

    const { error } = await supabase
      .from("profiles")
      .update({ name, bio: bio.trim(), city: city.trim(), country: country.trim() })
      .eq("id", userId);

    setSaving(false);

    if (error) {
      setSaveError("Failed to save. Try again.");
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 4 }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>First name</label>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="Will"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Last name</label>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Villa"
            style={inputStyle}
          />
        </div>
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle}>Bio</label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Sound engineer, DJ, music producer based in…"
          rows={4}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 4 }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>City</label>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Berlin"
            style={inputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Country</label>
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Germany"
            style={inputStyle}
          />
        </div>
      </div>

      {saveError && (
        <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{saveError}</p>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        style={{ ...saveButtonStyle, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save changes"}
      </button>
    </div>
  );
}

// ─── DashboardPanel (slide-over shell) ───────────────────────────────────────

export default function DashboardPanel({
  panel,
  profile,
  userId,
  onClose,
}: DashboardPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key closes panel
  useEffect(() => {
    if (!panel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onClose]);

  // Lock body scroll while panel is open
  useEffect(() => {
    if (panel) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [panel]);

  if (!panel) return null;

  const title = panelTitles[panel];

  function renderContent() {
    switch (panel) {
      case "profile":
        return <ProfilePanel profile={profile} userId={userId} />;
      case "service":
        return <PlaceholderPanel title="Services" />;
      case "media":
        return <PlaceholderPanel title="Media Library" />;
      case "domain":
        return <PlaceholderPanel title="Custom Domain" />;
      case "account":
        return <PlaceholderPanel title="Account & Billing" />;
      default:
        return null;
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 40,
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 100vw)",
          background: "#1a1a1a",
          borderLeft: "1px solid rgba(255,255,255,0.08)",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          animation: "slideIn 0.22s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "18px 24px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            flexShrink: 0,
          }}
        >
          <h2 style={{ color: "#ffffff", fontSize: 17, fontWeight: 700, margin: 0 }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.4)",
              fontSize: 22,
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: 1,
              borderRadius: 6,
            }}
            aria-label="Close panel"
          >
            ×
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
          {renderContent()}
        </div>
      </div>

      {/* Slide-in animation */}
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}
