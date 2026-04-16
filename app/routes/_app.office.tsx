import { redirect, useLoaderData } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import Modal from "~/components/Modal";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  date_end: string | null;
  city: string | null;
  venue: string | null;
};

type BuyerBooking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  created_at: string | null;
  owner_name: string;
  invite_token: string | null;
};

type Service = {
  id: string;
  title: string;
  booking_type: string;
};

type LineItem = { label: string; amount: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: "requested", label: "Requested" },
  { key: "pending",   label: "Pending"   },
  { key: "confirmed", label: "Confirmed" },
  { key: "completed", label: "Completed" },
] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested:       { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  pending:         { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  confirmed:       { bg: "rgba(74,222,128,0.12)",  text: "#4ade80" },
  completed:       { bg: "var(--surface-muted)", text: "var(--text-muted)" },
  archived:        { bg: "var(--surface-muted)", text: "var(--text-muted)" },
  pending_payment: { bg: "rgba(251,191,36,0.12)",  text: "#fbbf24" },
};

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: FONT_BODY,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 5px",
  display: "block",
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const admin = createSupabaseAdminClient();

  const [
    { data: ownerBookingsRaw },
    { data: participantRows },
    { data: services },
  ] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, title, service, status, date_start, date_end, city, venue")
      .eq("owner_id", profile.id as string)
      .order("created_at", { ascending: false }),
    admin
      .from("booking_participants")
      .select("invite_token, bookings(id, title, service, status, date_start, date_end, created_at, owner_id)")
      .eq("user_id", user.id)
      .eq("role", "buyer"),
    admin
      .from("profile_services")
      .select("id, title, booking_type")
      .eq("profile_id", profile.id as string)
      .eq("is_active", true)
      .order("sort_order"),
  ]);

  const ownerBookings: Booking[] = ownerBookingsRaw ?? [];

  type RawBooking = {
    id: string;
    title: string | null;
    service: string | null;
    status: string;
    date_start: string | null;
    date_end: string | null;
    created_at: string | null;
    owner_id: string;
  };

  // Build buyer bookings — exclude archived, exclude any where user is also the owner
  const ownerIdSet = new Set(ownerBookings.map((b) => b.id));
  const buyerRows = (participantRows ?? [])
    .map((row) => ({
      invite_token: row.invite_token as string | null,
      booking: row.bookings as unknown as RawBooking | null,
    }))
    .filter((r): r is { invite_token: string | null; booking: RawBooking } =>
      !!r.booking && !Array.isArray(r.booking) && !["archived"].includes(r.booking.status) && !ownerIdSet.has(r.booking.id)
    );

  // Fetch owner profile names
  const ownerIds = [...new Set(buyerRows.map((r) => r.booking.owner_id).filter(Boolean))];
  let ownerNameMap: Record<string, string> = {};
  if (ownerIds.length > 0) {
    const { data: ownerProfiles } = await admin
      .from("profiles")
      .select("id, name, brand_name, first_name, last_name")
      .in("id", ownerIds);
    for (const p of ownerProfiles ?? []) {
      ownerNameMap[p.id] =
        p.brand_name ||
        p.name ||
        [p.first_name, p.last_name].filter(Boolean).join(" ") ||
        "Unknown";
    }
  }

  const buyerBookings: BuyerBooking[] = buyerRows
    .map((r) => ({
      id: r.booking.id,
      title: r.booking.title,
      service: r.booking.service,
      status: r.booking.status,
      date_start: r.booking.date_start,
      created_at: r.booking.created_at,
      owner_name: ownerNameMap[r.booking.owner_id] ?? "Unknown",
      invite_token: r.invite_token,
    }))
    .sort((a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    );

  return Response.json(
    { ownerBookings, buyerBookings, services: services ?? [] },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bookingId = formData.get("booking_id") as string;

  if (intent === "accept") {
    await supabase
      .from("bookings")
      .update({ status: "pending" })
      .eq("id", bookingId)
      .eq("owner_id", profile.id as string);

    try {
      const admin = createSupabaseAdminClient();
      const { data: buyer } = await admin
        .from("booking_participants")
        .select("email")
        .eq("booking_id", bookingId)
        .eq("role", "buyer")
        .maybeSingle();

      const recipientEmail = buyer?.email ?? null;
      if (recipientEmail) {
        await admin.auth.admin.generateLink({
          type: "magiclink",
          email: recipientEmail,
          options: {
            redirectTo: `https://dashboard.sqrz.com/auth/callback?next=/booking/${bookingId}`,
          },
        });
      }
    } catch {
      // Non-fatal
    }
  } else if (intent === "decline") {
    await supabase
      .from("bookings")
      .update({ status: "archived" })
      .eq("id", bookingId)
      .eq("owner_id", profile.id as string);
  }

  return Response.json({ ok: true }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.archived;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: c.bg,
        color: c.text,
        textTransform: "capitalize",
      }}
    >
      {status}
    </span>
  );
}

