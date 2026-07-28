import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useSearchParams, redirect } from "react-router";
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

  if (intent === "decline_request") {
    await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return redirect("/office", { headers });
  }

  if (intent === "send_proposal") {
    const rateRaw = parseFloat(formData.get("rate") as string) || null;
    const currency = (formData.get("currency") as string) || "EUR";
    const message = (formData.get("message") as string) || "";
    const existingProposalId = (formData.get("existing_proposal_id") as string) || null;
    const rate = rateRaw;

    const admin = createSupabaseAdminClient();
    const { error: bookingError } = await supabase
      .from("bookings")
      .update({ status: "pending" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);

    if (bookingError) return Response.json({ error: bookingError.message }, { status: 500, headers });

    // Versioning: if revising an existing proposal, increment version and mark old as countered
    let newVersion = 1;
    let parentProposalId: string | null = null;

    if (existingProposalId) {
      const { data: prev } = await admin
        .from("booking_proposals")
        .select("version")
        .eq("id", existingProposalId)
        .single();

      newVersion = (prev?.version ?? 1) + 1;
      parentProposalId = existingProposalId;

      await admin
        .from("booking_proposals")
        .update({ status: "countered" })
        .eq("id", existingProposalId);
    }

    const { error: insertError } = await admin
      .from("booking_proposals")
      .insert({
        booking_id: params.id,
        rate,
        currency,
        require_hotel: false,
        require_travel: false,
        require_food: false,
        requires_payment: false,
        message: message || null,
        status: "sent",
        sent_by: "member",
        version: newVersion,
        parent_proposal_id: parentProposalId,
        line_items: null,
        tax_pct: null,
        tax_label: null,
        sqrz_fee_pct: 0,
      })
      .select();

    if (insertError) {
      console.error("[proposal insert] error:", insertError);
    }

    try {
      const { data: bkData } = await supabase
        .from("bookings")
        .select("service, date_start, city, venue")
        .eq("id", params.id)
        .maybeSingle();

      const { data: buyer } = await admin
        .from("booking_participants")
        .select("email, name, user_id, invite_token")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();

      const guestEmail = buyer?.email;
      const guestName = buyer?.name;

      if (!guestEmail) {
        console.error("[proposal] no buyer found for booking", params.id);
        return Response.json({ error: "No requester found for this booking" }, { status: 422, headers });
      }

      const ownerName =
        (profile.name as string | null) ??
        (profile.first_name as string | null) ??
        "Your booking partner";
      const accessUrl = buyer?.invite_token
        ? `https://dashboard.sqrz.com/booking/${params.id}?token=${buyer.invite_token}`
        : `https://dashboard.sqrz.com/booking/${params.id}`;

      const emailHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#0a0a0a;padding:32px;text-align:center;">
      <img src="https://sqrz.com/brand/sqrz_logo.png" alt="SQRZ" style="height:32px;" />
    </div>
    <div style="padding:32px;">
      <p style="color:#666;font-size:14px;margin:0 0 8px;">Hi ${guestName ?? "there"},</p>
      <h1 style="font-size:24px;font-weight:700;margin:0 0 24px;color:#0a0a0a;">
        You have a proposal from ${ownerName}
      </h1>
      <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
        ${bkData?.service ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Service</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${bkData.service}</p></div>` : ""}
        ${bkData?.date_start ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Date</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${new Date(bkData.date_start).toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p></div>` : ""}
        ${bkData?.city ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Location</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${bkData.venue ? `${bkData.venue}, ` : ""}${bkData.city}</p></div>` : ""}
        <div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;">
          <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Proposed Rate</span>
          <p style="margin:4px 0 0;font-size:28px;font-weight:700;color:#0a0a0a;">${currency.toUpperCase()} ${rate}</p>
        </div>
        ${message ? `<div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Note from ${ownerName}</span><p style="margin:4px 0 0;color:#0a0a0a;">${message}</p></div>` : ""}
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="${accessUrl}" style="background:#F3B130;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
          View Full Proposal →
        </a>
      </div>
      <p style="color:#999;font-size:12px;text-align:center;">
        This link gives you direct access to your booking — no login needed.
      </p>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eee;text-align:center;">
      <p style="color:#ccc;font-size:11px;margin:0;">Powered by <a href="https://sqrz.com" style="color:#F3B130;text-decoration:none;">SQRZ</a></p>
    </div>
  </div>
</body>
</html>`;

      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: guestEmail,
        subject: `${ownerName} sent you a proposal on SQRZ`,
        html: emailHtml,
      });
    } catch (err) {
      console.error("[proposal] email send failed:", err);
    }

    return Response.json({ ok: true }, { headers });
  }

  if (intent === "mark_as_delivered") {
    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
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

function formatRate(rate: number | null, currency: string | null): string {
  if (!rate) return "—";
  const sym = currency?.toUpperCase() === "EUR" ? "€" : currency?.toUpperCase() === "GBP" ? "£" : "$";
  return `${sym}${rate.toLocaleString()}`;
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

// ─── Member view sections ─────────────────────────────────────────────────────

function DetailsSection({ booking, memberInfo, buyerParticipant }: { booking: Booking; memberInfo?: MemberInfo; buyerParticipant?: BuyerParticipant }) {
  const b = booking;

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      {!!buyerParticipant && (
        <div style={card}>
          <p style={lbl}>Buyer</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {buyerParticipant.name && <p style={{ ...val, fontWeight: 600 }}>{buyerParticipant.name}</p>}
            {buyerParticipant.email && <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{buyerParticipant.email}</p>}
            {buyerParticipant.phone && <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{buyerParticipant.phone}</p>}
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: b.service ? 14 : 0 }}>
          <StatusBadge status={(b.status as string) ?? "pending"} />
        </div>
        {!!b.service && (
          <div>
            <p style={lbl}>Service</p>
            <p style={val}>{b.service as string}</p>
          </div>
        )}
      </div>

      <div style={card}>
        {!!(b.date_end && b.date_end !== b.date_start) ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <p style={lbl}>Start</p>
              <p style={val}>{formatDateTime(b.date_start as string | null)}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ ...lbl, textAlign: "right" }}>End</p>
              <p style={{ ...val, textAlign: "right" }}>{formatDateTime(b.date_end as string | null)}</p>
            </div>
          </div>
        ) : (
          <div>
            <p style={lbl}>Date</p>
            <p style={val}>{formatDateTime(b.date_start as string | null)}</p>
          </div>
        )}
      </div>

      {!!(b.venue_address || b.venue_city || b.venue_zip || b.venue_country) && (
        <div style={card}>
          <p style={{ ...lbl, marginBottom: 14 }}>Location</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 16px" }}>
            {!!b.venue_address && (
              <div>
                <p style={lbl}>Street</p>
                <p style={val}>{b.venue_address as string}</p>
              </div>
            )}
            {!!b.venue_city && (
              <div>
                <p style={lbl}>City</p>
                <p style={val}>{b.venue_city as string}</p>
              </div>
            )}
            {!!b.venue_zip && (
              <div>
                <p style={lbl}>ZIP</p>
                <p style={val}>{b.venue_zip as string}</p>
              </div>
            )}
            {!!b.venue_country && (
              <div>
                <p style={lbl}>Country</p>
                <p style={val}>{b.venue_country as string}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rate is shown in full detail in the Proposal section — not duplicated here */}

      {(booking as { description?: string | null }).description && (
        <div style={card}>
          <p style={lbl}>Message from requester</p>
          <p style={{ ...val, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65 }}>
            {(booking as { description: string }).description}
          </p>
        </div>
      )}

      {memberInfo && (memberInfo.company_name || memberInfo.legal_form || memberInfo.vat_id || memberInfo.responsible_person) && (
        <div style={card}>
          <p style={lbl}>Seller Information</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {(memberInfo.company_name || memberInfo.name) && (
              <p style={{ ...val, fontWeight: 600 }}>{memberInfo.company_name ?? memberInfo.name}</p>
            )}
            {memberInfo.legal_form && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{memberInfo.legal_form}</p>
            )}
            {memberInfo.company_address && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{memberInfo.company_address}</p>
            )}
            {memberInfo.vat_id && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>VAT: {memberInfo.vat_id}</p>
            )}
          </div>
        </div>
      )}

    </section>
  );
}

