import { useState, useRef, useEffect } from "react";
import { supabase as browserSupabase } from "~/lib/supabase.client";

// ─── Types ─────────────────────────────────────────────────────────────────

interface OnboardingModalProps {
  profileId: string;
  slug: string;
  initialName?: string;
  initialAvatarUrl?: string;
  initialEmail?: string;
  onComplete: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────

const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const ACCENT = "#F5A623";
const TOTAL_STEPS = 4;

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "SEK", "NOK", "DKK", "AUD", "CAD", "BRL", "MXN", "COP"];

// ─── Helpers ──────────────────────────────────────────────────────────────

function emailUsername(email: string): string {
  return email.split("@")[0] ?? "";
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 15,
  color: "var(--text)",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: FONT_BODY,
};

const primaryBtn: React.CSSProperties = {
  width: "100%",
  padding: "13px",
  background: ACCENT,
  color: "#111111",
  border: "none",
  borderRadius: 12,
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: FONT_BODY,
};

const ghostBtn: React.CSSProperties = {
  background: "none",
  color: "var(--text-muted)",
  border: "none",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: FONT_BODY,
  padding: "8px 0",
  textDecoration: "underline",
  textUnderlineOffset: 3,
};

// ─── Progress dots ─────────────────────────────────────────────────────────

