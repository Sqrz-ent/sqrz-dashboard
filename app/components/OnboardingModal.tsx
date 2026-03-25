import { useState, useRef, useEffect } from "react";
import { supabase as browserSupabase } from "~/lib/supabase.client";

// ─── Types ─────────────────────────────────────────────────────────────────

interface OnboardingModalProps {
  profileId: string;
  slug: string;
  initialFirstName?: string;
  initialLastName?: string;
  initialAvatarUrl?: string;
  onComplete: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────

const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const ACCENT = "#F5A623";

const SKILL_CATEGORIES = [
  "Performing Arts & Entertainment",
  "Media & Creative Arts",
  "Web & App Development",
  "Academic & Scholar",
] as const;

const TOTAL_STEPS = 4;

// ─── Helpers ──────────────────────────────────────────────────────────────

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
  width: "100%",
  padding: "11px",
  background: "none",
  color: "var(--text-muted)",
  border: "none",
  borderRadius: 12,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: FONT_BODY,
};

// ─── Progress dots ─────────────────────────────────────────────────────────

function ProgressDots({ step }: { step: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 28 }}>
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
  initialFirstName = "",
  initialLastName = "",
  initialAvatarUrl = "",
  onComplete,
}: OnboardingModalProps) {
  const [step, setStep] = useState(1);
  const [visible, setVisible] = useState(false);

  // Step 1 state
  const [firstName, setFirstName]     = useState(initialFirstName);
  const [lastName, setLastName]       = useState(initialLastName);
  const [avatarUrl, setAvatarUrl]     = useState(initialAvatarUrl);
  const [uploading, setUploading]     = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [nameError, setNameError]     = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2 state
  const [allSkills, setAllSkills] = useState<{ id: number; name: string; category: string }[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<number>>(new Set());
  const [activeSkillTab, setActiveSkillTab] = useState<string>(SKILL_CATEGORIES[0]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // Fade in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // Fetch skills list on mount
  useEffect(() => {
    setSkillsLoading(true);
    browserSupabase
      .from("skills")
      .select("id, name, category")
      .eq("type", "skill")
      .eq("is_visible", true)
      .order("name", { ascending: true })
      .then(({ data }) => {
        setAllSkills(data ?? []);
        setSkillsLoading(false);
      });
  }, []);

  // ── Dismiss (skip entirely) ──────────────────────────────────────────────

  async function dismiss() {
    await browserSupabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", profileId);
    onComplete();
  }

  // ── Step 1: save name + avatar ───────────────────────────────────────────

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadStatus("Uploading…");
    const ext = file.name.split(".").pop();
    const path = `${profileId}/avatar.${ext}`;
    const { error: uploadError } = await browserSupabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true });
    if (uploadError) {
      setUploadStatus("Upload failed.");
      setUploading(false);
      return;
    }
    const { data: urlData } = browserSupabase.storage.from("avatars").getPublicUrl(path);
    const publicUrl = urlData.publicUrl;
    await browserSupabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", profileId);
    setAvatarUrl(publicUrl);
    setUploadStatus("Photo saved!");
    setUploading(false);
    setTimeout(() => setUploadStatus(""), 3000);
  }

  async function submitStep1() {
    if (!firstName.trim() || !lastName.trim()) {
      setNameError("First and last name are required.");
      return;
    }
    setNameError("");
    await browserSupabase
      .from("profiles")
      .update({ first_name: firstName.trim(), last_name: lastName.trim(), name: `${firstName.trim()} ${lastName.trim()}` })
      .eq("id", profileId);
    setStep(2);
  }

  // ── Step 2: toggle skill ─────────────────────────────────────────────────

  async function toggleSkill(skillId: number) {
    const isSelected = selectedSkillIds.has(skillId);
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.delete(skillId); else next.add(skillId);
      return next;
    });
    if (isSelected) {
      await browserSupabase.from("profile_skills")
        .delete()
        .eq("profile_id", profileId)
        .eq("skill_id", skillId);
    } else {
      await browserSupabase.from("profile_skills")
        .upsert({ profile_id: profileId, skill_id: skillId });
    }
  }

  // ── Step 4: finish ───────────────────────────────────────────────────────

  async function finish(seePlans: boolean) {
    await browserSupabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", profileId);
    onComplete();
    if (seePlans) {
      // navigate to upgrade modal — handled by parent via URL param
      window.history.replaceState(null, "", "?upgrade=1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
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
          overflowY: "auto",
          padding: "32px 28px 28px",
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

        {/* ── Step 1: Photo + Name ─────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ animation: "obFadeIn 0.18s ease" }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              Let&apos;s set up your profile
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 24px" }}>
              This is what people see when they visit your page.
            </p>

            {/* Avatar */}
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 24 }}>
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  background: avatarUrl ? "transparent" : "var(--surface-muted)",
                  border: `2px solid ${avatarUrl ? ACCENT : "var(--border)"}`,
                  cursor: "pointer",
                  overflow: "hidden",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 32,
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
                {uploadStatus && (
                  <p style={{ margin: "6px 0 0", fontSize: 11, color: ACCENT }}>{uploadStatus}</p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarChange}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            {/* Name fields */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  First name
                </label>
                <input
                  style={inputStyle}
                  value={firstName}
                  onChange={e => { setFirstName(e.target.value); setNameError(""); }}
                  placeholder="Jane"
                  autoFocus
                />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 5 }}>
                  Last name
                </label>
                <input
                  style={inputStyle}
                  value={lastName}
                  onChange={e => { setLastName(e.target.value); setNameError(""); }}
                  placeholder="Smith"
                  onKeyDown={e => e.key === "Enter" && submitStep1()}
                />
              </div>
            </div>

            {nameError && (
              <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{nameError}</p>
            )}

            <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={submitStep1} style={primaryBtn}>Continue</button>
              {!avatarUrl && (
                <button onClick={submitStep1} style={ghostBtn}>
                  Skip photo, just save name
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2: Skills picker ────────────────────────────────────── */}
        {step === 2 && (
          <div style={{ animation: "obFadeIn 0.18s ease" }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              What do you do?
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 16px" }}>
              Pick all that apply.
            </p>

            {/* Category tabs */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              {SKILL_CATEGORIES.map((cat) => {
                const isActive = activeSkillTab === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveSkillTab(cat)}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 20,
                      border: isActive ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
                      background: isActive ? "rgba(245,166,35,0.12)" : "transparent",
                      color: isActive ? ACCENT : "var(--text-muted)",
                      fontSize: 12,
                      fontWeight: isActive ? 700 : 500,
                      cursor: "pointer",
                      fontFamily: FONT_BODY,
                    }}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>

            {/* Skill tags */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 80, marginBottom: 12 }}>
              {skillsLoading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13, fontFamily: FONT_BODY }}>Loading…</p>
              ) : (
                allSkills
                  .filter((s) => s.category === activeSkillTab)
                  .map((skill) => {
                    const isSelected = selectedSkillIds.has(skill.id);
                    return (
                      <button
                        key={skill.id}
                        onClick={() => toggleSkill(skill.id)}
                        style={{
                          padding: "6px 13px",
                          borderRadius: 20,
                          border: isSelected ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
                          background: isSelected ? "rgba(245,166,35,0.1)" : "transparent",
                          color: isSelected ? ACCENT : "var(--text-muted)",
                          fontSize: 13,
                          fontWeight: isSelected ? 600 : 400,
                          cursor: "pointer",
                          fontFamily: FONT_BODY,
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                        }}
                      >
                        {skill.name}
                        {isSelected && <span style={{ fontSize: 11, opacity: 0.8 }}>✕</span>}
                      </button>
                    );
                  })
              )}
            </div>

            {selectedSkillIds.size > 0 && (
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 12px", fontFamily: FONT_BODY }}>
                {selectedSkillIds.size} skill{selectedSkillIds.size !== 1 ? "s" : ""} selected
              </p>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => setStep(3)} style={primaryBtn}>Continue</button>
              <button onClick={() => setStep(3)} style={ghostBtn}>Skip for now</button>
            </div>
          </div>
        )}

        {/* ── Step 3: Preview / Page live ──────────────────────────────── */}
        {step === 3 && (
          <div style={{ animation: "obFadeIn 0.18s ease" }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              Your page is live 🎉
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 22px" }}>
              Anyone can already find you here:
            </p>

            {/* URL display */}
            <div style={{
              background: "var(--bg)",
              border: `1px solid ${ACCENT}`,
              borderRadius: 12,
              padding: "14px 18px",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: ACCENT, fontFamily: "monospace", wordBreak: "break-all" }}>
                {slug}.sqrz.com
              </span>
              <a
                href={`https://${slug}.sqrz.com`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: "7px 14px",
                  background: ACCENT,
                  color: "#111",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                Open →
              </a>
            </div>

            {/* Iframe preview */}
            <div style={{
              borderRadius: 12,
              overflow: "hidden",
              border: "1px solid var(--border)",
              marginBottom: 24,
              height: 220,
              position: "relative",
            }}>
              <iframe
                src={`https://${slug}.sqrz.com`}
                title="Profile preview"
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  pointerEvents: "none",
                }}
                loading="lazy"
              />
              <div style={{
                position: "absolute",
                inset: 0,
                cursor: "default",
              }} />
            </div>

            <button onClick={() => setStep(4)} style={primaryBtn}>Continue</button>
          </div>
        )}

        {/* ── Step 4: Plan nudge ───────────────────────────────────────── */}
        {step === 4 && (
          <div style={{ animation: "obFadeIn 0.18s ease" }}>
            <h2 style={{
              fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800,
              color: "var(--text)", textTransform: "uppercase",
              letterSpacing: "0.02em", margin: "0 0 6px", lineHeight: 1.1,
            }}>
              You&apos;re all set
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 28px" }}>
              You&apos;re on the free plan. Unlock more when you&apos;re ready.
            </p>

            {/* Feature highlights */}
            <div style={{
              background: "var(--bg)",
              borderRadius: 12,
              padding: "16px 18px",
              marginBottom: 24,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}>
              {[
                ["🔒", "Custom domain"],
                ["🔒", "Boost campaigns"],
                ["🔒", "Private links"],
                ["🔒", "Media library"],
              ].map(([icon, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14 }}>{icon}</span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{label}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => finish(true)} style={primaryBtn}>
                See plans
              </button>
              <button onClick={() => finish(false)} style={ghostBtn}>
                Stay on free plan
              </button>
            </div>
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
