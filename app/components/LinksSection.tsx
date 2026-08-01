import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import type { LinksSectionData, PrivateLink } from "~/lib/links.server";
import Modal from "~/components/Modal";
import LinkCoverUploader from "~/components/LinkCoverUploader";

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

const inputStyle: React.CSSProperties = {
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
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 5,
};

// ─── Slug helper ──────────────────────────────────────────────────────────────

function toSlug(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function createPendingCoverKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Create / Edit Link Modal ─────────────────────────────────────────────────

function CreateLinkModal({
  isOpen,
  onClose,
  fetcher,
  username,
  profileId,
  existingSlugs,
  editingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
  username: string;
  profileId: string;
  existingSlugs: string[];
  editingLink: PrivateLink | null;
}) {
  const isEditing = !!editingLink;

  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [isExternal, setIsExternal] = useState(false);
  const [externalUrl, setExternalUrl] = useState("");
  const [prefillService, setPrefillService] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [showOnProfile, setShowOnProfile] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [pendingCoverKey, setPendingCoverKey] = useState(createPendingCoverKey);
  const [toast, setToast] = useState<string | null>(null);

  // Pre-fill when editing link changes
  useEffect(() => {
    if (editingLink) {
      setSlug(editingLink.link_slug ?? "");
      setSlugEdited(true);
      setTitle(editingLink.title || "");
      setDescription(editingLink.description || "");
      setCoverImageUrl(editingLink.cover_image_url || "");
      setVideoUrl(editingLink.video_url || "");
      setIsExternal(!!editingLink.external_url);
      setExternalUrl(editingLink.external_url || "");
      setPrefillService(editingLink.prefill_service || "");
      setCtaLabel(editingLink.cta_label || "");
      setShowOnProfile(editingLink.show_on_profile ?? false);
      setSlugError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLink?.id]);

  useEffect(() => {
    if (!slugEdited && title) setSlug(toSlug(title));
  }, [title, slugEdited]);

  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data as { ok?: boolean } | undefined)?.ok) {
      setToast(isEditing ? "Link updated!" : "Link created!");
      setTimeout(() => setToast(null), 3000);
      if (!isEditing) resetForm();
      onClose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  function resetForm() {
    setSlug(""); setSlugEdited(false); setSlugError(null);
    setTitle(""); setDescription(""); setCoverImageUrl("");
    setVideoUrl("");
    setIsExternal(false); setExternalUrl(""); setPrefillService(""); setCtaLabel("");
    setShowOnProfile(false);
    setCoverUploading(false);
    setPendingCoverKey(createPendingCoverKey());
  }

  function validateSlug() {
    if (!slug) { setSlugError("Slug is required."); return false; }
    if (!/^[a-z0-9-]+$/.test(slug)) { setSlugError("Only lowercase letters, numbers, and hyphens."); return false; }
    const otherSlugs = editingLink ? existingSlugs.filter(s => s !== editingLink.link_slug) : existingSlugs;
    if (otherSlugs.includes(slug)) { setSlugError("This slug is already in use."); return false; }
    setSlugError(null);
    return true;
  }

  function handleSubmit() {
    if (!validateSlug()) return;
    if (coverUploading) return;

    const fd = new FormData();
    if (isEditing) {
      fd.append("intent", "update");
      fd.append("id", editingLink!.id);
    } else {
      fd.append("intent", "create");
    }
    fd.append("link_slug", slug);
    fd.append("show_on_profile", String(showOnProfile));
    fd.append("title", title);
    fd.append("description", description);
    fd.append("cover_image_url", coverImageUrl);
    fd.append("video_url", videoUrl);
    if (isExternal) fd.append("external_url", externalUrl);
    if (!isExternal && prefillService) fd.append("prefill_service", prefillService);
    fd.append("cta_label", ctaLabel);
    fetcher.submit(fd, { method: "post", action: "/links" });
  }

  const submitDisabled = fetcher.state !== "idle" || coverUploading || !slug || !!slugError;

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!isEditing) resetForm(); onClose(); }} title={isEditing ? "Edit Link" : "Create Private Link"}>
      {toast && (
        <div style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#22c55e" }}>
          {toast}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Service Page / External top toggle */}
        <div style={{ display: "flex", gap: 8 }}>
          {(["Service Page", "External"] as const).map(opt => {
            const active = opt === "External" ? isExternal : !isExternal;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setIsExternal(opt === "External")}
                style={{
                  flex: 1, padding: "8px 10px",
                  border: `1px solid ${active ? ACCENT : "var(--border)"}`,
                  borderRadius: 10,
                  background: active ? "rgba(245,166,35,0.12)" : "var(--bg)",
                  color: active ? ACCENT : "var(--text-muted)",
                  fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY,
                }}
              >
                {opt === "Service Page" ? "📄 Service Page" : "🔗 External"}
              </button>
            );
          })}
        </div>

        {/* Feature on profile — Exclusive: a DB trigger
            clears show_on_profile on the profile's other links when this is set. */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <span style={{ ...labelStyle, marginBottom: 2 }}>Feature on profile</span>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>Show this link as the featured button on your profile (only one at a time)</span>
          </div>
          <button
            type="button"
            onClick={() => setShowOnProfile(v => !v)}
            style={{
              width: 38, height: 22, borderRadius: 11, border: "none",
              background: showOnProfile ? "#22c55e" : "var(--border)",
              cursor: "pointer", position: "relative", flexShrink: 0,
              transition: "background 0.15s", marginTop: 2,
            }}
          >
            <span style={{
              position: "absolute", top: 3, left: showOnProfile ? 19 : 3,
              width: 16, height: 16, borderRadius: "50%", background: "#fff",
              transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              pointerEvents: "none",
            }} />
          </button>
        </div>

        {isExternal ? (
          /* External: a genuinely separate, minimal form — title and the URL
             visitors land on. No page content fields (Text/Photo/YouTube) —
             External has no hosted page to fill in, it always goes straight
             to the destination now (see page_type fix in _app.links.tsx's
             action + lib/primaryCta.ts on sqrz-profiles for the read side of
             this). `slug` is still derived from Title behind the scenes
             (unique row identifier / route), just not surfaced as its own
             field here. cta_label/prefill_service stay in the DB and, for an
             existing link, keep whatever value they already had — the form
             no longer offers UI to set/change them (dead since payment-gate
             cleanup removed what made "link to a service" meaningful on an
             internal page; public rendering already falls back to the link's
             title or a sensible default when cta_label is unset, see
             lib/primaryCta.ts / app/[slug]/page.tsx on sqrz-profiles). */
          <>
            <div>
              <label style={labelStyle}>Title</label>
              <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Latest Remix" autoFocus />
              {slugError && (
                <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>{slugError}</p>
              )}
            </div>
            <div>
              <label style={labelStyle}>Button Link</label>
              <input
                style={inputStyle}
                value={externalUrl}
                onChange={e => setExternalUrl(e.target.value)}
                placeholder="https://..."
              />
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                Visitors go here directly from the featured button.
              </p>
            </div>
          </>
        ) : (
          /* Internal: full page fields — title, slug, content */
          <>
            <div>
              <label style={labelStyle}>Title</label>
              <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Press Kit 2026" autoFocus />
            </div>

            {/* Slug — secondary field, auto-derived from title until manually edited */}
            <div>
              <label style={{ ...labelStyle, fontSize: 10 }}>Page URL</label>
              <div style={{
                display: "flex", alignItems: "center", gap: 0,
                border: `1px solid ${slugError ? "#ef4444" : "var(--border)"}`,
                borderRadius: 10, background: "var(--bg)", overflow: "hidden",
              }}>
                <span style={{
                  padding: "9px 10px 9px 13px", fontSize: 12,
                  color: "var(--text-muted)", whiteSpace: "nowrap", userSelect: "none" as const,
                  borderRight: "1px solid var(--border)", flexShrink: 0,
                }}>
                  {username}.sqrz.com/
                </span>
                <input
                  style={{
                    flex: 1, padding: "9px 10px", background: "transparent",
                    border: "none", outline: "none", fontSize: 13,
                    color: "var(--text)", fontFamily: FONT_BODY, minWidth: 0,
                  }}
                  value={slug}
                  onChange={e => { setSlug(e.target.value.toLowerCase()); setSlugEdited(true); setSlugError(null); }}
                  onBlur={() => { setSlug(s => s.toLowerCase()); validateSlug(); }}
                  placeholder="auto-generated"
                />
              </div>
              {slugError && (
                <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>{slugError}</p>
              )}
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details shown on the page…" />
            </div>
            <div>
              <label style={labelStyle}>Cover Image</label>
              <LinkCoverUploader
                profileId={profileId}
                linkId={editingLink?.id ?? null}
                pendingKey={pendingCoverKey}
                currentUrl={coverImageUrl || null}
                onSaved={(url) => setCoverImageUrl(url ?? "")}
                onUploadingChange={setCoverUploading}
              />
            </div>
            <div>
              <label style={labelStyle}>Promo Video (YouTube)</label>
              <input style={inputStyle} value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." />
            </div>

          </>
        )}

        {(fetcher.data as { error?: string } | undefined)?.error && (
          <p style={{ fontSize: 13, color: "#ef4444" }}>{(fetcher.data as { error: string }).error}</p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitDisabled}
          style={{
            padding: "11px 22px",
            background: submitDisabled ? "var(--surface-muted)" : ACCENT,
            color: submitDisabled ? "var(--text-muted)" : "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: submitDisabled ? "not-allowed" : "pointer",
            fontFamily: FONT_BODY,
          }}
        >
          {coverUploading ? "Uploading…" : fetcher.state !== "idle" ? "Saving…" : isEditing ? "Save Changes" : "Create Link"}
        </button>
      </div>
    </Modal>
  );
}

