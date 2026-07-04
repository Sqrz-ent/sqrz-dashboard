import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.links";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";
import { normalizeImageUrl } from "~/lib/image-url";
import Modal from "~/components/Modal";
import UpgradeBanner from "~/components/UpgradeBanner";
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

type PageType = "internal" | "external";

type PrivateLink = {
  id: string;
  link_slug: string | null;
  is_active: boolean;
  show_on_profile: boolean;
  page_type: PageType;
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
  payment_gate: boolean;
  price: number | null;
  currency: string | null;
};

type ProfileService = { id: string; title: string };

type EventBooking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  venue: string | null;
  city: string | null;
  created_at: string | null;
};

type RawEventBooking = EventBooking & {
  owner_id: string;
  venue_address?: string | null;
  venue_city?: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const admin = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();

  const [linksRes, servicesRes, ownerBookingsRes, participantRowsRes] = await Promise.all([
    supabase
      .from("private_booking_links")
      .select("id, link_slug, is_active, show_on_profile, page_type, title, use_count, expires_at, max_uses, description, cover_image_url, external_url, external_url_label, prefill_service, event_date, event_venue, event_city, lead_gate, video_url, payment_gate, price, currency")
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
    admin
      .from("bookings")
      .select("id, title, service, status, date_start, venue, city, venue_address, venue_city, created_at, owner_id")
      .eq("owner_id", profile.id as string)
      .not("status", "in", "(archived,cancelled)")
      .gte("date_start", nowIso)
      .order("date_start", { ascending: false, nullsFirst: false }),
    admin
      .from("booking_participants")
      .select("booking_id, bookings(id, title, service, status, date_start, venue, city, venue_address, venue_city, created_at, owner_id)")
      .eq("user_id", user.id)
      .neq("role", "buyer"),
  ]);

  const rawLinks = linksRes.data ?? [];
  const eventBookingMap = new Map<string, EventBooking>();
  for (const booking of ownerBookingsRes.data ?? []) {
    const normalized = normalizeEventBooking(booking as RawEventBooking);
    if (normalized) eventBookingMap.set(normalized.id, normalized);
  }
  for (const row of participantRowsRes.data ?? []) {
    const booking = row.bookings as unknown as RawEventBooking | null;
    const normalized = normalizeEventBooking(booking);
    if (normalized && isFutureEventBooking(normalized)) {
      eventBookingMap.set(normalized.id, normalized);
    }
  }
  const eventBookings = [...eventBookingMap.values()].sort((a, b) => {
    const aTime = new Date(a.date_start ?? a.created_at ?? 0).getTime();
    const bTime = new Date(b.date_start ?? b.created_at ?? 0).getTime();
    return bTime - aTime;
  });

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
        .eq("event_type", "download_clicked"),
      admin
        .from("link_leads")
        .select("link_id")
        .in("link_id", linkIds),
    ]);

    bookingModalOpens = modalOpens ?? 0;
    bookingRequests = requestsSent ?? 0;

    // Download clicks per link_slug
    for (const row of downloadRows ?? []) {
      const ls = (row.event_properties as Record<string, string> | null)?.link_slug;
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
      plan_id: (profile.plan_id as number | null) ?? null,
      is_beta: (profile.is_beta as boolean) ?? false,
      grow_qualified: (profile.grow_qualified as boolean) ?? false,
      username: profile.slug as string,
      profileId: profile.id as string,
      stripeConnectStatus: (profile.stripe_connect_status as string | null) ?? null,
      links,
      services: servicesRes.data ?? [],
      eventBookings,
    },
    { headers }
  );
}

function normalizeEventBooking(booking: RawEventBooking | null | undefined): EventBooking | null {
  if (!booking?.id) return null;
  return {
    id: booking.id,
    title: booking.title,
    service: booking.service,
    status: booking.status,
    date_start: booking.date_start,
    venue: booking.venue ?? booking.venue_address ?? null,
    city: booking.city ?? booking.venue_city ?? null,
    created_at: booking.created_at,
  };
}

function isFutureEventBooking(booking: EventBooking) {
  if (["archived", "cancelled"].includes(booking.status)) return false;
  if (!booking.date_start) return false;
  return new Date(booking.date_start).getTime() > Date.now();
}

