import { useState, useEffect } from "react";
import { redirect, useLoaderData, useFetcher, useNavigate } from "react-router";
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

const PAGE_TYPES = [
  { value: "booking", label: "Booking" },
  { value: "download", label: "Download" },
  { value: "event", label: "Event" },
  { value: "merch", label: "Merch" },
  { value: "press", label: "Press" },
] as const;

type PageType = "booking" | "download" | "event" | "merch" | "press";

const PAGE_TYPE_COLORS: Record<PageType, string> = {
  booking: "#F5A623",
  download: "#3b82f6",
  event: "#8b5cf6",
  merch: "#ec4899",
  press: "#6b7280",
};

type PrivateLink = {
  id: string;
  link_slug: string;
  is_active: boolean;
  page_type: PageType;
  title: string | null;
  use_count: number;
  expires_at: string | null;
  max_uses: number | null;
  // booking
  prefill_service: string | null;
  prefill_event_date: string | null;
  prefill_budget_min: number | null;
  prefill_budget_max: number | null;
  prefill_message: string | null;
  prefill_location: string | null;
  // commerce
  price: string | null;
  stripe_payment_link_url: string | null;
  external_ticket_url: string | null;
  // event
  event_name: string | null;
  event_date: string | null;
  event_venue: string | null;
  event_city: string | null;
  // press/download
  file_path: string | null;
  description: string | null;
  cover_image_url: string | null;
  inventory_count: number | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: links } = await supabase
    .from("private_booking_links")
    .select("*")
    .eq("profile_id", profile.id as string)
    .order("created_at", { ascending: false });

  return Response.json(
    { plan_id: (profile.plan_id as number | null) ?? null, username: profile.slug as string, links: links ?? [] },
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
    const pageType = fd.get("page_type") as string;
    const { error } = await admin.from("private_booking_links").insert({
      profile_id: profile.id as string,
      link_slug: fd.get("link_slug") as string,
      is_active: true,
      page_type: pageType,
      title: (fd.get("title") as string) || null,
      description: (fd.get("description") as string) || null,
      // booking prefill
      prefill_service: pageType === "booking" ? ((fd.get("prefill_service") as string) || null) : null,
      prefill_event_date: pageType === "booking" ? ((fd.get("prefill_event_date") as string) || null) : null,
      prefill_budget_min: pageType === "booking" ? (parseFloat(fd.get("prefill_budget_min") as string) || null) : null,
      prefill_budget_max: pageType === "booking" ? (parseFloat(fd.get("prefill_budget_max") as string) || null) : null,
      prefill_message: pageType === "booking" ? ((fd.get("prefill_message") as string) || null) : null,
      prefill_location: pageType === "booking" ? ((fd.get("prefill_location") as string) || null) : null,
      // commerce
      price: ["download", "merch"].includes(pageType) ? ((fd.get("price") as string) || null) : null,
      stripe_payment_link_url: ["download", "merch", "event"].includes(pageType) ? ((fd.get("stripe_payment_link_url") as string) || null) : null,
      external_ticket_url: pageType === "event" ? ((fd.get("external_ticket_url") as string) || null) : null,
      // event
      event_name: pageType === "event" ? ((fd.get("event_name") as string) || null) : null,
      event_date: pageType === "event" ? ((fd.get("event_date") as string) || null) : null,
      event_venue: pageType === "event" ? ((fd.get("event_venue") as string) || null) : null,
      event_city: pageType === "event" ? ((fd.get("event_city") as string) || null) : null,
      // limits
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

// ─── Create Link Modal ────────────────────────────────────────────────────────

function CreateLinkModal({
  isOpen,
  onClose,
  fetcher,
  username,
  existingSlugs,
}: {
  isOpen: boolean;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
  username: string;
  existingSlugs: string[];
}) {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [pageType, setPageType] = useState<PageType>("booking");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prefillService, setPrefillService] = useState("");
  const [prefillDate, setPrefillDate] = useState("");
  const [prefillBudgetMin, setPrefillBudgetMin] = useState("");
  const [prefillBudgetMax, setPrefillBudgetMax] = useState("");
  const [prefillMessage, setPrefillMessage] = useState("");
  const [prefillLocation, setPrefillLocation] = useState("");
  const [price, setPrice] = useState("");
  const [stripeUrl, setStripeUrl] = useState("");
  const [externalTicketUrl, setExternalTicketUrl] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventVenue, setEventVenue] = useState("");
  const [eventCity, setEventCity] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Auto-suggest slug from label
  useEffect(() => {
    if (!slugEdited && label) {
      setSlug(toSlug(label));
    }
  }, [label, slugEdited]);

  // Close + reset on successful save
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data as { ok?: boolean } | undefined)?.ok) {
      setToast("Link created!");
      setTimeout(() => setToast(null), 3000);
      resetForm();
      onClose();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  function resetForm() {
    setLabel(""); setSlug(""); setSlugEdited(false); setSlugError(null);
    setPageType("booking"); setTitle(""); setDescription("");
    setPrefillService(""); setPrefillDate(""); setPrefillBudgetMin("");
    setPrefillBudgetMax(""); setPrefillMessage(""); setPrefillLocation("");
    setPrice(""); setStripeUrl(""); setExternalTicketUrl("");
    setEventName(""); setEventDate(""); setEventVenue(""); setEventCity("");
    setExpiresAt(""); setMaxUses("");
  }

  function validateSlug() {
    if (!slug) { setSlugError("Slug is required."); return false; }
    if (!/^[a-z0-9-]+$/.test(slug)) { setSlugError("Only lowercase letters, numbers, and hyphens."); return false; }
    if (existingSlugs.includes(slug)) { setSlugError("This slug is already in use."); return false; }
    setSlugError(null);
    return true;
  }

  function handleSubmit() {
    if (!validateSlug()) return;
    const fd = new FormData();
    fd.append("intent", "create");
    fd.append("link_slug", slug);
    fd.append("page_type", pageType);
    fd.append("title", title);
    fd.append("description", description);
    if (pageType === "booking") {
      fd.append("prefill_service", prefillService);
      fd.append("prefill_event_date", prefillDate);
      fd.append("prefill_budget_min", prefillBudgetMin);
      fd.append("prefill_budget_max", prefillBudgetMax);
      fd.append("prefill_message", prefillMessage);
      fd.append("prefill_location", prefillLocation);
    }
    if (["download", "merch"].includes(pageType)) {
      fd.append("price", price);
      fd.append("stripe_payment_link_url", stripeUrl);
    }
    if (pageType === "event") {
      fd.append("event_name", eventName);
      fd.append("event_date", eventDate);
      fd.append("event_venue", eventVenue);
      fd.append("event_city", eventCity);
      fd.append("stripe_payment_link_url", stripeUrl);
      fd.append("external_ticket_url", externalTicketUrl);
    }
    if (expiresAt) fd.append("expires_at", expiresAt);
    if (maxUses) fd.append("max_uses", maxUses);
    fetcher.submit(fd, { method: "post" });
  }

  const pillStyle = (active: boolean, color: string): React.CSSProperties => ({
    padding: "7px 14px",
    borderRadius: 20,
    border: active ? `1.5px solid ${color}` : "1.5px solid var(--border)",
    background: active ? `${color}18` : "transparent",
    color: active ? color : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: FONT_BODY,
    transition: "all 0.15s",
  });

  const previewUrl = `${username}.sqrz.com/${slug || "your-slug"}`;

  return (
    <Modal isOpen={isOpen} onClose={() => { resetForm(); onClose(); }} title="Create Private Link">
      {toast && (
        <div style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#22c55e" }}>
          {toast}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Label */}
        <div>
          <label style={labelStyle}>Internal Label</label>
          <input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Asia Tour 2026" autoFocus />
        </div>

        {/* Slug */}
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

        {/* Page type */}
        <div>
          <label style={labelStyle}>Page Type</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PAGE_TYPES.map(pt => (
              <button key={pt.value} type="button" onClick={() => setPageType(pt.value)} style={pillStyle(pageType === pt.value, PAGE_TYPE_COLORS[pt.value])}>
                {pt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Common fields */}
        <div>
          <label style={labelStyle}>Title (shown on page)</label>
          <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Book me for your event" />
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea rows={3} style={{ ...inputStyle, resize: "vertical" }} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details shown below the title…" />
        </div>

        {/* BOOKING fields */}
        {pageType === "booking" && (
          <>
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>Booking Pre-fill</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <label style={labelStyle}>Service</label>
                  <input style={inputStyle} value={prefillService} onChange={e => setPrefillService(e.target.value)} placeholder="e.g. DJ Set" />
                </div>
                <div>
                  <label style={labelStyle}>Event Date</label>
                  <input type="date" style={inputStyle} value={prefillDate} onChange={e => setPrefillDate(e.target.value)} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <label style={labelStyle}>Budget Min</label>
                    <input type="number" style={inputStyle} value={prefillBudgetMin} onChange={e => setPrefillBudgetMin(e.target.value)} placeholder="500" min={0} />
                  </div>
                  <div>
                    <label style={labelStyle}>Budget Max</label>
                    <input type="number" style={inputStyle} value={prefillBudgetMax} onChange={e => setPrefillBudgetMax(e.target.value)} placeholder="2000" min={0} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Location</label>
                  <input style={inputStyle} value={prefillLocation} onChange={e => setPrefillLocation(e.target.value)} placeholder="City or venue" />
                </div>
                <div>
                  <label style={labelStyle}>Message</label>
                  <textarea rows={2} style={{ ...inputStyle, resize: "vertical" }} value={prefillMessage} onChange={e => setPrefillMessage(e.target.value)} placeholder="Pre-filled message for the visitor" />
                </div>
              </div>
            </div>
          </>
        )}

        {/* DOWNLOAD / MERCH fields */}
        {(pageType === "download" || pageType === "merch") && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Price</label>
              <input style={inputStyle} value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. $29" />
            </div>
            <div>
              <label style={labelStyle}>Stripe Payment Link URL</label>
              <input style={inputStyle} value={stripeUrl} onChange={e => setStripeUrl(e.target.value)} placeholder="https://buy.stripe.com/..." />
            </div>
          </div>
        )}

        {/* EVENT fields */}
        {pageType === "event" && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={labelStyle}>Event Name</label>
              <input style={inputStyle} value={eventName} onChange={e => setEventName(e.target.value)} placeholder="e.g. Asia Tour — Singapore" />
            </div>
            <div>
              <label style={labelStyle}>Event Date</label>
              <input type="datetime-local" style={inputStyle} value={eventDate} onChange={e => setEventDate(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={labelStyle}>Venue</label>
                <input style={inputStyle} value={eventVenue} onChange={e => setEventVenue(e.target.value)} placeholder="Club / Arena" />
              </div>
              <div>
                <label style={labelStyle}>City</label>
                <input style={inputStyle} value={eventCity} onChange={e => setEventCity(e.target.value)} placeholder="Singapore" />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Stripe Payment Link URL</label>
              <input style={inputStyle} value={stripeUrl} onChange={e => setStripeUrl(e.target.value)} placeholder="https://buy.stripe.com/..." />
            </div>
            <div>
              <label style={labelStyle}>External Ticket URL</label>
              <input style={inputStyle} value={externalTicketUrl} onChange={e => setExternalTicketUrl(e.target.value)} placeholder="https://eventim.de/..." />
            </div>
          </div>
        )}

        {/* Limits — all types */}
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
          {fetcher.state !== "idle" ? "Saving…" : "Create Link"}
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
}: {
  link: PrivateLink;
  username: string;
  fetcher: ReturnType<typeof useFetcher>;
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

  const badgeColor = PAGE_TYPE_COLORS[link.page_type] ?? "#888";

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
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            padding: "2px 8px",
            borderRadius: 20,
            background: `${badgeColor}18`,
            color: badgeColor,
          }}>
            {link.page_type}
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
                onClick={deleteLink}
                style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, color: "#ef4444", cursor: "pointer", fontFamily: FONT_BODY }}
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
  const { plan_id, username: usernameRaw, links } = useLoaderData<typeof loader>() as {
    plan_id: number | null;
    username: string;
    links: PrivateLink[];
  };

  const createFetcher = useFetcher();
  const cardFetcher = useFetcher();
  const navigate = useNavigate();
  const locked = getPlanLevel(plan_id) < FEATURE_GATES.links;
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const username = usernameRaw;
  const existingSlugs = links.map(l => l.link_slug);

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
        <UpgradeBanner planName="Boost plan" onUpgradeClick={() => navigate("?upgrade=1")} />
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

        {links.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No private links yet.</p>
        ) : (
          links.map(link => (
            <LinkCard key={link.id} link={link} username={username} fetcher={cardFetcher} />
          ))
        )}

        <button
          onClick={() => setModalOpen(true)}
          style={{
            marginTop: links.length > 0 ? 12 : 0,
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
        onClose={() => setModalOpen(false)}
        fetcher={createFetcher}
        username={username}
        existingSlugs={existingSlugs}
      />
    </div>
  );
}
