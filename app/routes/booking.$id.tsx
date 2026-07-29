import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/booking.$id";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserClient } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = Record<string, unknown>;

type GuestParticipant = {
  id: string;
  booking_id: string;
  email: string | null;
  role: string;
  invite_token: string;
  user_id: string | null;
};

export type InvoiceRow = {
  id: string;
  file_name: string;
  file_size_bytes: number | null;
  uploaded_at: string;
  uploaded_by: string;
};

type Proposal = {
  id: string;
  booking_id: string;
  rate: number | null;
  currency: string | null;
  message: string | null;
  status: string | null;
  payment_method?: string | null;
  version?: number | null;
  sent_by?: string | null;
  parent_proposal_id?: string | null;
} | null;

type MemberInfo = {
  name: string | null;
  company_name: string | null;
  legal_form: string | null;
  vat_id: string | null;
  company_address: string | null;
  responsible_person: string | null;
} | null;

function getLatestProposalRecord(proposals: unknown): NonNullable<Proposal> | null {
  if (!Array.isArray(proposals)) return null;
  return (proposals as Array<NonNullable<Proposal>>)
    .slice()
    .sort((a, b) => ((b.version ?? 0) - (a.version ?? 0)))[0] ?? null;
}

// Most-recent uploaded invoice for a booking (or null). Uses the admin client — the
// loader already gates booking access, and buyers reach this via invite token.
async function getBookingInvoice(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  bookingId: string
): Promise<InvoiceRow | null> {
  const { data } = await admin
    .from("invoices")
    .select("id, file_name, file_size_bytes, uploaded_at, uploaded_by")
    .eq("booking_id", bookingId)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as InvoiceRow | null) ?? null;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // PKCE code exchange — magic link callback
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  const admin = createSupabaseAdminClient();
  const token = url.searchParams.get("token");

  // Always check session upfront — needed for token+session merge path
  const { data: { user } } = await supabase.auth.getUser();

  // Helper: compute a display name from a profile — never exposes email domain
  function profileSenderName(p: Record<string, unknown> | null): string | null {
    if (!p) return null;
    return (p.brand_name as string | null) ||
      (p.name as string | null) ||
      ((p.email as string | null)?.split("@")[0] ?? null);
  }

  // ── VALIDATE TOKEN (when present) ─────────────────────────────────────────
  let tokenRow: Record<string, unknown> | null = null;
  if (token) {
    const { data: row } = await admin
      .from("booking_participants")
      .select("id, booking_id, email, name, role, invite_token, user_id, bookings(*)")
      .eq("booking_id", params.id)
      .eq("invite_token", token)
      .limit(1)
      .maybeSingle();

    if (!row) return Response.json({ accessType: "invalid_token" }, { headers });
    tokenRow = row as Record<string, unknown>;

    // Link participant to auth user if session exists and not already linked
    if (user && !tokenRow.user_id) {
      await admin
        .from("booking_participants")
        .update({ user_id: user.id })
        .eq("id", tokenRow.id as string);
    }
  }

  // ── TOKEN + SESSION: full authenticated experience ─────────────────────────
  if (tokenRow && user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking } = await admin
      .from("bookings")
      .select("*, booking_participants(*), booking_proposals(*)")
      .eq("id", params.id)
      .maybeSingle();

    if (!booking) return Response.json({ accessType: "invalid_token" }, { headers });

    const isOwner = !!(profile && booking.owner_id === profile.id);

    const proposal = getLatestProposalRecord(booking.booking_proposals);

    // Load buyer participant for owner
    let tokenBuyerParticipant: BuyerParticipant = null;
    if (isOwner) {
      const { data: buyerP } = await admin
        .from("booking_participants")
        .select("name, email, phone, billing_company, billing_address, billing_city, billing_country, billing_vat_id, billing_confirmed")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();
      tokenBuyerParticipant = buyerP ? {
        name: buyerP.name as string | null,
        email: buyerP.email as string | null,
        phone: (buyerP as Record<string, unknown>).phone as string | null ?? null,
        billing_company: (buyerP as Record<string, unknown>).billing_company as string | null ?? null,
        billing_address: (buyerP as Record<string, unknown>).billing_address as string | null ?? null,
        billing_city: (buyerP as Record<string, unknown>).billing_city as string | null ?? null,
        billing_country: (buyerP as Record<string, unknown>).billing_country as string | null ?? null,
        billing_vat_id: (buyerP as Record<string, unknown>).billing_vat_id as string | null ?? null,
        billing_confirmed: (buyerP as Record<string, unknown>).billing_confirmed as boolean | null ?? null,
      } : null;
    }

    const invoice = await getBookingInvoice(admin, params.id!);

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : (tokenRow.role as string),
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        invoice,
        bookingToken: token,   // keep so buyer actions still work via token path
        memberInfo: null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        memberEmail: null,
        buyerParticipant: tokenBuyerParticipant,
      },
      { headers }
    );
  }

  // ── TOKEN ONLY (no session) ────────────────────────────────────────────────
  if (tokenRow) {
    const booking = tokenRow.bookings as Booking;
    const participant: GuestParticipant = {
      id: tokenRow.id as string,
      booking_id: tokenRow.booking_id as string,
      email: tokenRow.email as string | null,
      role: tokenRow.role as string,
      invite_token: tokenRow.invite_token as string,
      user_id: tokenRow.user_id as string | null,
    };

    const { data: proposal } = await admin
      .from("booking_proposals")
      .select("*")
      .eq("booking_id", params.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Sender name: use participant name field; fall back to email prefix (no domain)
    const senderName = (tokenRow.name as string | null) ||
      ((tokenRow.email as string | null)?.split("@")[0] ?? null);

    const invoice = await getBookingInvoice(admin, params.id!);

    return Response.json(
      {
        accessType: "token",
        booking,
        participant,
        role: tokenRow.role as string,
        userEmail: (tokenRow.email as string) ?? "",
        isOwner: false,
        proposal: proposal ?? null,
        invoice,
        bookingToken: token,
        memberInfo: null,
        senderName,
        memberEmail: null,
      },
      { headers }
    );
  }

  // ── SESSION ONLY (no token) ────────────────────────────────────────────────
  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking } = await admin
      .from("bookings")
      .select("*, booking_participants(*), booking_proposals(*)")
      .eq("id", params.id)
      .maybeSingle();

    if (!booking) return Response.json({ accessType: "invalid_token" }, { headers });

    const isOwner = !!(profile && booking.owner_id === profile.id);
    if (!isOwner) {
      const isParticipant = (booking.booking_participants ?? []).some(
        (p: { user_id: string | null }) => p.user_id === user.id
      );
      if (!isParticipant) return Response.json({ accessType: "no_access" }, { headers });
    }

    const proposal = getLatestProposalRecord(booking.booking_proposals);

    // Load buyer participant for owner
    let sessionBuyerParticipant: BuyerParticipant = null;
    if (isOwner && profile) {
      const { data: buyerP } = await admin
        .from("booking_participants")
        .select("name, email, phone, billing_company, billing_address, billing_city, billing_country, billing_vat_id, billing_confirmed")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();
      sessionBuyerParticipant = buyerP ? {
        name: buyerP.name as string | null,
        email: buyerP.email as string | null,
        phone: (buyerP as Record<string, unknown>).phone as string | null ?? null,
        billing_company: (buyerP as Record<string, unknown>).billing_company as string | null ?? null,
        billing_address: (buyerP as Record<string, unknown>).billing_address as string | null ?? null,
        billing_city: (buyerP as Record<string, unknown>).billing_city as string | null ?? null,
        billing_country: (buyerP as Record<string, unknown>).billing_country as string | null ?? null,
        billing_vat_id: (buyerP as Record<string, unknown>).billing_vat_id as string | null ?? null,
        billing_confirmed: (buyerP as Record<string, unknown>).billing_confirmed as boolean | null ?? null,
      } : null;
    }

    const invoice = await getBookingInvoice(admin, params.id!);

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : "member",
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        invoice,
        bookingToken: null,
        memberInfo: null,
        memberEmail: null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        buyerParticipant: sessionBuyerParticipant,
      },
      { headers }
    );
  }

  // ── NO TOKEN, NO SESSION ──────────────────────────────────────────────────
  return Response.json({ accessType: "reauth", bookingId: params.id }, { headers });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Session-based: all member / owner intents
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { headers, status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  // All intents below require ownership
  const { data: bkCheck } = await supabase
    .from("bookings")
    .select("owner_id")
    .eq("id", params.id)
    .single();

  if (!bkCheck || bkCheck.owner_id !== profile.id) {
    return Response.json({ error: "Unauthorized" }, { headers, status: 403 });
  }

  if (intent === "save_notes") {
    const notes = (formData.get("notes") as string) ?? "";
    const { error } = await supabase
      .from("bookings")
      .update({ notes })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    if (error) return Response.json({ error: error.message }, { status: 500, headers });
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "mark_as_done") {
    const { error } = await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    if (error) return Response.json({ error: error.message }, { status: 500, headers });
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "decline") {
    // enforce_booking_status_transition only allows declining from
    // lead/requested/pending_payment/pending — the UI already hides the button
    // outside that range, but a stale client (e.g. two tabs) can still hit this,
    // so surface the trigger's own error message rather than a generic one.
    const { error } = await supabase
      .from("bookings")
      .update({ status: "declined" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    if (error) return Response.json({ error: error.message }, { status: 500, headers });
    return Response.json({ ok: true }, { headers });
  }

  return Response.json({ ok: true }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h === 0 && m === 0) return datePart;
  return `${datePart} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function currencySym(c: string | null) {
  return c?.toUpperCase() === "EUR" ? "€" : c?.toUpperCase() === "GBP" ? "£" : "$";
}

// ─── Style constants ──────────────────────────────────────────────────────────

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 14,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

const val: React.CSSProperties = {
  color: "var(--text)",
  fontSize: 14,
  margin: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box" as const,
  fontFamily: FONT_BODY,
};

// Guest view label style
const guestMetaLabel: React.CSSProperties = {
  color: "var(--text-muted)", fontSize: 11, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px",
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested:       { bg: "rgba(245,166,35,0.12)", text: ACCENT },
  pending:         { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed:       { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed:       { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  archived:        { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  cancelled:       { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
};

// ─── Shared components ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.archived;
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 16px", lineHeight: 1.1 }}>
      {children}
    </h2>
  );
}

// ─── Member view section (owner) ───────────────────────────────────────────────

const OPEN_STATUSES = ["requested", "pending", "confirmed"];

function MemberBookingSection({ booking, buyerParticipant }: { booking: Booking; buyerParticipant?: BuyerParticipant }) {
  const b = booking;
  const status = (b.status as string) ?? "requested";
  const isTerminal = !OPEN_STATUSES.includes(status);
  const canDecline = status === "requested" || status === "pending";

  const notesFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const statusFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [notes, setNotes] = useState((b.notes as string | null) ?? "");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSaveNotes(value: string) {
    setNotes(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const fd = new FormData();
      fd.append("intent", "save_notes");
      fd.append("notes", value);
      notesFetcher.submit(fd, { method: "post" });
    }, 600);
  }

  function updateStatus(newStatus: "completed" | "declined") {
    const fd = new FormData();
    fd.append("intent", newStatus === "completed" ? "mark_as_done" : "decline");
    statusFetcher.submit(fd, { method: "post" });
  }

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      {!!buyerParticipant && (buyerParticipant.name || buyerParticipant.email) && (
        <div style={card}>
          <p style={lbl}>Requester</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {buyerParticipant.name && <p style={{ ...val, fontWeight: 600 }}>{buyerParticipant.name}</p>}
            {buyerParticipant.email && (
              <a
                href={`mailto:${buyerParticipant.email}`}
                style={{ ...val, color: ACCENT, fontSize: 13, textDecoration: "underline" }}
              >
                {buyerParticipant.email}
              </a>
            )}
          </div>
        </div>
      )}

      <div style={card}>
        <div>
          <p style={lbl}>Date</p>
          <p style={val}>{formatDateTime(b.date_start as string | null)}</p>
        </div>
        {!!b.venue_city && (
          <div style={{ marginTop: 14 }}>
            <p style={lbl}>City</p>
            <p style={val}>{b.venue_city as string}</p>
          </div>
        )}
      </div>

      <div style={card}>
        <p style={{ ...lbl, marginBottom: 8 }}>Notes</p>
        <textarea
          rows={4}
          style={{ ...inputStyle, resize: "vertical" }}
          value={notes}
          onChange={(e) => scheduleSaveNotes(e.target.value)}
          placeholder="Add a private note…"
        />
        {notesFetcher.data?.error && (
          <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{notesFetcher.data.error}</p>
        )}
      </div>

      {statusFetcher.data?.error && (
        <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{statusFetcher.data.error}</p>
      )}

      {!isTerminal && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={() => updateStatus("completed")}
            disabled={statusFetcher.state !== "idle"}
            style={{
              width: "100%",
              padding: "13px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: statusFetcher.state !== "idle" ? "default" : "pointer",
              opacity: statusFetcher.state !== "idle" ? 0.7 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            Mark as Done
          </button>
          {canDecline && (
            <button
              onClick={() => {
                if (!window.confirm("Decline this booking?")) return;
                updateStatus("declined");
              }}
              disabled={statusFetcher.state !== "idle"}
              style={{
                width: "100%",
                padding: "12px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 10,
                color: "#ef4444",
                fontSize: 13,
                fontWeight: 600,
                cursor: statusFetcher.state !== "idle" ? "default" : "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              Decline
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Guest view components ────────────────────────────────────────────────────

function GuestDetailsCard({ b, memberInfo }: { b: Booking; memberInfo?: MemberInfo }) {
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {(b.service as string) && (
          <div><p style={guestMetaLabel}>Service</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p></div>
        )}
        {(b.date_start as string) && !!(b.date_end && b.date_end !== b.date_start) ? (
          <>
            <div><p style={guestMetaLabel}>Start</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_start as string)}</p></div>
            <div><p style={guestMetaLabel}>End</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_end as string)}</p></div>
          </>
        ) : (b.date_start as string) ? (
          <div><p style={guestMetaLabel}>Date</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_start as string)}</p></div>
        ) : null}
      </div>
      {!!(b.venue_address || b.venue_city || b.venue_zip || b.venue_country) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={{ ...guestMetaLabel, marginBottom: 14 }}>Location</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 16px" }}>
            {(b.venue_address as string) && (
              <div>
                <p style={guestMetaLabel}>Street</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_address as string}</p>
              </div>
            )}
            {(b.venue_city as string) && (
              <div>
                <p style={guestMetaLabel}>City</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_city as string}</p>
              </div>
            )}
            {(b.venue_zip as string) && (
              <div>
                <p style={guestMetaLabel}>ZIP</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_zip as string}</p>
              </div>
            )}
            {(b.venue_country as string) && (
              <div>
                <p style={guestMetaLabel}>Country</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_country as string}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {(b.description as string | null) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{b.description as string}</p>
        </div>
      )}
      {memberInfo && (memberInfo.company_name || memberInfo.legal_form || memberInfo.vat_id || memberInfo.responsible_person) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Seller Information</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
            {(memberInfo.company_name || memberInfo.name) && (
              <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: 0 }}>{memberInfo.company_name ?? memberInfo.name}</p>
            )}
            {memberInfo.legal_form && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{memberInfo.legal_form}</p>
            )}
            {memberInfo.company_address && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{memberInfo.company_address}</p>
            )}
            {memberInfo.vat_id && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>VAT: {memberInfo.vat_id}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GuestProposalCard({ proposal }: { proposal: Proposal }) {
  if (!proposal) {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No proposal has been sent yet.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <div style={{ marginBottom: proposal.message ? 18 : 0 }}>
        {proposal.rate != null && (
          <div>
            <p style={guestMetaLabel}>Amount</p>
            <p style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              {proposal.rate} {proposal.currency ?? "EUR"}
            </p>
          </div>
        )}
      </div>
      {proposal.message && (
        <div style={{ paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message from artist</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{proposal.message}</p>
        </div>
      )}
    </div>
  );
}

function GuestBuyerProposalCard({
  proposal,
  bookingId,
  bookingToken,
  memberEmail,
}: {
  proposal: Proposal;
  bookingId: string;
  bookingToken: string | null;
  memberEmail?: string | null;
}) {
  const [loading, setLoading] = useState<"accept" | "counter" | "decline" | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterRate, setCounterRate] = useState(String(proposal?.rate ?? ""));
  const [counterCurrency, setCounterCurrency] = useState(proposal?.currency ?? "EUR");
  const [counterMessage, setCounterMessage] = useState("");
  const [declined, setDeclined] = useState(false);
  const [bookingConfirmed, setBookingConfirmed] = useState(false);

  if (!proposal) {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No proposal has been sent yet.</p>
      </div>
    );
  }

  if (declined || proposal.status === "declined") {
    return (
      <div style={{ ...card, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)" }}>
        <p style={{ color: "#ef4444", fontSize: 14, margin: 0, fontWeight: 600 }}>You declined this proposal.</p>
      </div>
    );
  }

  const isAccepted = bookingConfirmed || proposal.status === "accepted";
  const version = proposal.version ?? 1;
  const sym = currencySym(proposal.currency);
  const amount = proposal.rate ?? 0;

  const showActions = !isAccepted &&
    proposal.sent_by !== "buyer" &&
    (proposal.status === "sent" || proposal.status === "countered");

  async function proceedWithAccept() {
    setLoading("accept");
    setAcceptError(null);
    try {
      const res = await fetch("/api/proposal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, proposal_id: proposal!.id, invite_token: bookingToken }),
      });
      const json = await res.json();
      if (json.confirmed) {
        setBookingConfirmed(true);
        setLoading(null);
        window.location.reload();
      } else {
        setAcceptError(json.error ?? "Something went wrong. Please try again.");
        setLoading(null);
      }
    } catch (err) {
      console.error("[accept]", err);
      setAcceptError("Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  async function handleCounter() {
    setLoading("counter");
    try {
      await fetch("/api/proposal/counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          proposal_id: proposal!.id,
          invite_token: bookingToken,
          rate: parseFloat(counterRate) || 0,
          currency: counterCurrency,
          message: counterMessage,
        }),
      });
      window.location.reload();
    } catch (err) {
      console.error("[counter]", err);
      setLoading(null);
    }
  }

  async function handleDecline() {
    if (!window.confirm("Are you sure? This will cancel the booking request.")) return;
    setLoading("decline");
    try {
      await fetch("/api/proposal/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, invite_token: bookingToken }),
      });
      setDeclined(true);
    } catch (err) {
      console.error("[decline]", err);
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      {/* Confirmed banner — shown without hiding the details below */}
      {isAccepted && (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)", marginBottom: 8 }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: "0 0 14px", fontWeight: 600 }}>✓ Booking accepted</p>
          <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 8px" }}>Next step</p>
          <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 10px", lineHeight: 1.55 }}>
            The seller will handle invoice and payment details directly.
          </p>
          {memberEmail && (
            <a href={`mailto:${memberEmail}`} style={{ fontSize: 13, fontWeight: 600, color: ACCENT, textDecoration: "none", wordBreak: "break-all" }}>
              {memberEmail}
            </a>
          )}
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
            SQRZ is not responsible for payment disputes on manually managed bookings.
          </p>
        </div>
      )}

      {/* Proposal details card */}
      <div style={card}>
        {/* Rate breakdown */}
        {proposal.rate != null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>Proposal amount</span>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
                {sym}{amount.toLocaleString()}
                <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 5 }}>{proposal.currency ?? "EUR"}</span>
              </span>
            </div>
          </div>
        )}

        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 4px", lineHeight: 1.55 }}>
          Payment and tax details are handled directly on the seller&apos;s invoice.
        </p>

        {/* Message */}
        {proposal.message && (
          <div style={{ paddingTop: 14, borderTop: "1px solid var(--border)", marginTop: 8 }}>
            <p style={guestMetaLabel}>Message</p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
              {proposal.message}
            </p>
          </div>
        )}

        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "12px 0 0" }}>
          Proposal v{version}
        </p>
      </div>

      {/* Waiting banner — buyer's own counter is pending */}
      {proposal.sent_by === "buyer" && !isAccepted && (
        <div style={{ ...card, background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.2)" }}>
          <p style={{ color: ACCENT, fontSize: 14, margin: 0, fontWeight: 600 }}>
            Your counter proposal has been sent — waiting for response
          </p>
        </div>
      )}

      {/* FIX 2: Action buttons — Accept button shows exact total */}
      {showActions && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={proceedWithAccept}
            disabled={loading !== null}
            style={{
              width: "100%",
              padding: "14px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: loading !== null ? "default" : "pointer",
              opacity: loading === "accept" ? 0.7 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            {loading === "accept"
              ? "Processing…"
              : amount > 0
                ? `Accept — ${sym}${amount.toLocaleString()} ${proposal.currency ?? "EUR"}`
                : "Accept"}
          </button>

          {acceptError && (
            <p style={{ fontSize: 13, color: "#ef4444", margin: 0, textAlign: "center" as const }}>
              {acceptError}
            </p>
          )}

          {counterOpen ? (
            <div style={card}>
              <p style={{ ...guestMetaLabel, marginBottom: 12 }}>Counter Proposal</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10, marginBottom: 10 }}>
                <input
                  type="number"
                  style={inputStyle}
                  placeholder="Your rate"
                  value={counterRate}
                  onChange={(e) => setCounterRate(e.target.value)}
                />
                <select
                  style={inputStyle}
                  value={counterCurrency}
                  onChange={(e) => setCounterCurrency(e.target.value)}
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                </select>
              </div>
              <textarea
                rows={3}
                style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }}
                placeholder="Explain your counter offer…"
                value={counterMessage}
                onChange={(e) => setCounterMessage(e.target.value)}
              />
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={handleCounter}
                  disabled={loading !== null || !counterRate}
                  style={{
                    flex: 1,
                    padding: "11px",
                    background: "var(--surface-muted)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: loading !== null || !counterRate ? "default" : "pointer",
                    opacity: loading === "counter" ? 0.7 : 1,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {loading === "counter" ? "Sending…" : "Send Counter"}
                </button>
                <button
                  onClick={() => setCounterOpen(false)}
                  disabled={loading !== null}
                  style={{
                    padding: "11px 16px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    color: "var(--text-muted)",
                    fontSize: 13,
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCounterOpen(true)}
              disabled={loading !== null}
              style={{
                width: "100%",
                padding: "12px",
                background: "transparent",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: loading !== null ? "default" : "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              Counter Proposal
            </button>
          )}

          <button
            onClick={handleDecline}
            disabled={loading !== null}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: loading !== null ? "default" : "pointer",
              padding: "4px 0",
              fontFamily: FONT_BODY,
              opacity: loading === "decline" ? 0.7 : 1,
              textAlign: "center" as const,
            }}
          >
            {loading === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      )}
    </>
  );
}

// ─── Re-auth form ─────────────────────────────────────────────────────────────

function ReauthForm({ bookingId }: { bookingId: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      const { error: otpError } = await browserClient.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `https://dashboard.sqrz.com/booking/${bookingId}`,
        },
      });
      if (otpError) throw otpError;
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "80px auto", padding: "0 24px", textAlign: "center", fontFamily: FONT_BODY }}>
      <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
      <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Access this booking</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 28px", lineHeight: 1.6 }}>
        Enter your email to receive a sign-in link for this booking.
      </p>
      {sent ? (
        <div style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 12, padding: "16px 20px", color: "#4ade80", fontSize: 14 }}>
          Check your email — we sent you a sign-in link.
        </div>
      ) : (
        <form onSubmit={handleSend}>
          <input
            type="email" placeholder="your@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} required
            style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 15, boxSizing: "border-box" as const, marginBottom: 12, fontFamily: FONT_BODY }}
          />
          {error && <p style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 10 }}>{error}</p>}
          <button
            type="submit" disabled={loading}
            style={{ width: "100%", padding: "13px", background: ACCENT, color: "#111", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: FONT_BODY }}
          >
            {loading ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Buyer participant ────────────────────────────────────────────────────────

type BuyerParticipant = {
  name: string | null;
  email: string | null;
  phone: string | null;
  billing_company: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_country: string | null;
  billing_vat_id: string | null;
  billing_confirmed: boolean | null;
} | null;

// ─── Invoice (upload + download) ──────────────────────────────────────────────
// Simple invoice surface on a confirmed booking. Owner/talent side gets a PDF upload
// button; both parties get the filename as a download link (fresh signed URL on click).
// No generation, no void, no status states.
function InvoiceSection({
  bookingId,
  invoice,
  canUpload,
  bookingToken,
}: {
  bookingId: string;
  invoice: InvoiceRow | null;
  canUpload: boolean;
  bookingToken: string | null;
}) {
  const uploadFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const downloadFetcher = useFetcher<{ signed_url?: string; error?: string }>();
  const uploading = uploadFetcher.state !== "idle";

  // Open the signed URL as soon as the download endpoint returns it.
  useEffect(() => {
    const url = downloadFetcher.data?.signed_url;
    if (downloadFetcher.state === "idle" && url) {
      window.open(url, "_blank", "noopener");
    }
  }, [downloadFetcher.state, downloadFetcher.data]);

  function download() {
    downloadFetcher.submit(
      { invoice_id: invoice!.id, booking_token: bookingToken ?? "" },
      { method: "post", action: "/api/invoices/download", encType: "application/json" }
    );
  }

  // Nothing to show to the buyer until an invoice exists.
  if (!invoice && !canUpload) return null;

  return (
    <div id="invoice" style={{ ...card }}>
      <p style={{ ...lbl }}>Invoice</p>

      {invoice ? (
        <button
          type="button"
          onClick={download}
          disabled={downloadFetcher.state !== "idle"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "none",
            border: "none",
            padding: 0,
            cursor: downloadFetcher.state !== "idle" ? "default" : "pointer",
            color: ACCENT,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: FONT_BODY,
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 16 }}>📄</span>
          <span style={{ textDecoration: "underline" }}>
            {downloadFetcher.state !== "idle" ? "Opening…" : invoice.file_name}
          </span>
        </button>
      ) : (
        <p style={{ ...val, color: "var(--text-muted)", fontSize: 13, marginBottom: canUpload ? 12 : 0 }}>
          No invoice uploaded yet.
        </p>
      )}

      {downloadFetcher.data?.error && (
        <p style={{ fontSize: 12, color: "#ef4444", margin: "8px 0 0" }}>{downloadFetcher.data.error}</p>
      )}

      {canUpload && (
        <uploadFetcher.Form
          method="post"
          action="/api/invoices/upload"
          encType="multipart/form-data"
          style={{ marginTop: invoice ? 14 : 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}
        >
          <input type="hidden" name="booking_id" value={bookingId} />
          <input
            type="file"
            name="file"
            accept="application/pdf"
            required
            style={{ fontSize: 13, color: "var(--text)", fontFamily: FONT_BODY, maxWidth: "100%" }}
          />
          <button
            type="submit"
            disabled={uploading}
            style={{
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 9,
              padding: "9px 16px",
              fontSize: 13,
              fontWeight: 700,
              cursor: uploading ? "default" : "pointer",
              opacity: uploading ? 0.6 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            {uploading ? "Uploading…" : invoice ? "Replace Invoice (PDF)" : "Upload Invoice (PDF)"}
          </button>
          {uploadFetcher.data?.error && (
            <span style={{ fontSize: 12, color: "#ef4444", width: "100%" }}>{uploadFetcher.data.error}</span>
          )}
        </uploadFetcher.Form>
      )}
    </div>
  );
}

// ─── Member view wrapper ──────────────────────────────────────────────────────

function MemberView({
  booking,
  buyerParticipant,
}: {
  booking: Booking;
  buyerParticipant: BuyerParticipant;
}) {
  const b = booking;

  return (
    <>
      {/* Content — title + single details section */}
      <div style={{ padding: "24px 24px 0", maxWidth: 720, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px", lineHeight: 1.3 }}>
            {(b.title as string) ?? (b.service as string) ?? "Booking"}
          </h1>
          {(b.title as string) && (b.service as string) && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 10px" }}>
              {b.service as string}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
            <StatusBadge status={(b.status as string) ?? "pending"} />
            {(b.city as string) && (
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city as string}</span>
            )}
            {(b.date_start as string) && (
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                {new Date(b.date_start as string).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
          </div>
        </div>

        <MemberBookingSection booking={b} buyerParticipant={buyerParticipant} />
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;

  // ── Dark mode (mirrors _app.tsx — same key, same class) ────────────────────
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = localStorage.getItem("sqrz_theme") as "dark" | "light" | null;
    const initial = saved ?? "dark";
    setTheme(initial);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(initial);
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sqrz_theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }
  const themeToggle = (
    <>
      <button
        onClick={toggleTheme}
        aria-label="Toggle theme"
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 9999,
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 18,
          cursor: "pointer",
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          padding: 6,
        }}
      >
        {theme === "dark" ? "☀️" : "🌙"}
      </button>
    </>
  );

  // ── Invalid token ──────────────────────────────────────────────────────────
  if (data.accessType === "invalid_token") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 24px", textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Invalid or expired link</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>This booking link is no longer valid. Check your email for the correct link.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── No access ──────────────────────────────────────────────────────────────
  if (data.accessType === "no_access") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 24px", textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>You don't have access to this booking</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>You're signed in but you're not a participant in this booking.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Re-auth ────────────────────────────────────────────────────────────────
  if (data.accessType === "reauth") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <ReauthForm bookingId={data.bookingId as string} />
      </div>
    );
  }

  const {
    booking,
    isOwner,
    accessType,
    role,
    proposal,
    bookingToken,
    memberInfo,
    memberEmail,
    buyerParticipant,
    invoice,
  } = data as {
    booking: Booking;
    isOwner: boolean;
    accessType: string;
    role: string;
    proposal: Proposal;
    bookingToken: string | null;
    memberInfo?: MemberInfo;
    memberEmail?: string | null;
    buyerParticipant?: BuyerParticipant;
    invoice?: InvoiceRow | null;
  };

  const b = booking;
  // ── Owner / authenticated member — full rich UI ─────────────────────────────
  if (isOwner) {
    return (
      <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
        {themeToggle}
        <MemberView
          booking={b}
          buyerParticipant={buyerParticipant ?? null}
        />
      </div>
    );
  }

  // ── Guest / participant — single scrollable page ───────────────────────────
  const isBuyer = role === "buyer";
  const bStatus = b.status as string;
  const isConfirmedOrCompleted = bStatus === "confirmed" || bStatus === "completed";

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
      {themeToggle}
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 24px 80px" }}>
        {!b ? (
          <p style={{ color: "var(--text-muted)", textAlign: "center" }}>Booking not found.</p>
        ) : (
          <>
            {/* 1. Booking header */}
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
                {(b.title as string) ?? (b.service as string) ?? "Booking"}
              </h1>
              {(b.title as string) && (b.service as string) && (
                <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 10px" }}>
                  {b.service as string}
                </p>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
                <StatusBadge status={bStatus ?? "pending"} />
                {(b.date_start as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📅 {formatDate(b.date_start as string)}</span>
                )}
                {(b.city as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city as string}{b.venue ? `, ${b.venue as string}` : ""}</span>
                )}
              </div>
            </div>

            {/* 2. Booking details card (includes seller info) */}
            <GuestDetailsCard b={b} memberInfo={memberInfo} />

            {/* 3. Fee details + actions (buyer) */}
            {isBuyer && proposal && (
              <div style={{ marginTop: 8 }}>
                <SectionHeading>Details</SectionHeading>
                <GuestBuyerProposalCard
                  proposal={proposal}
                  bookingId={b.id as string}
                  bookingToken={bookingToken}
                  memberEmail={memberEmail ?? null}
                />
              </div>
            )}

            {/* Non-buyer crew: read-only proposal */}
            {!isBuyer && proposal && <GuestProposalCard proposal={proposal} />}

            {/* 4. Confirmed status (buyer, when not already shown by GuestBuyerProposalCard) */}
            {isBuyer && isConfirmedOrCompleted && !proposal && (
              <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)", marginTop: 8 }}>
                <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
                  ✓ Your booking is confirmed
                  {(b.date_start as string) ? ` · ${formatDate(b.date_start as string)}` : ""}
                </p>
              </div>
            )}

            {/* 5. Invoice — download link once the talent has uploaded one */}
            {isConfirmedOrCompleted && (
              <div style={{ marginTop: 8 }}>
                <InvoiceSection
                  bookingId={b.id as string}
                  invoice={invoice ?? null}
                  canUpload={false}
                  bookingToken={bookingToken}
                />
              </div>
            )}

          </>
        )}
      </div>
    </div>
  );
}
