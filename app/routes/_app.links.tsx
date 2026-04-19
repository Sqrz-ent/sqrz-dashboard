import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.links";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";
import Modal from "~/components/Modal";
import UpgradeBanner from "~/components/UpgradeBanner";

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

type PageType = "book" | "download" | "event";

type PrivateLink = {
  id: string;
  link_slug: string;
  is_active: boolean;
  show_on_profile: boolean;
  page_type: PageType;
  title: string | null;
  use_count: number;
  expires_at: string | null;
  max_uses: number | null;
  description: string | null;
  cover_image_url: string | null;
  external_url: string | null;
  external_url_label: string | null;
  prefill_service: string | null;
  event_date: string | null;
  event_venue: string | null;
  event_city: string | null;
};

type ProfileService = { id: string; title: string };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [linksRes, servicesRes] = await Promise.all([
    supabase
      .from("private_booking_links")
      .select("id, link_slug, is_active, show_on_profile, page_type, title, use_count, expires_at, max_uses, description, cover_image_url, external_url, external_url_label, prefill_service, event_date, event_venue, event_city")
      .eq("profile_id", profile.id as string)
      .order("created_at", { ascending: false }),
    supabase
      .from("profile_services")
      .select("id, title")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
  ]);

  return Response.json(
    {
      plan_id: (profile.plan_id as number | null) ?? null,
      is_beta: (profile.is_beta as boolean) ?? false,
      grow_qualified: (profile.grow_qualified as boolean) ?? false,
      username: profile.slug as string,
      links: linksRes.data ?? [],
      services: servicesRes.data ?? [],
    },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const admin = createSupabaseAdminClient();
  const fd = await request.formData();
  const intent = fd.get("intent") as string;

  if (intent === "create") {
    const pageType = (fd.get("page_type") as string) || "download";
    const { error } = await admin.from("private_booking_links").insert({
      profile_id: profile.id as string,
      link_slug: fd.get("link_slug") as string,
      is_active: true,
      page_type: pageType,
      title: (fd.get("title") as string) || null,
      description: (fd.get("description") as string) || null,
      prefill_service: pageType === "book" ? ((fd.get("prefill_service") as string) || null) : null,
      external_url: pageType !== "book" ? ((fd.get("external_url") as string) || null) : null,
      external_url_label: pageType !== "book" ? ((fd.get("external_url_label") as string) || null) : null,
      event_date: pageType === "event" ? ((fd.get("event_date") as string) || null) : null,
      event_venue: pageType === "event" ? ((fd.get("event_venue") as string) || null) : null,
      event_city: pageType === "event" ? ((fd.get("event_city") as string) || null) : null,
      expires_at: (fd.get("expires_at") as string) || null,
      max_uses: parseInt(fd.get("max_uses") as string) || null,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_active") {
    const id = fd.get("id") as string;
    const isActive = fd.get("is_active") === "true";
    const { error } = await admin
      .from("private_booking_links")
      .update({ is_active: !isActive })
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_show_on_profile") {
    const id = fd.get("id") as string;
    const current = fd.get("show_on_profile") === "true";
    const { error } = await admin
      .from("private_booking_links")
      .update({ show_on_profile: !current })
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update") {
    const id = fd.get("id") as string;
    const pageType = (fd.get("page_type") as string) || "download";
    const { error } = await admin.from("private_booking_links").update({
      link_slug: fd.get("link_slug") as string,
      page_type: pageType,
      title: (fd.get("title") as string) || null,
      description: (fd.get("description") as string) || null,
      prefill_service: pageType === "book" ? ((fd.get("prefill_service") as string) || null) : null,
      external_url: pageType !== "book" ? ((fd.get("external_url") as string) || null) : null,
      external_url_label: pageType !== "book" ? ((fd.get("external_url_label") as string) || null) : null,
      event_date: pageType === "event" ? ((fd.get("event_date") as string) || null) : null,
      event_venue: pageType === "event" ? ((fd.get("event_venue") as string) || null) : null,
      event_city: pageType === "event" ? ((fd.get("event_city") as string) || null) : null,
      expires_at: (fd.get("expires_at") as string) || null,
      max_uses: parseInt(fd.get("max_uses") as string) || null,
    })
    .eq("id", id)
    .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete") {
    const id = fd.get("id") as string;
    const { error } = await admin
      .from("private_booking_links")
      .delete()
      .eq("id", id)
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

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

function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.split("T")[0];
}

// ─── Create / Edit Link Modal ─────────────────────────────────────────────────

const PAGE_TYPES: { value: PageType; label: string; emoji: string }[] = [
  { value: "book", label: "Book", emoji: "📅" },
  { value: "download", label: "Download", emoji: "📥" },
  { value: "event", label: "Event", emoji: "🎤" },
];

function CreateLinkModal({
  isOpen,
  onClose,
  fetcher,
  username,
  existingSlugs,
  services,
  editingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
  username: string;
  existingSlugs: string[];
  services: ProfileService[];
  editingLink: PrivateLink | null;
}) {
  const isEditing = !!editingLink;

  const [pageType, setPageType] = useState<PageType>("download");
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prefillService, setPrefillService] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [externalUrlLabel, setExternalUrlLabel] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventVenue, setEventVenue] = useState("");
  const [eventCity, setEventCity] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Pre-fill when editing link changes
  useEffect(() => {
    if (editingLink) {
      setPageType(editingLink.page_type);
      setLabel(editingLink.title || editingLink.link_slug);
      setSlug(editingLink.link_slug);
      setSlugEdited(true);
      setTitle(editingLink.title || "");
      setDescription(editingLink.description || "");
      setPrefillService(editingLink.prefill_service || "");
      setExternalUrl(editingLink.external_url || "");
      setExternalUrlLabel(editingLink.external_url_label || "");
      setEventDate(toDatetimeLocal(editingLink.event_date));
      setEventVenue(editingLink.event_venue || "");
      setEventCity(editingLink.event_city || "");
      setExpiresAt(toDateInput(editingLink.expires_at));
      setMaxUses(editingLink.max_uses != null ? String(editingLink.max_uses) : "");
      setSlugError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLink?.id]);

  useEffect(() => {
    if (!slugEdited && label) setSlug(toSlug(label));
  }, [label, slugEdited]);

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
    setPageType("download");
    setLabel(""); setSlug(""); setSlugEdited(false); setSlugError(null);
    setTitle(""); setDescription("");
    setPrefillService("");
    setExternalUrl(""); setExternalUrlLabel("");
    setEventDate(""); setEventVenue(""); setEventCity("");
    setExpiresAt(""); setMaxUses("");
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
    const fd = new FormData();
    if (isEditing) {
      fd.append("intent", "update");
      fd.append("id", editingLink!.id);
    } else {
      fd.append("intent", "create");
    }
    fd.append("page_type", pageType);
    fd.append("link_slug", slug);
    fd.append("title", title);
    fd.append("description", description);
    if (pageType === "book") fd.append("prefill_service", prefillService);
    if (pageType !== "book") { fd.append("external_url", externalUrl); fd.append("external_url_label", externalUrlLabel); }
    if (pageType === "event") { fd.append("event_date", eventDate); fd.append("event_venue", eventVenue); fd.append("event_city", eventCity); }
    if (expiresAt) fd.append("expires_at", expiresAt);
    if (maxUses) fd.append("max_uses", maxUses);
    fetcher.submit(fd, { method: "post" });
  }

  const previewUrl = `${username}.sqrz.com/${slug || "your-slug"}`;

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!isEditing) resetForm(); onClose(); }} title={isEditing ? "Edit Link" : "Create Private Link"}>
      {toast && (
        <div style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#22c55e" }}>
          {toast}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Page type selector */}
        <div>
          <label style={labelStyle}>Page Type</label>
          <div style={{ display: "flex", gap: 8 }}>
            {PAGE_TYPES.map(pt => (
              <button
                key={pt.value}
                type="button"
                onClick={() => setPageType(pt.value)}
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  border: `1px solid ${pageType === pt.value ? ACCENT : "var(--border)"}`,
                  borderRadius: 10,
                  background: pageType === pt.value ? `rgba(245,166,35,0.12)` : "var(--bg)",
                  color: pageType === pt.value ? ACCENT : "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                {pt.emoji} {pt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Label → slug */}
        <div>
          <label style={labelStyle}>Internal Label</label>
          <input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Asia Tour 2026" autoFocus />
        </div>
        <div>
          <label style={labelStyle}>Link Slug</label>
          <input
            style={{ ...inputStyle, ...(slugError ? { border: "1px solid #ef4444" } : {}) }}
            value={slug}
            onChange={e => { setSlug(e.target.value); setSlugEdited(true); setSlugError(null); }}
            onBlur={validateSlug}
            placeholder="asia-tour-2026"
          />
          {slugError ? (
            <p style={{ fontSize: 12, color: "#ef4444", marginTop: 4 }}>{slugError}</p>
          ) : slug ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              Preview: <span style={{ color: ACCENT }}>{previewUrl}</span>
            </p>
          ) : null}
        </div>

        {/* Common: title + description */}
        <div>
          <label style={labelStyle}>Title</label>
          <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder={pageType === "book" ? "e.g. Book me for your event" : pageType === "event" ? "e.g. DJ Set @ Berghain" : "e.g. Press Kit 2026"} />
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details shown on the page…" />
        </div>

        {/* BOOK — service selector */}
        {pageType === "book" && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <label style={labelStyle}>Pre-select Service (optional)</label>
            {services.length > 0 ? (
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={prefillService}
                onChange={e => setPrefillService(e.target.value)}
              >
                <option value="">— Any service (visitor chooses) —</option>
                {services.map(s => (
                  <option key={s.id} value={s.title}>{s.title}</option>
                ))}
              </select>
            ) : (
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>No services yet — add them in the Services tab first.</p>
            )}
          </div>
        )}

        {/* DOWNLOAD — external URL + label */}
        {pageType === "download" && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>External URL</label>
              <input style={inputStyle} value={externalUrl} onChange={e => setExternalUrl(e.target.value)} placeholder="https://dropbox.com/... or any link" />
            </div>
            <div>
              <label style={labelStyle}>Button Label</label>
              <input style={inputStyle} value={externalUrlLabel} onChange={e => setExternalUrlLabel(e.target.value)} placeholder="e.g. Download, Get Press Kit, Listen Now" />
            </div>
          </div>
        )}

        {/* EVENT — date + venue + city + external URL */}
        {pageType === "event" && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Event Date &amp; Time</label>
              <input type="datetime-local" style={inputStyle} value={eventDate} onChange={e => setEventDate(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>Venue</label>
                <input style={inputStyle} value={eventVenue} onChange={e => setEventVenue(e.target.value)} placeholder="e.g. Berghain" />
              </div>
              <div>
                <label style={labelStyle}>City</label>
                <input style={inputStyle} value={eventCity} onChange={e => setEventCity(e.target.value)} placeholder="e.g. Berlin" />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Ticket / External URL</label>
              <input style={inputStyle} value={externalUrl} onChange={e => setExternalUrl(e.target.value)} placeholder="https://eventim.de/..." />
            </div>
            <div>
              <label style={labelStyle}>Button Label</label>
              <input style={inputStyle} value={externalUrlLabel} onChange={e => setExternalUrlLabel(e.target.value)} placeholder="e.g. Get Tickets →" />
            </div>
          </div>
        )}

        {/* Limits */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label style={labelStyle}>Expires (optional)</label>
            <input type="date" style={inputStyle} value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Max Uses (optional)</label>
            <input type="number" style={inputStyle} value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="∞" min={1} />
          </div>
        </div>

        {(fetcher.data as { error?: string } | undefined)?.error && (
          <p style={{ fontSize: 13, color: "#ef4444" }}>{(fetcher.data as { error: string }).error}</p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={fetcher.state !== "idle" || !slug || !!slugError}
          style={{
            padding: "11px 22px",
            background: (!slug || !!slugError) ? "var(--surface-muted)" : ACCENT,
            color: (!slug || !!slugError) ? "var(--text-muted)" : "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: (!slug || !!slugError || fetcher.state !== "idle") ? "not-allowed" : "pointer",
            fontFamily: FONT_BODY,
          }}
        >
          {fetcher.state !== "idle" ? "Saving…" : isEditing ? "Save Changes" : "Create Link"}
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
}: {
  link: PrivateLink;
  username: string;
  fetcher: ReturnType<typeof useFetcher>;
  onEdit: (link: PrivateLink) => void;
  onToggleShowOnProfile: (id: string, currentValue: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = `${username}.sqrz.com/${link.link_slug}`;

  function toggle() {
    const fd = new FormData();
    fd.append("intent", "toggle_active");
    fd.append("id", link.id);
    fd.append("is_active", String(link.is_active));
    fetcher.submit(fd, { method: "post" });
  }

  function toggleShowOnProfile() {
    onToggleShowOnProfile(link.id, link.show_on_profile);
    const fd = new FormData();
    fd.append("intent", "toggle_show_on_profile");
    fd.append("id", link.id);
    fd.append("show_on_profile", String(link.show_on_profile));
    fetcher.submit(fd, { method: "post" });
  }

  function deleteLink() {
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", link.id);
    fetcher.submit(fd, { method: "post" });
    setMenuOpen(false);
  }

  function copyUrl() {
    navigator.clipboard.writeText(`https://${url}`).then(() => {
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
            {link.title || link.link_slug}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
            padding: "2px 7px", borderRadius: 6,
            background: link.page_type === "book" ? "rgba(34,197,94,0.12)" : link.page_type === "event" ? "rgba(168,85,247,0.12)" : "rgba(245,166,35,0.12)",
            color: link.page_type === "book" ? "#22c55e" : link.page_type === "event" ? "#a855f7" : ACCENT,
          }}>
            {link.page_type === "book" ? "📅 Book" : link.page_type === "event" ? "🎤 Event" : "📥 Download"}
          </span>
        </div>
        <a
          href={`https://${url}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: ACCENT, textDecoration: "none", fontFamily: FONT_BODY, wordBreak: "break-all" }}
        >
          {url}
        </a>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {link.use_count} view{link.use_count !== 1 ? "s" : ""}
          {link.max_uses ? ` · max ${link.max_uses}` : ""}
          {link.expires_at ? ` · expires ${new Date(link.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
        </div>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LinksPage() {
  const { plan_id, is_beta, grow_qualified, username: usernameRaw, links, services } = useLoaderData<typeof loader>() as {
    plan_id: number | null;
    is_beta: boolean;
    grow_qualified: boolean;
    username: string;
    links: PrivateLink[];
    services: ProfileService[];
  };

  const createFetcher = useFetcher();
  const cardFetcher = useFetcher();
  const locked = getPlanLevel(plan_id, is_beta, grow_qualified) < FEATURE_GATES.links;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<PrivateLink | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
        // When toggling ON, clear all other cards immediately
        if (newValue) return { ...l, show_on_profile: false };
        return l;
      })
    );
  }

  const username = usernameRaw;
  const existingSlugs = localLinks.map(l => l.link_slug);

  function openEdit(link: PrivateLink) {
    setEditingLink(link);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingLink(null);
  }

  // Toast on successful card actions
  useEffect(() => {
    if (cardFetcher.state === "idle" && (cardFetcher.data as { ok?: boolean } | undefined)?.ok) {
      setToast("Saved!");
      setTimeout(() => setToast(null), 2000);
    }
  }, [cardFetcher.state, cardFetcher.data]);

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Private Links</h1>

      {locked && (
        <UpgradeBanner planName="Boost plan" upgradeParam="boost" />
      )}

      {toast && (
        <div style={{
          background: "rgba(34,197,94,0.12)",
          border: "1px solid rgba(34,197,94,0.3)",
          borderRadius: 10,
          padding: "10px 16px",
          marginBottom: 16,
          fontSize: 13,
          color: "#22c55e",
        }}>
          {toast}
        </div>
      )}

      {/* Active links */}
      <div style={{ ...card, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
        <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text)", margin: "0 0 16px" }}>
          Your Links
        </h2>

        {localLinks.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No private links yet.</p>
        ) : (
          localLinks.map(link => (
            <LinkCard key={link.id} link={link} username={username} fetcher={cardFetcher} onEdit={openEdit} onToggleShowOnProfile={handleToggleShowOnProfile} />
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
        existingSlugs={existingSlugs}
        services={services}
        editingLink={editingLink}
      />
    </div>
  );
}
