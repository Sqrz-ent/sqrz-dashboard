import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.links";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { normalizeImageUrl } from "~/lib/image-url";
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

type PrivateLink = {
  id: string;
  link_slug: string | null;
  is_active: boolean;
  show_on_profile: boolean;
  page_type: string;
  title: string | null;
  use_count: number;
  unique_visitors: number;
  views_7d: number;
  referrer_count: number;
  booking_modal_opens: number;
  booking_requests: number;
  download_clicks: number;
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
  lead_gate: boolean;
  lead_count: number;
  video_url: string | null;
  cta_label: string | null;
};

type ProfileService = { id: string; title: string };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const admin = createSupabaseAdminClient();

  const [linksRes, servicesRes] = await Promise.all([
    supabase
      .from("private_booking_links")
      .select("id, link_slug, is_active, show_on_profile, page_type, title, use_count, expires_at, max_uses, description, cover_image_url, external_url, external_url_label, prefill_service, event_date, event_venue, event_city, lead_gate, video_url, cta_label")
      .eq("profile_id", profile.id as string)
      .order("created_at", { ascending: false }),
    // Use the admin client (not the RLS-scoped `supabase`): the owner reads ALL of
    // their own services here regardless of is_active/is_published. The profile_services
    // RLS owner policy compares auth.uid() to profile_id (= profiles.id), which never
    // matches for migrated users (profiles.id != auth.users.id), and public_read is
    // gated on is_published — so the RLS path returns nothing for unpublished owners.
    admin
      .from("profile_services")
      .select("id, title")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
  ]);

  const rawLinks = linksRes.data ?? [];

  // Fetch per-link stats from profile_views + jitsu_events
  const linkIds = rawLinks.map((l) => l.id as string);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const profileSlug = profile.slug as string;

  const uniqueVisitorMap: Record<string, number> = {};
  const views7dMap: Record<string, number> = {};
  const referrerCountMap: Record<string, number> = {};
  const downloadClickMap: Record<string, number> = {};
  const leadCountMap: Record<string, number> = {};
  let bookingModalOpens = 0;
  let bookingRequests = 0;

  if (linkIds.length > 0) {
    const [{ data: viewRows }, { count: modalOpens }, { count: requestsSent }, { data: downloadRows }, { data: leadRows }] = await Promise.all([
      admin
        .from("profile_views")
        .select("link_id, visitor_fingerprint, created_at, referrer")
        .in("link_id", linkIds),
      admin
        .from("jitsu_events")
        .select("*", { count: "exact", head: true })
        .eq("profile_slug", profileSlug)
        .eq("event_type", "booking_modal_open"),
      admin
        .from("jitsu_events")
        .select("*", { count: "exact", head: true })
        .eq("profile_slug", profileSlug)
        .eq("event_type", "booking_request_sent"),
      admin
        .from("jitsu_events")
        .select("event_properties")
        .eq("profile_slug", profileSlug)
        .in("event_type", ["external_link_clicked", "download_clicked"]),
      admin
        .from("link_leads")
        .select("link_id")
        .in("link_id", linkIds),
    ]);

    bookingModalOpens = modalOpens ?? 0;
    bookingRequests = requestsSent ?? 0;

    // External-link clicks per link_slug — consolidated download_clicked (legacy)
    // + external_link_clicked (new). Skip pill clicks that route to the hosted
    // /{slug} page (destination:'page'); those are navigations, not external
    // opens. Legacy download_clicked rows carry no destination and always count.
    for (const row of downloadRows ?? []) {
      const props = row.event_properties as Record<string, string> | null;
      if (props?.destination === "page") continue;
      const ls = props?.link_slug;
      if (ls) downloadClickMap[ls] = (downloadClickMap[ls] ?? 0) + 1;
    }

    // Unique visitors (deduplicated by fingerprint per link)
    const seen: Record<string, Set<string>> = {};
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      const fp = row.visitor_fingerprint as string | null;
      if (fp) {
        if (!seen[lid]) seen[lid] = new Set();
        seen[lid].add(fp);
      }
    }
    for (const lid of Object.keys(seen)) {
      uniqueVisitorMap[lid] = seen[lid].size;
    }

    // Views last 7 days per link
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      if ((row.created_at as string) >= sevenDaysAgo) {
        views7dMap[lid] = (views7dMap[lid] ?? 0) + 1;
      }
    }

    // Referrer count per link
    for (const row of viewRows ?? []) {
      const lid = row.link_id as string;
      if (row.referrer) {
        referrerCountMap[lid] = (referrerCountMap[lid] ?? 0) + 1;
      }
    }

    // Lead count per link
    for (const row of leadRows ?? []) {
      const lid = row.link_id as string;
      leadCountMap[lid] = (leadCountMap[lid] ?? 0) + 1;
    }
  }

  const links = rawLinks.map((l) => ({
    ...l,
    unique_visitors: uniqueVisitorMap[l.id as string] ?? 0,
    views_7d: views7dMap[l.id as string] ?? 0,
    referrer_count: referrerCountMap[l.id as string] ?? 0,
    booking_modal_opens: bookingModalOpens,
    booking_requests: bookingRequests,
    download_clicks: downloadClickMap[l.link_slug as string] ?? 0,
    lead_count: leadCountMap[l.id as string] ?? 0,
  }));

  return Response.json(
    {
      is_beta: (profile.is_beta as boolean) ?? false,
      username: profile.slug as string,
      profileId: profile.id as string,
      links,
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
    const titleVal = (fd.get("title") as string) || null;
    const externalUrlRaw = (fd.get("external_url") as string) || null;
    const prefillServiceVal = (fd.get("prefill_service") as string) || null;
    const { error } = await admin.from("private_booking_links").insert({
      profile_id: profile.id as string,
      link_slug: fd.get("link_slug") as string,
      is_active: true,
      page_type: "internal",
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: (fd.get("description") as string) || null,
      cover_image_url: normalizeImageUrl(fd.get("cover_image_url") as string),
      video_url: (fd.get("video_url") as string) || null,
      external_url: externalUrlRaw ? normalizeExternalUrl(externalUrlRaw) : null,
      external_url_label: null,
      prefill_service: prefillServiceVal || null,
      cta_label: (fd.get("cta_label") as string) || null,
      expires_at: null,
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
    const titleVal = (fd.get("title") as string) || null;
    const externalUrlRaw = (fd.get("external_url") as string) || null;
    const prefillServiceVal = (fd.get("prefill_service") as string) || null;
    const { error } = await admin.from("private_booking_links").update({
      link_slug: fd.get("link_slug") as string,
      page_type: "internal",
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: (fd.get("description") as string) || null,
      cover_image_url: normalizeImageUrl(fd.get("cover_image_url") as string),
      video_url: (fd.get("video_url") as string) || null,
      external_url: externalUrlRaw ? normalizeExternalUrl(externalUrlRaw) : null,
      external_url_label: null,
      prefill_service: prefillServiceVal || null,
      cta_label: (fd.get("cta_label") as string) || null,
      expires_at: null,
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

function createPendingCoverKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Ensure an external URL has a protocol so it resolves as an absolute link
// (a bare "spotify.com" would otherwise be treated as a relative path).
function normalizeExternalUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// ─── Create / Edit Link Modal ─────────────────────────────────────────────────


function CreateLinkModal({
  isOpen,
  onClose,
  fetcher,
  username,
  profileId,
  existingSlugs,
  services,
  editingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
  username: string;
  profileId: string;
  existingSlugs: string[];
  services: ProfileService[];
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
    fetcher.submit(fd, { method: "post" });
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

        {/* External: destination URL */}
        {isExternal && (
          <div>
            <label style={labelStyle}>Destination URL</label>
            <input
              style={inputStyle}
              value={externalUrl}
              onChange={e => setExternalUrl(e.target.value)}
              placeholder="https://..."
              autoFocus
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
              Visitors go here directly from the hero pill.
            </p>
          </div>
        )}

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

        {/* Page fields — title, slug, content, connect-to */}
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

            {/* Optional: link to a service (internal only) */}
            {!isExternal && services.length > 0 && (
              <div>
                <label style={labelStyle}>Link to a service <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span></label>
                <select
                  style={inputStyle}
                  value={prefillService}
                  onChange={e => setPrefillService(e.target.value)}
                >
                  <option value="">— none —</option>
                  {services.map(s => (
                    <option key={s.id} value={s.title}>{s.title}</option>
                  ))}
                </select>
              </div>
            )}

            {/* CTA button label */}
            <div>
              <label style={labelStyle}>Button Label <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(leave blank to use "Book")</span></label>
              <input
                style={inputStyle}
                value={ctaLabel}
                onChange={e => setCtaLabel(e.target.value)}
                placeholder="e.g. Get access, Download, Book now…"
              />
            </div>

        </>

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LinksPage() {
  const { is_beta, username: usernameRaw, profileId, links, services } = useLoaderData<typeof loader>() as {
    is_beta: boolean;
    username: string;
    profileId: string;
    links: PrivateLink[];
    services: ProfileService[];
  };

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

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Private Links</h1>

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
        services={services}
        editingLink={editingLink}
      />
    </div>
  );
}