async function getAllowedEventBooking(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  bookingId: string,
  profileId: string,
  userId: string
): Promise<EventBooking | null> {
  const { data: booking } = await admin
    .from("bookings")
    .select("id, title, service, status, date_start, venue, city, venue_address, venue_city, created_at, owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  const normalized = normalizeEventBooking(booking as RawEventBooking | null);
  if (!normalized || !isFutureEventBooking(normalized)) return null;
  if ((booking as RawEventBooking | null)?.owner_id === profileId) return normalized;

  const { data: participant } = await admin
    .from("booking_participants")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("user_id", userId)
    .neq("role", "buyer")
    .maybeSingle();

  return participant ? normalized : null;
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
    const pageType = (fd.get("page_type") as string) || "internal";
    const isExternal = pageType === "external";
    const titleVal = (fd.get("title") as string) || null;
    const coverImageUrl = isExternal ? null : normalizeImageUrl(fd.get("cover_image_url") as string);
    const paid = !isExternal && fd.get("payment_gate") === "true";

    // show_on_profile exclusivity is enforced by the DB trigger
    // enforce_single_show_on_profile (clears it on the profile's other links).
    // prefill_service / event_* are intentionally not written — they remain inert
    // legacy columns on old rows.
    const { error } = await admin.from("private_booking_links").insert({
      profile_id: profile.id as string,
      link_slug: isExternal ? null : (fd.get("link_slug") as string),
      is_active: true,
      page_type: pageType,
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: isExternal ? null : ((fd.get("description") as string) || null),
      cover_image_url: coverImageUrl,
      video_url: isExternal ? null : ((fd.get("video_url") as string) || null),
      external_url: isExternal ? normalizeExternalUrl(fd.get("external_url") as string) : null,
      external_url_label: isExternal ? ((fd.get("external_url_label") as string) || null) : null,
      payment_gate: paid,
      price: paid ? (parseFloat(fd.get("price") as string) || null) : null,
      currency: paid ? ((fd.get("currency") as string) || "EUR") : null,
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
    const pageType = (fd.get("page_type") as string) || "internal";
    const isExternal = pageType === "external";
    const titleVal = (fd.get("title") as string) || null;
    const coverImageUrl = isExternal ? null : normalizeImageUrl(fd.get("cover_image_url") as string);
    const paid = !isExternal && fd.get("payment_gate") === "true";

    // prefill_service / event_* are intentionally omitted so legacy values are
    // preserved (inert) rather than wiped. show_on_profile exclusivity is
    // enforced by the DB trigger.
    const { error } = await admin.from("private_booking_links").update({
      link_slug: isExternal ? null : (fd.get("link_slug") as string),
      page_type: pageType,
      title: titleVal,
      label: titleVal,
      show_on_profile: fd.get("show_on_profile") === "true",
      description: isExternal ? null : ((fd.get("description") as string) || null),
      cover_image_url: coverImageUrl,
      video_url: isExternal ? null : ((fd.get("video_url") as string) || null),
      external_url: isExternal ? normalizeExternalUrl(fd.get("external_url") as string) : null,
      external_url_label: isExternal ? ((fd.get("external_url_label") as string) || null) : null,
      payment_gate: paid,
      price: paid ? (parseFloat(fd.get("price") as string) || null) : null,
      currency: paid ? ((fd.get("currency") as string) || "EUR") : null,
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

function defaultExternalUrlLabel(pageType: string) {
  return pageType === "event" ? "Get Tickets" : "Download";
}

function formatEventBookingLabel(booking: EventBooking) {
  const title = booking.title || booking.service || "Untitled event";
  const date = booking.date_start
    ? new Date(booking.date_start).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  return [title, date, booking.city].filter(Boolean).join(" · ");
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

const PAGE_TYPES: { value: PageType; label: string; emoji: string }[] = [
  { value: "internal", label: "Page", emoji: "📄" },
  { value: "external", label: "External Link", emoji: "🔗" },
];

function CreateLinkModal({
  isOpen,
  onClose,
  fetcher,
  username,
  profileId,
  stripeConnectStatus,
  existingSlugs,
  services,
  eventBookings,
  editingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
  username: string;
  profileId: string;
  stripeConnectStatus: string | null;
  existingSlugs: string[];
  services: ProfileService[];
  eventBookings: EventBooking[];
  editingLink: PrivateLink | null;
}) {
  const isEditing = !!editingLink;

  const [pageType, setPageType] = useState<PageType>("internal");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [externalUrlLabel, setExternalUrlLabel] = useState("");
  const [showOnProfile, setShowOnProfile] = useState(false);
  const [paymentGate, setPaymentGate] = useState(false);
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [coverUploading, setCoverUploading] = useState(false);
  const [pendingCoverKey, setPendingCoverKey] = useState(createPendingCoverKey);
  const [toast, setToast] = useState<string | null>(null);

  // Pre-fill when editing link changes
  useEffect(() => {
    if (editingLink) {
      // Legacy rows may still carry book/download/event — treat anything that
      // isn't 'external' as an internal page.
      setPageType(editingLink.page_type === "external" ? "external" : "internal");
      setSlug(editingLink.link_slug ?? "");
      setSlugEdited(true);
      setTitle(editingLink.title || "");
      setDescription(editingLink.description || "");
      setCoverImageUrl(editingLink.cover_image_url || "");
      setVideoUrl(editingLink.video_url || "");
      setExternalUrl(editingLink.external_url || "");
      setExternalUrlLabel(editingLink.external_url_label || "");
      setShowOnProfile(editingLink.show_on_profile ?? false);
      setPaymentGate(editingLink.payment_gate ?? false);
      setPrice(editingLink.price != null ? String(editingLink.price) : "");
      setCurrency(editingLink.currency || "EUR");
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
    setPageType("internal");
    setSlug(""); setSlugEdited(false); setSlugError(null);
    setTitle(""); setDescription(""); setCoverImageUrl("");
    setVideoUrl("");
    setExternalUrl(""); setExternalUrlLabel("");
    setShowOnProfile(false);
    setPaymentGate(false); setPrice(""); setCurrency("EUR");
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
    const isExternal = pageType === "external";

    // Internal links use the (editable) slug field. External links have no slug
    // at all — they redirect straight to external_url and have no page on
    // sqrz.com, so link_slug is written null (see the action).
    if (!isExternal && !validateSlug()) return;
    if (coverUploading) return;

    const fd = new FormData();
    if (isEditing) {
      fd.append("intent", "update");
      fd.append("id", editingLink!.id);
    } else {
      fd.append("intent", "create");
    }
    fd.append("page_type", pageType);
    // External links have no slug; internal links use the slug field.
    if (!isExternal) fd.append("link_slug", slug);
    fd.append("show_on_profile", String(showOnProfile));

    if (isExternal) {
      // External: CTA label doubles as the row title; the URL is the destination.
      fd.append("title", externalUrlLabel);
      fd.append("external_url", externalUrl);
      fd.append("external_url_label", externalUrlLabel);
    } else {
      fd.append("title", title);
      fd.append("description", description);
      fd.append("cover_image_url", coverImageUrl);
      fd.append("video_url", videoUrl);
      fd.append("payment_gate", String(paymentGate));
      if (paymentGate) {
        fd.append("price", price);
        fd.append("currency", currency);
      }
    }
    fetcher.submit(fd, { method: "post" });
  }

  const previewUrl = `${username}.sqrz.com/${slug || "your-slug"}`;
  const submitDisabled = fetcher.state !== "idle" || coverUploading ||
    (pageType === "external"
      ? (!externalUrl.trim() || !externalUrlLabel.trim())
      : (!slug || !!slugError));

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!isEditing) resetForm(); onClose(); }} title={isEditing ? "Edit Link" : "Create Private Link"}>
      {toast && (
        <div style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#22c55e" }}>
          {toast}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Type selector — Page (internal) / External Link */}
        <div>
          <label style={labelStyle}>Type</label>
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

        {/* Feature on profile — available for both types. Exclusive: a DB trigger
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

        {/* EXTERNAL — button text + URL, nothing else */}
        {pageType === "external" && (
          <>
            <div>
              <label style={labelStyle}>Button Text</label>
              <input style={inputStyle} value={externalUrlLabel} onChange={e => setExternalUrlLabel(e.target.value)} placeholder="e.g. Listen on Spotify" autoFocus />
            </div>
            <div>
              <label style={labelStyle}>URL</label>
              <input style={inputStyle} value={externalUrl} onChange={e => setExternalUrl(e.target.value)} placeholder="https://..." />
            </div>
          </>
        )}

        {/* INTERNAL — a page hosted at username.sqrz.com/{slug} */}
        {pageType === "internal" && (
          <>
            <div>
              <label style={labelStyle}>Link Slug</label>
              <input
                style={{ ...inputStyle, ...(slugError ? { border: "1px solid #ef4444" } : {}) }}
                value={slug}
                onChange={e => { setSlug(e.target.value.toLowerCase()); setSlugEdited(true); setSlugError(null); }}
                onBlur={() => { setSlug(s => s.toLowerCase()); validateSlug(); }}
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

            <div>
              <label style={labelStyle}>Title</label>
              <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Press Kit 2026" autoFocus />
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

            {/* Payment Gate toggle */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span style={{ ...labelStyle, marginBottom: 2 }}>Payment Gate</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)" }}>Visitors must pay before they can access this link</span>
              </div>
              <button
                type="button"
                onClick={() => setPaymentGate(v => !v)}
                style={{
                  width: 38, height: 22, borderRadius: 11, border: "none",
                  background: paymentGate ? "#22c55e" : "var(--border)",
                  cursor: "pointer", position: "relative", flexShrink: 0,
                  transition: "background 0.15s", marginTop: 2,
                }}
              >
                <span style={{
                  position: "absolute", top: 3, left: paymentGate ? 19 : 3,
                  width: 16, height: 16, borderRadius: "50%", background: "#fff",
                  transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  pointerEvents: "none",
                }} />
              </button>
            </div>

            {paymentGate && stripeConnectStatus !== "active" && (
              <div style={{
                display: "flex", gap: 8, padding: "10px 12px", borderRadius: 8,
                background: "rgba(245,166,35,0.1)", border: "1px solid rgba(245,166,35,0.3)",
                fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5,
              }}>
                <span style={{ flexShrink: 0 }} aria-hidden>⚠️</span>
                <span>
                  You need to connect Stripe to collect payments. Set up Stripe in your{" "}
                  <Link to="/payments" style={{ color: ACCENT, fontWeight: 600, textDecoration: "none" }}>Payments tab</Link>.
                </span>
              </div>
            )}

            {paymentGate && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10 }}>
                <div>
                  <label style={labelStyle}>
                    Price <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(leave blank = pay what you want)</span>
                  </label>
                  <input type="number" min={0} style={inputStyle} value={price} onChange={e => setPrice(e.target.value)} placeholder="50" />
                </div>
                <div>
                  <label style={labelStyle}>Currency</label>
                  <select style={{ ...inputStyle }} value={currency} onChange={e => setCurrency(e.target.value)}>
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>
            )}
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
  const isExternal = link.page_type === "external";
  // External links have no sqrz.com page — show and copy the destination URL
  // itself; internal links show/copy their sqrz.com page URL.
  const displayUrl = isExternal ? (link.external_url ?? "") : `${username}.sqrz.com/${link.link_slug}`;
  const copyTarget = isExternal ? (link.external_url ?? "") : `https://${displayUrl}`;

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
            background: link.page_type === "external" ? "rgba(96,165,250,0.12)" : "rgba(245,166,35,0.12)",
            color: link.page_type === "external" ? "#60a5fa" : ACCENT,
          }}>
            {link.page_type === "external" ? "🔗 Link" : "📄 Page"}
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
  const { plan_id, is_beta, grow_qualified, username: usernameRaw, profileId, stripeConnectStatus, links, services, eventBookings } = useLoaderData<typeof loader>() as {
    plan_id: number | null;
    is_beta: boolean;
    grow_qualified: boolean;
    username: string;
    profileId: string;
    stripeConnectStatus: string | null;
    links: PrivateLink[];
    services: ProfileService[];
    eventBookings: EventBooking[];
  };

  const createFetcher = useFetcher();
  const cardFetcher = useFetcher();
  const locked = getPlanLevel(plan_id) < FEATURE_GATES.links;
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

      {locked && (
        <UpgradeBanner planName="Creator plan" upgradeParam="creator" />
      )}

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
      <div style={{ ...card, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
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
        stripeConnectStatus={stripeConnectStatus}
        existingSlugs={existingSlugs}
        services={services}
        eventBookings={eventBookings}
        editingLink={editingLink}
      />
    </div>
  );
}