// ─── Link card ────────────────────────────────────────────────────────────────

function LinkCard({
  link,
  username,
  fetcher,
  onEdit,
  onToggleShowOnProfile,
  onToggleActive,
}: {
  link: PrivateLink;
  username: string;
  fetcher: ReturnType<typeof useFetcher>;
  onEdit: (link: PrivateLink) => void;
  onToggleShowOnProfile: (id: string, currentValue: boolean) => void;
  onToggleActive: (id: string, currentValue: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayUrl = link.link_slug ? `${username}.sqrz.com/${link.link_slug}` : "";
  const copyTarget = displayUrl ? `https://${displayUrl}` : "";

  function toggle() {
    onToggleActive(link.id, link.is_active);
    const fd = new FormData();
    fd.append("intent", "toggle_active");
    fd.append("id", link.id);
    fd.append("is_active", String(link.is_active));
    fetcher.submit(fd, { method: "post", action: "/links" });
  }

  function toggleShowOnProfile() {
    onToggleShowOnProfile(link.id, link.show_on_profile);
    const fd = new FormData();
    fd.append("intent", "toggle_show_on_profile");
    fd.append("id", link.id);
    fd.append("show_on_profile", String(link.show_on_profile));
    fetcher.submit(fd, { method: "post", action: "/links" });
  }

  function deleteLink() {
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", link.id);
    fetcher.submit(fd, { method: "post", action: "/links" });
    setMenuOpen(false);
  }

  function copyUrl() {
    navigator.clipboard.writeText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      style={{
        background: "var(--bg)",
        borderRadius: 12,
        padding: "14px 16px",
        marginBottom: 10,
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {link.title || link.link_slug || "Untitled"}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
            padding: "2px 7px", borderRadius: 6,
            background: "rgba(245,166,35,0.12)",
            color: ACCENT,
          }}>
            📄 Page
          </span>
        </div>
        {displayUrl && (
          <a
            href={copyTarget}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "block", fontSize: 12, color: ACCENT, textDecoration: "none", fontFamily: FONT_BODY, wordBreak: "break-all" }}
          >
            {displayUrl}
          </a>
        )}
        <button
          onClick={toggleShowOnProfile}
          style={{
            marginTop: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: link.show_on_profile ? ACCENT : "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            fontFamily: FONT_BODY,
          }}
        >
          <span style={{
            width: 28,
            height: 16,
            borderRadius: 8,
            background: link.show_on_profile ? ACCENT : "var(--border)",
            position: "relative",
            display: "inline-block",
            flexShrink: 0,
            transition: "background 0.15s",
          }}>
            <span style={{
              position: "absolute",
              top: 2,
              left: link.show_on_profile ? 14 : 2,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.15s",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }} />
          </span>
          Show on profile
        </button>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {/* Copy */}
        <button
          onClick={copyUrl}
          title="Copy link"
          style={{
            background: copied ? "rgba(34,197,94,0.12)" : "var(--surface-muted)",
            border: "none",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            color: copied ? "#22c55e" : "var(--text-muted)",
            cursor: "pointer",
            fontFamily: FONT_BODY,
            fontWeight: 600,
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>

        {/* Active toggle */}
        <button
          onClick={toggle}
          title={link.is_active ? "Deactivate" : "Activate"}
          style={{
            width: 38,
            height: 22,
            borderRadius: 11,
            border: "none",
            background: link.is_active ? "#22c55e" : "var(--border)",
            cursor: "pointer",
            position: "relative",
            transition: "background 0.15s",
            flexShrink: 0,
          }}
        >
          <span style={{
            position: "absolute",
            top: 3,
            left: link.is_active ? 19 : 3,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }} />
        </button>

        {/* ⋮ menu */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, padding: "2px 6px", lineHeight: 1 }}
          >
            ⋮
          </button>
          {menuOpen && (
            <div style={{
              position: "absolute",
              right: 0,
              top: "100%",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              zIndex: 10,
              minWidth: 110,
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            }}>
              <button
                onClick={() => { setMenuOpen(false); onEdit(link); }}
                style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}
              >
                Edit
              </button>
              <button
                onClick={deleteLink}
                style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, color: "#ef4444", cursor: "pointer", fontFamily: FONT_BODY, borderTop: "1px solid var(--border)" }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

export default function LinksSection({
  username: usernameRaw,
  profileId,
  links,
  embedded = false,
}: LinksSectionData & { embedded?: boolean }) {
  const createFetcher = useFetcher();
  const cardFetcher = useFetcher();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<PrivateLink | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [localLinks, setLocalLinks] = useState<PrivateLink[]>(links);

  // Sync local state when loader revalidates
  useEffect(() => {
    setLocalLinks(links);
  }, [links]);

  function handleToggleShowOnProfile(id: string, currentValue: boolean) {
    const newValue = !currentValue;
    setLocalLinks(prev =>
      prev.map(l => {
        if (l.id === id) return { ...l, show_on_profile: newValue };
        if (newValue) return { ...l, show_on_profile: false };
        return l;
      })
    );
  }

  function handleToggleActive(id: string, currentValue: boolean) {
    setLocalLinks(prev => prev.map(l => l.id === id ? { ...l, is_active: !currentValue } : l));
  }

  const username = usernameRaw;
  const existingSlugs = localLinks.map(l => l.link_slug).filter((s): s is string => !!s);

  function openEdit(link: PrivateLink) {
    setEditingLink(link);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingLink(null);
  }

  // Toast + revert on card actions
  useEffect(() => {
    if (cardFetcher.state !== "idle") return;
    const data = cardFetcher.data as { ok?: boolean; error?: string } | undefined;
    if (!data) return;
    if (data.ok) {
      setToast({ msg: "Saved!", ok: true });
    } else {
      setLocalLinks(links); // revert optimistic changes
      setToast({ msg: data.error ?? "Something went wrong", ok: false });
    }
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFetcher.state, cardFetcher.data]);

  const outerStyle: React.CSSProperties = embedded
    ? { fontFamily: FONT_BODY, color: "var(--text)" }
    : { maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" };

  return (
    <div style={outerStyle}>
      {!embedded && <h1 style={sectionTitle}>Private Links</h1>}

      {toast && (
        <div style={{
          background: toast.ok ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.1)",
          border: `1px solid ${toast.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
          borderRadius: 10,
          padding: "10px 16px",
          marginBottom: 16,
          fontSize: 13,
          color: toast.ok ? "#22c55e" : "#f87171",
        }}>
          {toast.msg}
        </div>
      )}

      {/* Active links */}
      <div style={card}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)", margin: "0 0 16px" }}>
          Your Links
        </h2>

        {localLinks.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No private links yet.</p>
        ) : (
          localLinks.map(link => (
            <LinkCard key={link.id} link={link} username={username} fetcher={cardFetcher} onEdit={openEdit} onToggleShowOnProfile={handleToggleShowOnProfile} onToggleActive={handleToggleActive} />
          ))
        )}

        <button
          onClick={() => { setEditingLink(null); setModalOpen(true); }}
          style={{
            marginTop: localLinks.length > 0 ? 12 : 0,
            background: "none",
            border: `1px solid rgba(245,166,35,0.4)`,
            color: ACCENT,
            borderRadius: 10,
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT_BODY,
          }}
        >
          + Create Link
        </button>
      </div>

      <CreateLinkModal
        isOpen={modalOpen}
        onClose={closeModal}
        fetcher={createFetcher}
        username={username}
        profileId={profileId}
        existingSlugs={existingSlugs}
        editingLink={editingLink}
      />
    </div>
  );
}