function ProgressDots({ step }: { step: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 28, flexShrink: 0 }}>
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          style={{
            width: i + 1 === step ? 20 : 7,
            height: 7,
            borderRadius: 4,
            background: i + 1 === step ? ACCENT : i + 1 < step ? "rgba(245,166,35,0.35)" : "var(--border)",
            transition: "all 0.25s ease",
          }}
        />
      ))}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function OnboardingModal({
  profileId,
  slug,
  initialName = "",
  initialAvatarUrl = "",
  initialEmail = "",
  onComplete,
}: OnboardingModalProps) {
  const [step, setStep] = useState(1);
  const [visible, setVisible] = useState(false);

  // Step 1
  const defaultName = initialName || emailUsername(initialEmail);
  const [displayName, setDisplayName] = useState(defaultName);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [nameError, setNameError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  // Step 3
  const [serviceTitle, setServiceTitle] = useState("");
  const [isInstant, setIsInstant] = useState(false);
  const [servicePrice, setServicePrice] = useState("");
  const [serviceCurrency, setServiceCurrency] = useState("EUR");
  const [serviceDescription, setServiceDescription] = useState("");
  const [serviceSaving, setServiceSaving] = useState(false);
  const [serviceError, setServiceError] = useState("");

  // Fade in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.width = "";
    };
  }, []);

  // ── Dismiss (skip all) ───────────────────────────────────────────────────

  async function dismiss() {
    await browserSupabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", profileId);
    onComplete();
  }

  // ── Step 1: avatar upload ────────────────────────────────────────────────

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadStatus("Uploading…");
    const { data: { user: authUser } } = await browserSupabase.auth.getUser();
    if (!authUser) { setUploadStatus("Upload failed."); setUploading(false); return; }
    const ext = file.name.split(".").pop();
    const path = `${authUser.id}/avatar.${ext}`;
    const { error: uploadError } = await browserSupabase.storage
      .from("profile-pictures")
      .upload(path, file, { upsert: true });
    if (uploadError) {
      setUploadStatus("Upload failed.");
      setUploading(false);
      return;
    }
    const { data: urlData } = browserSupabase.storage.from("profile-pictures").getPublicUrl(path);
    const publicUrl = urlData.publicUrl;
    await browserSupabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", profileId);
    setAvatarUrl(publicUrl);
    setUploadStatus("Photo saved!");
    setUploading(false);
    setTimeout(() => setUploadStatus(""), 3000);
  }

  async function submitStep1() {
    if (!displayName.trim()) {
      setNameError("Display name is required.");
      return;
    }
    setNameError("");
    const trimmed = displayName.trim();
    const parts = trimmed.split(/\s+/);
    const firstName = parts[0] ?? trimmed;
    const lastName = parts.slice(1).join(" ") || "";
    await browserSupabase
      .from("profiles")
      .update({ name: trimmed, first_name: firstName, last_name: lastName })
      .eq("id", profileId);
    setStep(2);
  }

  // ── Step 2: password ─────────────────────────────────────────────────────

  async function submitPassword() {
    setPasswordError("");
    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError("Passwords don't match.");
      return;
    }
    setPasswordSaving(true);
    const { error } = await browserSupabase.auth.updateUser({ password });
    setPasswordSaving(false);
    if (error) {
      setPasswordError(error.message);
      return;
    }
    setStep(3);
  }

  // ── Step 3: first service ────────────────────────────────────────────────

  async function submitService() {
    setServiceError("");
    if (!serviceTitle.trim()) {
      setServiceError("Service title is required.");
      return;
    }
    if (isInstant && !servicePrice) {
      setServiceError("Please enter a price for the fixed-price service.");
      return;
    }
    setServiceSaving(true);
    const { error } = await browserSupabase.from("profile_services").insert({
      profile_id: profileId,
      title: serviceTitle.trim(),
      description: serviceDescription.trim() || null,
      booking_type: isInstant ? "instant" : "quote",
      instant_price: isInstant ? (parseFloat(servicePrice) || null) : null,
      instant_currency: isInstant ? serviceCurrency : null,
      is_active: true,
      sort_order: 0,
    });
    setServiceSaving(false);
    if (error) {
      setServiceError("Failed to save service. Please try again.");
      return;
    }
    setStep(4);
  }

  // ── Step 4: finish ───────────────────────────────────────────────────────

  async function finish() {
    await browserSupabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", profileId);
    onComplete();
  }

  // ── Overlay wrapper ──────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.82)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          borderRadius: 20,
          width: "100%",
          maxWidth: 460,
          maxHeight: "calc(100vh - 32px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          padding: "32px 28px 28px",
          boxSizing: "border-box",
          boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
          transform: visible ? "translateY(0)" : "translateY(12px)",
          transition: "transform 0.22s ease, opacity 0.2s ease",
          fontFamily: FONT_BODY,
          position: "relative",
        }}
      >
        {/* Dismiss link */}
        <button
          onClick={dismiss}
          style={{
            position: "absolute",
            top: 16,
            right: 18,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            padding: 0,
          }}
        >
          I&apos;ll do this later
        </button>

        <ProgressDots step={step} />

        {/* ── Step 1: Name & Photo ─────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ animation: "obFadeIn 0.18s ease", flex: 1, overflowY: "auto", minHeight: 0 }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              Let&apos;s set up your profile
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 24px" }}>
              First, tell us who you are
            </p>

            {/* Display name */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                Display name
              </label>
              <input
                style={inputStyle}
                value={displayName}
                onChange={e => { setDisplayName(e.target.value); setNameError(""); }}
                placeholder="Your name"
                autoFocus
                onKeyDown={e => e.key === "Enter" && submitStep1()}
              />
              {nameError && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: "6px 0 0" }}>{nameError}</p>
              )}
            </div>

            {/* Avatar */}
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 24 }}>
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  background: avatarUrl ? "transparent" : "var(--surface-muted)",
                  border: `2px solid ${avatarUrl ? ACCENT : "var(--border)"}`,
                  cursor: "pointer",
                  overflow: "hidden",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 28,
                }}
              >
                {avatarUrl
                  ? <img src={avatarUrl} alt="Avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : "📷"
                }
              </div>
              <div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    padding: "8px 16px",
                    background: "var(--surface-muted)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text)",
                    cursor: uploading ? "not-allowed" : "pointer",
                    fontFamily: FONT_BODY,
                    opacity: uploading ? 0.6 : 1,
                  }}
                >
                  {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Add photo"}
                </button>
                <p style={{ margin: "5px 0 0", fontSize: 11, color: uploadStatus ? ACCENT : "var(--text-muted)" }}>
                  {uploadStatus || "Optional"}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarChange}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            <button onClick={submitStep1} style={primaryBtn}>Continue</button>
          </div>
        )}

        {/* ── Step 2: Set Password ─────────────────────────────────────── */}
        {step === 2 && (
          <div style={{ animation: "obFadeIn 0.18s ease", flex: 1, overflowY: "auto", minHeight: 0 }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              Secure your account
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 24px" }}>
              Set a password so you can always log back in
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  Password
                </label>
                <input
                  type="password"
                  style={inputStyle}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setPasswordError(""); }}
                  placeholder="Min. 8 characters"
                  autoFocus
                />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  Confirm password
                </label>
                <input
                  type="password"
                  style={inputStyle}
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setPasswordError(""); }}
                  placeholder="Repeat password"
                  onKeyDown={e => e.key === "Enter" && submitPassword()}
                />
              </div>
              {passwordError && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{passwordError}</p>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <button onClick={submitPassword} disabled={passwordSaving} style={{ ...primaryBtn, opacity: passwordSaving ? 0.7 : 1 }}>
                {passwordSaving ? "Saving…" : "Set Password"}
              </button>
              <button onClick={() => setStep(3)} style={ghostBtn}>
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: First Service ─────────────────────────────────────── */}
        {step === 3 && (
          <div style={{ animation: "obFadeIn 0.18s ease", flex: 1, overflowY: "auto", minHeight: 0 }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              What do you offer?
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 22px" }}>
              Add your first service — you can always edit this later
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
              {/* Title */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  Service title
                </label>
                <input
                  style={inputStyle}
                  value={serviceTitle}
                  onChange={e => { setServiceTitle(e.target.value); setServiceError(""); }}
                  placeholder="e.g. DJ Set, Audio Mixing, Photography"
                  autoFocus
                />
              </div>

              {/* Booking type toggle */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>
                  Pricing
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { label: "Quote (I'll send a price)", value: false },
                    { label: "Fixed price", value: true },
                  ].map(({ label, value }) => (
                    <button
                      key={label}
                      onClick={() => setIsInstant(value)}
                      style={{
                        flex: 1,
                        padding: "9px 12px",
                        borderRadius: 10,
                        border: isInstant === value ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
                        background: isInstant === value ? "rgba(245,166,35,0.12)" : "var(--surface-muted)",
                        color: isInstant === value ? ACCENT : "var(--text-muted)",
                        fontSize: 12,
                        fontWeight: isInstant === value ? 700 : 500,
                        cursor: "pointer",
                        fontFamily: FONT_BODY,
                        textAlign: "center",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fixed price fields */}
              {isInstant && (
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                      Price
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      style={inputStyle}
                      value={servicePrice}
                      onChange={e => { setServicePrice(e.target.value); setServiceError(""); }}
                      placeholder="0.00"
                    />
                  </div>
                  <div style={{ width: 100 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                      Currency
                    </label>
                    <select
                      style={{ ...inputStyle, padding: "12px 10px" }}
                      value={serviceCurrency}
                      onChange={e => setServiceCurrency(e.target.value)}
                    >
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {/* Description */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  Description <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span>
                </label>
                <textarea
                  style={{ ...inputStyle, resize: "none", height: 72 }}
                  value={serviceDescription}
                  maxLength={120}
                  onChange={e => setServiceDescription(e.target.value)}
                  placeholder="Brief description of this service"
                />
                <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "3px 0 0", textAlign: "right" }}>
                  {serviceDescription.length}/120
                </p>
              </div>

              {serviceError && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: 0 }}>{serviceError}</p>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <button onClick={submitService} disabled={serviceSaving} style={{ ...primaryBtn, opacity: serviceSaving ? 0.7 : 1 }}>
                {serviceSaving ? "Saving…" : "Add Service"}
              </button>
              <button onClick={() => setStep(4)} style={ghostBtn}>
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Done ─────────────────────────────────────────────── */}
        {step === 4 && (
          <div style={{ animation: "obFadeIn 0.18s ease", flex: 1, overflowY: "auto", minHeight: 0 }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 36, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              You&apos;re all set! 🎉
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 28px" }}>
              Your page is live. Share it with the world.
            </p>

            {/* URL display */}
            <div style={{
              background: "var(--bg)",
              border: `1.5px solid ${ACCENT}`,
              borderRadius: 14,
              padding: "18px 20px",
              marginBottom: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: ACCENT, fontFamily: "monospace", wordBreak: "break-all" }}>
                {slug}.sqrz.com
              </span>
              <a
                href={`https://${slug}.sqrz.com`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "8px 16px",
                  background: ACCENT,
                  color: "#111",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                Open →
              </a>
            </div>

            <button onClick={finish} style={primaryBtn}>
              Go to my dashboard
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes obFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