// ─── Booking card (My Bookings kanban) ────────────────────────────────────────

function BookingCard({ booking }: { booking: Booking }) {
  return (
    <a
      href={`/booking/${booking.id}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "block",
        width: "100%",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
        textDecoration: "none",
        marginBottom: 8,
        cursor: "pointer",
      }}
    >
      <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 2px", lineHeight: 1.35 }}>
        {booking.title ?? booking.service ?? "Untitled"}
      </p>
      {booking.title && booking.service && (
        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 5px" }}>
          {booking.service}
        </p>
      )}
      {booking.city && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 5px" }}>
          📍 {booking.city}{booking.venue ? ` · ${booking.venue}` : ""}
        </p>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 10px" }}>
        {formatDate(booking.date_start)}
      </p>
      <StatusBadge status={booking.status} />
    </a>
  );
}

// ─── My Requests row ──────────────────────────────────────────────────────────

function MyRequestRow({ booking }: { booking: BuyerBooking }) {
  const href = booking.invite_token
    ? `/booking/${booking.id}?token=${booking.invite_token}`
    : `/booking/${booking.id}`;

  const isPendingPayment = booking.status === "pending_payment";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: "var(--surface)",
        border: isPendingPayment ? "1px solid rgba(251,191,36,0.3)" : "1px solid var(--border)",
        borderRadius: 10,
        marginBottom: 8,
      }}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
      >
        <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {booking.title ?? booking.service ?? "Untitled"}
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "2px 0 0" }}>
          {booking.owner_name}
        </p>
      </a>
      <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
        {formatDate(booking.date_start)}
      </span>
      {isPendingPayment ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            flexShrink: 0,
            padding: "5px 12px",
            borderRadius: 20,
            border: "none",
            background: "#fbbf24",
            color: "#000",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Complete Payment
        </a>
      ) : (
        <StatusBadge status={booking.status} />
      )}
    </div>
  );
}

// ─── New Booking Modal ────────────────────────────────────────────────────────

function NewBookingModal({
  isOpen,
  onClose,
  services,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  services: Service[];
  onSuccess: (clientEmail: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [includeProposal, setIncludeProposal] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([{ label: "Artist Fee", amount: 0 }]);

  const [form, setForm] = useState({
    client_name: "",
    client_email: "",
    title: "",
    service: "",
    date_start: "",
    venue: "",
    city: "",
    description: "",
    rate: "",
    currency: "EUR",
    proposal_message: "",
    requires_payment: false,
  });

  function set(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.client_name || !form.client_email || !form.title) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/booking/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: form.client_name,
          client_email: form.client_email,
          title: form.title,
          service: form.service || null,
          date_start: form.date_start || null,
          venue: form.venue || null,
          city: form.city || null,
          description: form.description || null,
          include_proposal: includeProposal,
          rate: includeProposal ? parseFloat(form.rate) || null : null,
          currency: form.currency,
          line_items: includeProposal ? lineItems.filter((i) => i.label && i.amount > 0) : [],
          proposal_message: includeProposal ? form.proposal_message : null,
          requires_payment: includeProposal ? form.requires_payment : false,
        }),
      });
      const json = await res.json();
      if (json.success) {
        onSuccess(form.client_email);
        onClose();
      }
    } catch (err) {
      console.error("[new booking]", err);
    } finally {
      setSubmitting(false);
    }
  }

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "var(--text-muted)",
    margin: "20px 0 10px",
    display: "block",
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Booking">
      <form
        onSubmit={handleSubmit}
        style={{ padding: "0 22px 24px", overflowY: "auto", flex: 1, fontFamily: FONT_BODY }}
      >
        {/* Client Details */}
        <span style={sectionLabel}>Client Details</span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Name *</label>
            <input
              style={inputStyle}
              type="text"
              required
              placeholder="Jane Smith"
              value={form.client_name}
              onChange={(e) => set("client_name", e.target.value)}
            />
          </div>
          <div>
            <label style={lbl}>Email *</label>
            <input
              style={inputStyle}
              type="email"
              required
              placeholder="jane@example.com"
              value={form.client_email}
              onChange={(e) => set("client_email", e.target.value)}
            />
          </div>
        </div>

        {/* Booking Details */}
        <span style={sectionLabel}>Booking Details</span>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Project name *</label>
          <input
            style={inputStyle}
            type="text"
            required
            placeholder="e.g. Summer Festival Set"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Service</label>
            <select
              style={inputStyle}
              value={form.service}
              onChange={(e) => set("service", e.target.value)}
            >
              <option value="">— Select —</option>
              {services.map((s) => (
                <option key={s.id} value={s.title}>{s.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={lbl}>Date</label>
            <input
              style={inputStyle}
              type="date"
              value={form.date_start}
              onChange={(e) => set("date_start", e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Venue</label>
            <input
              style={inputStyle}
              type="text"
              placeholder="Venue name"
              value={form.venue}
              onChange={(e) => set("venue", e.target.value)}
            />
          </div>
          <div>
            <label style={lbl}>City</label>
            <input
              style={inputStyle}
              type="text"
              placeholder="City"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Notes / Message</label>
          <textarea
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
            placeholder="Any details for the client…"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>

        {/* Proposal toggle */}
        <div
          style={{
            marginTop: 16,
            padding: "12px 14px",
            background: "var(--bg)",
            borderRadius: 10,
            border: "1px solid var(--border)",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeProposal}
              onChange={(e) => setIncludeProposal(e.target.checked)}
              style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0 }}
            />
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Include proposal now</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                Add rate and breakdown — or send later from the booking page
              </p>
            </div>
          </label>

          {includeProposal && (
            <div style={{ marginTop: 14 }}>
              {/* Rate + currency */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Total budget</label>
                  <input
                    style={inputStyle}
                    type="number"
                    placeholder="1500"
                    value={form.rate}
                    onChange={(e) => set("rate", e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Currency</label>
                  <select
                    style={inputStyle}
                    value={form.currency}
                    onChange={(e) => set("currency", e.target.value)}
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              {/* Line items */}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Breakdown (optional)</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {lineItems.map((item, idx) => (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 90px 30px", gap: 6, alignItems: "center" }}>
                      <input
                        type="text"
                        style={{ ...inputStyle, padding: "8px 10px" }}
                        placeholder="e.g. Artist Fee"
                        value={item.label}
                        onChange={(e) => {
                          const next = [...lineItems];
                          next[idx] = { ...item, label: e.target.value };
                          setLineItems(next);
                        }}
                      />
                      <input
                        type="number"
                        min={0}
                        style={{ ...inputStyle, padding: "8px 10px", textAlign: "right" }}
                        placeholder="0"
                        value={item.amount || ""}
                        onChange={(e) => {
                          const next = [...lineItems];
                          next[idx] = { ...item, amount: parseFloat(e.target.value) || 0 };
                          setLineItems(next);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setLineItems(lineItems.filter((_, i) => i !== idx))}
                        style={{
                          background: "none",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          color: "var(--text-muted)",
                          fontSize: 13,
                          cursor: "pointer",
                          padding: "5px 7px",
                          lineHeight: 1,
                          fontFamily: FONT_BODY,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setLineItems([...lineItems, { label: "", amount: 0 }])}
                  style={{
                    marginTop: 6,
                    background: "none",
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                    color: "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "6px 12px",
                    fontFamily: FONT_BODY,
                    width: "100%",
                  }}
                >
                  + Add Line Item
                </button>
              </div>

              {/* Proposal message */}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Message (optional)</label>
                <textarea
                  rows={2}
                  style={{ ...inputStyle, resize: "vertical" }}
                  placeholder="Note with the proposal…"
                  value={form.proposal_message}
                  onChange={(e) => set("proposal_message", e.target.value)}
                />
              </div>

              {/* Stripe toggle */}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.requires_payment}
                  onChange={(e) => set("requires_payment", e.target.checked)}
                  style={{ accentColor: ACCENT, width: 15, height: 15, marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Request payment via Stripe</p>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>Client receives a Stripe payment link</p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={submitting || !form.client_name || !form.client_email || !form.title}
          style={{
            width: "100%",
            marginTop: 20,
            padding: "13px",
            background: ACCENT,
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: submitting || !form.client_name || !form.client_email || !form.title ? "default" : "pointer",
            opacity: submitting ? 0.7 : 1,
            fontFamily: FONT_BODY,
          }}
        >
          {submitting ? "Creating…" : "Create Booking & Send Link"}
        </button>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { ownerBookings, buyerBookings, services } = useLoaderData<typeof loader>() as {
    ownerBookings: Booking[];
    buyerBookings: BuyerBooking[];
    services: Service[];
  };
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function handleSuccess(clientEmail: string) {
    setToast(`Booking created — link sent to ${clientEmail}`);
    setTimeout(() => setToast(null), 5000);
    window.location.reload();
  }

  return (
    <div style={{ padding: "28px 24px", fontFamily: FONT_BODY }}>
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            background: "rgba(74,222,128,0.12)",
            border: "1px solid rgba(74,222,128,0.4)",
            borderRadius: 10,
            padding: "11px 20px",
            color: "#4ade80",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: FONT_BODY,
            whiteSpace: "nowrap",
          }}
        >
          ✓ {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
            Office
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Your booking pipeline
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          style={{
            padding: "10px 18px",
            background: ACCENT,
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT_BODY,
            flexShrink: 0,
          }}
        >
          + New Booking
        </button>
      </div>

      {/* ─── SECTION 1: My Bookings (kanban) ─────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 14,
          overflowX: "auto",
          paddingBottom: 16,
          alignItems: "flex-start",
        }}
      >
        {COLUMNS.map((col) => {
          const colBookings = ownerBookings.filter((b) => b.status === col.key);
          return (
            <div
              key={col.key}
              style={{
                minWidth: 232,
                flex: "0 0 232px",
                background: "var(--surface-muted)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: "14px 12px",
              }}
            >
              {/* Column header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  {col.label}
                </span>
                {colBookings.length > 0 && (
                  <span
                    style={{
                      background: "#F5A623",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      borderRadius: 20,
                      padding: "1px 7px",
                    }}
                  >
                    {colBookings.length}
                  </span>
                )}
              </div>

              {/* Cards */}
              {colBookings.length === 0 ? (
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    textAlign: "center",
                    padding: "20px 0",
                    margin: 0,
                  }}
                >
                  Empty
                </p>
              ) : (
                colBookings.map((booking) => (
                  <BookingCard key={booking.id} booking={booking} />
                ))
              )}
            </div>
          );
        })}
      </div>

      {/* ─── SECTION 2: My Requests (list, only if any) ───────────────────────── */}
      {buyerBookings.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: 28,
              marginBottom: 16,
            }}
          >
            <h2 style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, margin: "0 0 2px" }}>
              My Requests
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
              Bookings you've made with other creators
            </p>
          </div>
          <div style={{ maxWidth: 600 }}>
            {buyerBookings.map((booking) => (
              <MyRequestRow key={booking.id} booking={booking} />
            ))}
          </div>
        </div>
      )}

      <NewBookingModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        services={services}
        onSuccess={handleSuccess}
      />
    </div>
  );
}