function ProposalSection({ booking }: { booking: Booking }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const declineFetcher = useFetcher<{ ok?: boolean }>();

  // All proposals sorted by version desc — latest first
  const allProposals = ((booking as { booking_proposals?: Array<NonNullable<Proposal>> }).booking_proposals ?? [])
    .slice()
    .sort((a, b) => ((b.version ?? 0) - (a.version ?? 0)));
  const latestProposal = allProposals[0] ?? null;
  const buyerCounted = latestProposal?.sent_by === "buyer";
  const memberSentAndWaiting = latestProposal?.sent_by === "member" && latestProposal?.status === "sent";
  const isRevise = !!latestProposal;

  // Hide form when member is waiting for buyer response, or buyer has countered
  const [showForm, setShowForm] = useState(!buyerCounted && !memberSentAndWaiting);
  const [showHistory, setShowHistory] = useState(false);

  const [form, setForm] = useState({
    rate: String(latestProposal?.rate ?? ""),
    currency: latestProposal?.currency ?? "EUR",
    message: "",
  });

  const sent = fetcher.state === "idle" && fetcher.data?.ok;
  const sym = currencySym(latestProposal?.currency ?? "EUR");

  return (
    <section id="proposal" style={{ paddingBottom: 40 }}>
      <SectionHeading>
        {buyerCounted ? "Counter Offer" : (showForm && isRevise) ? "Revise Proposal" : "Proposal"}
      </SectionHeading>

      {sent ? (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)" }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
            ✓ {isRevise ? "Revised proposal sent." : "Proposal sent — booking is now pending."}
          </p>
        </div>
      ) : (
        <>
          {/* Member sent proposal — waiting for buyer response */}
          {memberSentAndWaiting && !showForm && (
            <>
              {/* Sent proposal — full breakdown (read-only) */}
              {latestProposal!.rate != null && (() => {
                const p = latestProposal!;
                const symP = currencySym(p.currency);
                return (
                  <div style={card}>
                    <p style={{ ...lbl, marginBottom: 10 }}>Sent Proposal</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>Amount</span>
                        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 700 }}>{symP}{(p.rate ?? 0).toLocaleString()} <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{p.currency ?? "EUR"}</span></span>
                      </div>
                    </div>
                    {p.message && (
                      <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: "12px 0 0", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        {p.message}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Waiting banner */}
              <div style={{ ...card, background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.2)" }}>
                <p style={{ color: ACCENT, fontSize: 14, margin: 0, fontWeight: 600 }}>
                  Proposal sent — waiting for buyer response
                </p>
              </div>

              {/* Revise button */}
              <button
                onClick={() => setShowForm(true)}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: "10px 18px",
                  fontFamily: FONT_BODY,
                  marginTop: 4,
                }}
              >
                Revise Proposal
              </button>
            </>
          )}

          {/* Buyer counter banner */}
          {buyerCounted && (
            <div style={{ ...card, background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.25)", marginBottom: 4 }}>
              <p style={{ color: "#60a5fa", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", margin: "0 0 6px" }}>
                Buyer countered
              </p>
              <p style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>
                {sym}{(latestProposal!.rate ?? 0).toLocaleString()}
                <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
                  {latestProposal!.currency ?? "EUR"}
                </span>
              </p>
              {latestProposal?.message && (
                <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                  "{latestProposal.message}"
                </p>
              )}
            </div>
          )}

          {/* Revise button — shown when buyer countered and form is collapsed */}
          {buyerCounted && !showForm && (
            <button
              onClick={() => setShowForm(true)}
              style={{
                width: "100%",
                padding: "13px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT_BODY,
                marginBottom: 12,
              }}
            >
              Revise Proposal
            </button>
          )}

          {/* Proposal form */}
          {showForm && (
            <div style={card}>
              {/* Rate + Currency */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 12, marginBottom: 6 }}>
                <div>
                  <p style={{ ...lbl, marginBottom: 6 }}>Total Budget (what the booker pays)</p>
                  <input
                    type="number"
                    style={inputStyle}
                    value={form.rate}
                    onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                    placeholder="1500"
                  />
                </div>
                <div>
                  <p style={{ ...lbl, marginBottom: 6 }}>Currency</p>
                  <select
                    style={{ ...inputStyle }}
                    value={form.currency}
                    onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 14px", lineHeight: 1.5 }}>
                Enter the proposal amount. Taxes, payment terms, and final invoice details stay on your invoice.
              </p>

              {/* Message */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ ...lbl, marginBottom: 6 }}>Message (optional)</p>
                <textarea
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical" }}
                  value={form.message}
                  onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                  placeholder="Add a note to your proposal…"
                />
              </div>

              {fetcher.data?.error && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{fetcher.data.error}</p>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => {
                    const fd = new FormData();
                    fd.append("intent", "send_proposal");
                    fd.append("rate", form.rate);
                    fd.append("currency", form.currency);
                    fd.append("message", form.message);
                    if (latestProposal?.id) fd.append("existing_proposal_id", latestProposal.id);
                    fetcher.submit(fd, { method: "post" });
                  }}
                  disabled={fetcher.state !== "idle"}
                  style={{
                    flex: 1,
                    padding: "13px",
                    background: ACCENT,
                    color: "#111",
                    border: "none",
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: fetcher.state !== "idle" ? "default" : "pointer",
                    opacity: fetcher.state !== "idle" ? 0.7 : 1,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {fetcher.state !== "idle" ? "Sending…" : isRevise ? "Send Revised Proposal" : "Send Proposal"}
                </button>
                {isRevise && (
                  <button
                    onClick={() => setShowForm(false)}
                    style={{
                      padding: "13px 16px",
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
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Decline request — only shown for member when status is still requested */}
      {(booking.status as string) === "requested" && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button
            onClick={() => {
              if (!window.confirm("Decline this booking request?")) return;
              const fd = new FormData();
              fd.append("intent", "decline_request");
              declineFetcher.submit(fd, { method: "post" });
            }}
            disabled={declineFetcher.state !== "idle"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: FONT_BODY, padding: "4px 0" }}
          >
            Decline Request
          </button>
        </div>
      )}

      {/* Negotiation history toggle — only shown when multiple versions exist */}
      {allProposals.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowHistory((h) => !h)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
              fontFamily: FONT_BODY,
            }}
          >
            {showHistory
              ? "Hide negotiation history ▲"
              : `View negotiation history (${allProposals.length} versions) ▼`}
          </button>
          {showHistory && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {allProposals.map((p) => (
                <div
                  key={p.id}
                  style={{
                    ...card,
                    marginBottom: 0,
                    borderColor: p.sent_by === "buyer" ? "rgba(96,165,250,0.25)" : "var(--border)",
                    background: p.sent_by === "buyer" ? "rgba(96,165,250,0.04)" : "var(--surface)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: p.sent_by === "buyer" ? "#60a5fa" : ACCENT, marginRight: 8 }}>
                        v{p.version ?? 1} · {p.sent_by === "buyer" ? "Buyer" : "You"}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                        {currencySym(p.currency)}{(p.rate ?? 0).toLocaleString()} {p.currency}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "capitalize" as const }}>
                      {p.status}
                    </span>
                  </div>
                  {p.message && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
                      {p.message}
                    </p>
                  )}
                </div>
              ))}
            </div>
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
  bookingToken,
  memberInfo,
  proposal,
  buyerParticipant,
  invoice,
  showMobileOfficeBack = false,
  onMobileOfficeBack,
}: {
  booking: Booking;
  bookingToken?: string | null;
  memberInfo?: MemberInfo;
  proposal: Proposal | null;
  buyerParticipant: BuyerParticipant;
  invoice: InvoiceRow | null;
  showMobileOfficeBack?: boolean;
  onMobileOfficeBack?: () => void;
}) {
  const b = booking;
  const showProposal = ["requested", "pending"].includes(b.status as string);
  const showInvoice = ["confirmed", "completed"].includes(b.status as string);

  const sections = [
    { id: "details",  label: "Details" },
    ...(showProposal ? [{ id: "proposal", label: "Proposal" }] : []),
    ...(showInvoice ? [{ id: "invoice", label: "Invoice" }] : []),
  ];

  const [activeSection, setActiveSection] = useState(sections[0].id);

  useEffect(() => {
    const OFFSET = 120;
    function onScroll() {
      let current = sections[0].id;
      for (const { id } of sections) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= OFFSET) current = id;
      }
      setActiveSection(current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [b.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 116;
    window.scrollTo({ top, behavior: "smooth" });
  }

  return (
    <>
      {/* Sticky tab nav — first element, nothing above it */}
      <div style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--surface)",
        borderBottom: "0.5px solid var(--border)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 8,
        padding: "0 24px",
      }}>
        {showMobileOfficeBack && (
          <button
            onClick={onMobileOfficeBack}
            aria-label="Back to Office"
            style={{
              position: "absolute",
              left: 18,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              lineHeight: "22px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "14px 0",
              fontFamily: FONT_BODY,
            }}
          >
            ← Office
          </button>
        )}
        {sections.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => scrollToSection(id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeSection === id ? `2px solid ${ACCENT}` : "2px solid transparent",
              color: activeSection === id ? ACCENT : "var(--text-muted)",
              fontSize: 13,
              fontWeight: activeSection === id ? 700 : 500,
              padding: "14px 14px",
              cursor: "pointer",
              transition: "color 0.15s",
              fontFamily: FONT_BODY,
              lineHeight: "22px",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content — title + sections */}
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

        <DetailsSection booking={b} memberInfo={memberInfo} buyerParticipant={buyerParticipant} />

        {(b.status as string) === "cancelled" && (
          <div style={{ ...card, marginBottom: 16 }}>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>This booking was declined.</p>
          </div>
        )}

        {showProposal && <ProposalSection booking={b} />}

        {showInvoice && (
          <InvoiceSection
            bookingId={b.id as string}
            invoice={invoice}
            canUpload={true}
            bookingToken={bookingToken ?? null}
          />
        )}
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;
  const [searchParams] = useSearchParams();
  const fromOffice = searchParams.get("from") === "office";
  const [isStandalonePwa, setIsStandalonePwa] = useState(false);
  const [isMobileBookingNav, setIsMobileBookingNav] = useState(false);

  useEffect(() => {
    const compute = () => {
      const standalone = typeof window !== "undefined" && (
        window.matchMedia?.("(display-mode: standalone)")?.matches ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      );
      setIsStandalonePwa(Boolean(standalone));
    };

    compute();
    const media = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(display-mode: standalone)")
      : null;
    media?.addEventListener?.("change", compute);

    return () => {
      media?.removeEventListener?.("change", compute);
    };
  }, []);

  useEffect(() => {
    const media = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 767px)")
      : null;
    const compute = () => setIsMobileBookingNav(Boolean(media?.matches));

    compute();
    media?.addEventListener?.("change", compute);

    return () => {
      media?.removeEventListener?.("change", compute);
    };
  }, []);

  function goBackToOffice() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.href = "/office";
  }

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
      {fromOffice && isStandalonePwa && !isMobileBookingNav && (
        <button
          onClick={goBackToOffice}
          aria-label="Back to Office"
          style={{
            position: "fixed",
            top: 16,
            left: 16,
            zIndex: 9999,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 999,
            boxShadow: "0 12px 30px rgba(0,0,0,0.16)",
          }}
        >
          ← Office
        </button>
      )}
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
  // ── Owner / authenticated member (or billing delegate) — full rich UI ───────
  if (isOwner) {
    return (
      <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
        {themeToggle}
        <MemberView
          booking={b}
          bookingToken={bookingToken}
          memberInfo={memberInfo}
          proposal={proposal ?? null}
          buyerParticipant={buyerParticipant ?? null}
          invoice={invoice ?? null}
          showMobileOfficeBack={fromOffice && isStandalonePwa && isMobileBookingNav}
          onMobileOfficeBack={goBackToOffice}
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
