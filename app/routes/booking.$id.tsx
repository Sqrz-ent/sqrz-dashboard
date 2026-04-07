import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/booking.$id";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel } from "~/lib/plans";
import { supabase as browserClient } from "~/lib/supabase.client";
import BookingWallet, { type WalletData } from "~/components/BookingWallet";

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

type Proposal = {
  id: string;
  booking_id: string;
  rate: number | null;
  currency: string | null;
  message: string | null;
  status: string | null;
  require_hotel: boolean | null;
  require_travel: boolean | null;
  require_food: boolean | null;
  payment_method?: string | null;
} | null;


// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // PKCE code exchange — magic link callback
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  // ── 1. TOKEN PATH ─────────────────────────────────────────────────────────
  const token = url.searchParams.get("token");
  if (token) {
    const admin = createSupabaseAdminClient();
    const { data: row } = await admin
      .from("booking_participants")
      .select("id, booking_id, email, role, invite_token, user_id, bookings(*)")
      .eq("booking_id", params.id)
      .eq("invite_token", token)
      .limit(1)
      .maybeSingle();

    if (!row) return Response.json({ accessType: "invalid_token" }, { headers });

    const booking = (row as Record<string, unknown>).bookings as Booking;
    const participant: GuestParticipant = {
      id: row.id,
      booking_id: row.booking_id,
      email: row.email,
      role: row.role,
      invite_token: row.invite_token,
      user_id: row.user_id,
    };

    const { data: proposal } = await admin
      .from("booking_proposals")
      .select("*")
      .eq("booking_id", params.id)
      .maybeSingle();

    return Response.json(
      {
        accessType: "token",
        booking,
        participant,
        role: row.role as string,
        userEmail: row.email ?? "",
        isOwner: false,
        proposal: proposal ?? null,
        bookingToken: token,
        wallet: null,
        profileId: null,
        planId: null,
        isBeta: false,
      },
      { headers }
    );
  }

  // ── 2. SESSION PATH ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);
    const admin = createSupabaseAdminClient();

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
      if (!isParticipant) return Response.json({ accessType: "invalid_token" }, { headers });
    }

    // Wallet + allocations for owner on bookable statuses
    let wallet: WalletData | null = null;
    const showPaymentsTab = ["pending", "confirmed", "completed"].includes(booking.status);
    if (isOwner && showPaymentsTab) {
      const { data: existingWallet } = await admin
        .from("booking_wallets")
        .select("*")
        .eq("booking_id", booking.id)
        .maybeSingle();

      let baseWallet = existingWallet;
      if (!baseWallet) {
        const firstProposal = (booking.booking_proposals ?? [])[0];
        const { data: newWallet } = await admin
          .from("booking_wallets")
          .insert({
            booking_id: booking.id,
            owner_profile_id: profile!.id,
            total_budget: firstProposal?.rate ?? 0,
            currency: firstProposal?.currency ?? "EUR",
            sqrz_fee_pct: 10,
            status: "pending",
          })
          .select("*")
          .single();
        baseWallet = newWallet ?? null;
      }

      if (baseWallet) {
        const { data: allocations } = await admin
          .from("wallet_allocations")
          .select("id, role, amount, currency, status")
          .eq("wallet_id", baseWallet.id);
        wallet = { ...(baseWallet as WalletData), allocations: allocations ?? [] };
      }
    }

    const proposal = (booking.booking_proposals ?? [])[0] ?? null;

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : "member",
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        bookingToken: null,
        wallet,
        profileId: (profile?.id as string) ?? null,
        planId: (profile?.plan_id as number | null) ?? null,
        isBeta: (profile?.is_beta as boolean) ?? false,
      },
      { headers }
    );
  }

  // ── 3. NO TOKEN, NO SESSION ───────────────────────────────────────────────
  return Response.json({ accessType: "reauth", bookingId: params.id }, { headers });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bookingToken = formData.get("bookingToken") as string | null;

  // Token-based: guest confirm / decline
  if ((intent === "confirm_booking" || intent === "decline_booking") && bookingToken) {
    const admin = createSupabaseAdminClient();
    const { data: participant } = await admin
      .from("booking_participants")
      .select("role")
      .eq("booking_id", params.id)
      .eq("invite_token", bookingToken)
      .maybeSingle();

    if (!participant) return Response.json({ error: "Unauthorized" }, { headers, status: 403 });

    const newStatus = intent === "confirm_booking" ? "confirmed" : "requested";
    const { error } = await admin.from("bookings").update({ status: newStatus }).eq("id", params.id);
    return Response.json({ ok: !error }, { headers });
  }

  // Session-based: all member / owner intents
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { headers, status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  // Session confirm / decline (no token)
  if (intent === "confirm_booking" || intent === "decline_booking") {
    const newStatus = intent === "confirm_booking" ? "confirmed" : "requested";
    const { error } = await supabase.from("bookings").update({ status: newStatus }).eq("id", params.id);
    return Response.json({ ok: !error }, { headers });
  }

  // All intents below require ownership
  const { data: bkCheck } = await supabase
    .from("bookings")
    .select("owner_id")
    .eq("id", params.id)
    .single();

  if (!bkCheck || bkCheck.owner_id !== profile.id) {
    return Response.json({ error: "Unauthorized" }, { headers, status: 403 });
  }

  if (intent === "update_status") {
    const status = formData.get("status") as string;
    await supabase.from("bookings").update({ status }).eq("id", params.id).eq("owner_id", profile.id as string);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "update_show_label") {
    const { error } = await supabase
      .from("bookings")
      .update({ show_label: formData.get("show_label") === "true" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "send_proposal") {
    const rate = parseFloat(formData.get("rate") as string) || null;
    const currency = (formData.get("currency") as string) || "EUR";
    const message = (formData.get("message") as string) || "";
    const requireHotel = formData.get("require_hotel") === "true";
    const requireTravel = formData.get("require_travel") === "true";
    const requireFood = formData.get("require_food") === "true";
    const paymentMethod = (formData.get("payment_method") as string) || "external";

    const { error: bookingError } = await supabase
      .from("bookings")
      .update({ status: "pending" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);

    if (bookingError) return Response.json({ error: bookingError.message }, { status: 500, headers });

    await supabase.from("booking_proposals").insert({
      booking_id: params.id,
      rate,
      currency,
      require_hotel: requireHotel,
      require_travel: requireTravel,
      require_food: requireFood,
      payment_method: paymentMethod,
      message: message || null,
    });

    try {
      const { data: bkData } = await supabase
        .from("bookings")
        .select("service, date_start, city, venue")
        .eq("id", params.id)
        .maybeSingle();

      const admin = createSupabaseAdminClient();
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

      const riderItems = [
        requireHotel && "🏨 Hotel",
        requireTravel && "✈️ Travel",
        requireFood && "🍽️ Catering",
      ]
        .filter(Boolean)
        .join(" · ");

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
        ${riderItems ? `<div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Rider</span><p style="margin:4px 0 0;color:#0a0a0a;">${riderItems}</p></div>` : ""}
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

  if (intent === "invite_team_member") {
    const name  = ((formData.get("name")  as string) ?? "").trim();
    const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
    const role  = ((formData.get("role")  as string) ?? "").trim();
    const pay   = parseFloat(formData.get("pay") as string) || null;

    if (!email.includes("@")) return Response.json({ error: "Invalid email" }, { status: 400, headers });

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    let guestProfileId: string | null = existing?.id ?? null;
    if (!guestProfileId) {
      const { data: newProfile } = await supabase
        .from("profiles")
        .insert({ email, name, user_type: "guest", is_published: false, created_by: "team_invite" })
        .select("id")
        .single();
      guestProfileId = newProfile?.id ?? null;
    }

    const inviteToken = crypto.randomUUID();
    const { data: participant, error: participantError } = await supabase
      .from("booking_participants")
      .insert({ booking_id: params.id, user_id: null, name, email, role, pay, is_admin: false, invite_token: inviteToken })
      .select()
      .single();

    if (participantError) return Response.json({ error: participantError.message }, { status: 500, headers });
    console.log("[invite] participant:", participant?.id);

    try {
      const admin = createSupabaseAdminClient();
      const next = encodeURIComponent(`/booking/${params.id}?token=${inviteToken}`);
      const redirectTo = `https://dashboard.sqrz.com/auth/callback?next=${next}`;
      const { data: linkData } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: email,
        subject: "You've been invited to a booking",
        html: `<p>Hi ${name},</p><p>You've been invited to collaborate on a booking.</p><p><a href="${linkData?.properties?.action_link}">Click here to access the booking</a></p><p>The SQRZ Team</p>`,
      });
    } catch (err) {
      console.error("[invite] email send failed:", err);
    }

    return Response.json({ ok: true, invited: email }, { headers });
  }

  if (intent === "mark_as_paid") {
    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "mark_as_delivered") {
    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    const admin = createSupabaseAdminClient();
    await admin
      .from("booking_wallets")
      .update({ payout_status: "approved", delivery_confirmed_at: new Date().toISOString() })
      .eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_save_costs") {
    const transport = parseFloat(formData.get("transport") as string) || 0;
    const hotel     = parseFloat(formData.get("hotel")     as string) || 0;
    const food      = parseFloat(formData.get("food")      as string) || 0;
    const admin = createSupabaseAdminClient();
    await admin
      .from("booking_wallets")
      .update({ notes: JSON.stringify({ transport, hotel, food }) })
      .eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_mark_paid") {
    const admin = createSupabaseAdminClient();
    await admin.from("booking_wallets").update({ client_paid: true }).eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_expense") {
    const walletId  = formData.get("wallet_id") as string;
    const expLabel  = formData.get("expense_label") as string;
    const expAmount = parseFloat(formData.get("expense_amount") as string) || 0;
    const currency  = formData.get("currency") as string;
    const admin = createSupabaseAdminClient();
    await admin.from("wallet_allocations").insert({
      wallet_id: walletId,
      participant_id: null,
      role: expLabel,
      amount: expAmount,
      currency,
      status: "pending",
    });
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
  requested: { bg: "rgba(245,166,35,0.12)", text: ACCENT },
  pending:   { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed: { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  archived:  { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
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

// ─── Top bar ──────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 56, background: "var(--surface)", borderBottom: "0.5px solid var(--border)" }}>
      <img src="/sqrz-logo.png" alt="SQRZ" style={{ height: 28, display: "block" }} />
    </header>
  );
}

// ─── Member view sections ─────────────────────────────────────────────────────

function DetailsSection({ booking }: { booking: Booking }) {
  const showLabelFetcher = useFetcher();
  const b = booking;

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: b.service ? 14 : 0 }}>
          <StatusBadge status={(b.status as string) ?? "pending"} />
        </div>
        {b.service && (
          <div>
            <p style={lbl}>Service</p>
            <p style={val}>{b.service as string}</p>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <p style={lbl}>Start date</p>
            <p style={val}>{formatDate(b.date_start as string | null)}</p>
          </div>
          {b.date_end && b.date_end !== b.date_start && (
            <div>
              <p style={lbl}>End date</p>
              <p style={val}>{formatDate(b.date_end as string | null)}</p>
            </div>
          )}
        </div>
      </div>

      <div style={card}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            defaultChecked={!!(b.show_label)}
            onChange={(e) => {
              const fd = new FormData();
              fd.append("intent", "update_show_label");
              fd.append("show_label", String(e.target.checked));
              showLabelFetcher.submit(fd, { method: "post" });
            }}
            style={{ accentColor: ACCENT, cursor: "pointer", width: 16, height: 16 }}
          />
          <div>
            <p style={{ ...lbl, margin: 0 }}>Show on public calendar</p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
              When on, the booking title is visible on your profile calendar
            </p>
          </div>
        </label>
      </div>

      {(b.city || b.venue || b.address) && (
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: b.address ? 14 : 0 }}>
            {b.venue && (
              <div>
                <p style={lbl}>Venue</p>
                <p style={val}>{b.venue as string}</p>
              </div>
            )}
            {b.city && (
              <div>
                <p style={lbl}>City</p>
                <p style={val}>{b.city as string}</p>
              </div>
            )}
          </div>
          {b.address && (
            <div>
              <p style={lbl}>Address</p>
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{b.address as string}</p>
            </div>
          )}
        </div>
      )}

      {(booking as { booking_proposals?: Array<{ rate?: number | null; currency?: string | null }> })
        .booking_proposals?.[0]?.rate != null && (
        <div style={card}>
          <p style={lbl}>Agreed Rate</p>
          <p style={{ ...val, color: ACCENT, fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {formatRate(
              (booking as { booking_proposals: Array<{ rate: number | null; currency: string | null }> })
                .booking_proposals[0].rate,
              (booking as { booking_proposals: Array<{ rate: number | null; currency: string | null }> })
                .booking_proposals[0].currency
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function ProposalSection({
  booking,
  planLevel,
}: {
  booking: Booking;
  planLevel: number;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const proposal = (booking as { booking_proposals?: Array<Proposal> }).booking_proposals?.[0];
  const [form, setForm] = useState({
    rate: String(proposal?.rate ?? ""),
    currency: proposal?.currency ?? "EUR",
    message: "",
    require_travel: proposal?.require_travel ?? false,
    require_hotel: proposal?.require_hotel ?? false,
    require_food: proposal?.require_food ?? false,
    payment_method: proposal?.payment_method ?? "external",
  });

  const sent = fetcher.state === "idle" && fetcher.data?.ok;
  const canUseStripe = planLevel >= 1;

  return (
    <section id="proposal" style={{ paddingBottom: 40 }}>
      <SectionHeading>Proposal</SectionHeading>

      {sent ? (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)" }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
            ✓ Proposal sent — booking is now pending.
          </p>
        </div>
      ) : (
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 12, marginBottom: 14 }}>
            <div>
              <p style={{ ...lbl, marginBottom: 6 }}>Your Rate</p>
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

          <div style={{ marginBottom: 16 }}>
            <p style={{ ...lbl, marginBottom: 10 }}>Payment Method</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(
                [
                  { value: "external", label: "Handle externally", sub: "I'll invoice the client myself", disabled: false },
                  { value: "stripe", label: "Request via SQRZ", sub: "Stripe payment link — Creator+", disabled: !canUseStripe },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 9,
                    border: `1px solid ${form.payment_method === opt.value ? ACCENT : "var(--border)"}`,
                    background: form.payment_method === opt.value ? "rgba(245,166,35,0.06)" : "var(--bg)",
                    cursor: opt.disabled ? "not-allowed" : "pointer",
                    opacity: opt.disabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="payment_method"
                    value={opt.value}
                    checked={form.payment_method === opt.value}
                    disabled={opt.disabled}
                    onChange={() => !opt.disabled && setForm((f) => ({ ...f, payment_method: opt.value }))}
                    style={{ accentColor: ACCENT, marginTop: 2, flexShrink: 0 }}
                  />
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>{opt.label}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>{opt.sub}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

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

          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            {(
              [
                { key: "require_travel", label: "Require Travel" },
                { key: "require_hotel", label: "Require Hotel" },
                { key: "require_food", label: "Require Food" },
              ] as const
            ).map(({ key, label: lbl2 }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                  style={{ accentColor: ACCENT, width: 15, height: 15 }}
                />
                {lbl2}
              </label>
            ))}
          </div>

          {fetcher.data?.error && (
            <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{fetcher.data.error}</p>
          )}

          <button
            onClick={() => {
              const fd = new FormData();
              fd.append("intent", "send_proposal");
              fd.append("rate", form.rate);
              fd.append("currency", form.currency);
              fd.append("message", form.message);
              fd.append("require_hotel", String(form.require_hotel));
              fd.append("require_travel", String(form.require_travel));
              fd.append("require_food", String(form.require_food));
              fd.append("payment_method", form.payment_method);
              fetcher.submit(fd, { method: "post" });
            }}
            disabled={fetcher.state !== "idle"}
            style={{
              width: "100%",
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
            {fetcher.state !== "idle" ? "Sending…" : "Send Proposal"}
          </button>
        </div>
      )}
    </section>
  );
}


// ─── Payment success banner ───────────────────────────────────────────────────

function PaymentSuccessBanner() {
  const [searchParams] = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || searchParams.get("payment") !== "success") return null;

  return (
    <div
      style={{
        background: "rgba(74,222,128,0.12)",
        border: "1px solid rgba(74,222,128,0.4)",
        borderRadius: 10,
        margin: "12px 24px",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: FONT_BODY,
      }}
    >
      <span style={{ color: "#4ade80", fontSize: 14, fontWeight: 600 }}>
        ✓ Payment received — booking confirmed
      </span>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: "none", border: "none", color: "#4ade80", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 0 }}
      >
        ✕
      </button>
    </div>
  );
}

function ActionsSection({ booking, wallet }: { booking: Booking; wallet?: WalletData | null }) {
  const fetcher = useFetcher();

  function submitStatus(status: string) {
    const fd = new FormData();
    fd.append("intent", "update_status");
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function submitMarkDelivered() {
    const fd = new FormData();
    fd.append("intent", "mark_as_delivered");
    fetcher.submit(fd, { method: "post" });
  }

  const isRequested = booking.status === "requested";
  const isConfirmed = booking.status === "confirmed";
  const clientPaid = wallet?.client_paid === true;

  const actionLink: React.CSSProperties = {
    background: "none",
    border: "none",
    color: ACCENT,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "10px 0",
    fontFamily: FONT_BODY,
    textAlign: "left",
    display: "block",
    width: "100%",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <section id="actions" style={{ paddingBottom: 80 }}>
      <SectionHeading>Actions</SectionHeading>
      <div style={card}>
        {isRequested ? (
          <>
            <button
              style={actionLink}
              onClick={() => {
                const el = document.getElementById("proposal");
                if (!el) return;
                const top = el.getBoundingClientRect().top + window.scrollY - 120;
                window.scrollTo({ top, behavior: "smooth" });
              }}
            >
              Send Proposal →
            </button>
            <button
              style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
              onClick={() => submitStatus("archived")}
              disabled={fetcher.state !== "idle"}
            >
              Decline Request
            </button>
          </>
        ) : (
          <>
            {isConfirmed && clientPaid && (
              <button
                style={actionLink}
                onClick={submitMarkDelivered}
                disabled={fetcher.state !== "idle"}
              >
                Mark as Delivered ✓
              </button>
            )}
            {booking.status !== "confirmed" && (
              <button style={actionLink} onClick={() => submitStatus("confirmed")} disabled={fetcher.state !== "idle"}>
                Mark Confirmed
              </button>
            )}
            {booking.status !== "completed" && !(isConfirmed && clientPaid) && (
              <button
                style={{ ...actionLink, borderBottom: booking.status !== "archived" ? undefined : "none" }}
                onClick={() => submitStatus("completed")}
                disabled={fetcher.state !== "idle"}
              >
                Mark Completed
              </button>
            )}
            {booking.status !== "archived" && (
              <button
                style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
                onClick={() => submitStatus("archived")}
                disabled={fetcher.state !== "idle"}
              >
                Archive
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ─── Guest view components ────────────────────────────────────────────────────

function GuestDetailsCard({ b }: { b: Booking }) {
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {(b.service as string) && (
          <div><p style={guestMetaLabel}>Service</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p></div>
        )}
        {(b.venue as string) && (
          <div><p style={guestMetaLabel}>Venue</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue as string}</p></div>
        )}
        {(b.city as string) && (
          <div><p style={guestMetaLabel}>City</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.city as string}</p></div>
        )}
        {(b.address as string) && (
          <div><p style={guestMetaLabel}>Address</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.address as string}</p></div>
        )}
      </div>
      {(b.description as string | null) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{b.description as string}</p>
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: proposal.message ? 18 : 0 }}>
        {proposal.rate != null && (
          <div>
            <p style={guestMetaLabel}>Rate</p>
            <p style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              {proposal.rate} {proposal.currency ?? "EUR"}
            </p>
          </div>
        )}
        <div>
          <p style={guestMetaLabel}>Requirements</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            {[
              proposal.require_travel && "Travel",
              proposal.require_hotel && "Hotel",
              proposal.require_food && "Catering",
            ].filter(Boolean).join(" · ") || "None"}
          </p>
        </div>
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

function GuestActionsCard({ bookingId, bookingToken, status }: { bookingId: string; bookingToken: string | null; status: string }) {
  const fetcher = useFetcher();
  const isPending = fetcher.state !== "idle";
  const currentStatus = (fetcher.data as { ok?: boolean } | undefined)?.ok
    ? fetcher.formData?.get("intent") === "confirm_booking" ? "confirmed" : "requested"
    : status;

  return (
    <div style={card}>
      <p style={{ ...guestMetaLabel, marginBottom: 14 }}>Actions</p>
      {currentStatus === "confirmed" ? (
        <p style={{ color: "#4ade80", fontSize: 14, fontWeight: 600, margin: 0 }}>✓ Booking confirmed</p>
      ) : (
        <fetcher.Form method="post" style={{ display: "flex", gap: 10 }}>
          <input type="hidden" name="bookingToken" value={bookingToken ?? ""} />
          <button
            name="intent" value="confirm_booking"
            disabled={isPending}
            style={{ flex: 1, padding: "12px", background: ACCENT, color: "#111", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
          >
            {isPending ? "…" : "Confirm booking"}
          </button>
          <button
            name="intent" value="decline_booking"
            disabled={isPending}
            style={{ padding: "12px 20px", background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 14, cursor: "pointer", fontFamily: FONT_BODY }}
          >
            Decline
          </button>
        </fetcher.Form>
      )}
    </div>
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

// ─── Member view wrapper ──────────────────────────────────────────────────────

function MemberView({
  booking,
  wallet,
  planLevel,
  userEmail,
}: {
  booking: Booking;
  wallet: WalletData | null;
  planLevel: number;
  userEmail: string;
}) {
  const b = booking;
  const isRequested = b.status === "requested";
  const showPayments = ["pending", "confirmed", "completed"].includes(b.status as string);

  const sections = isRequested
    ? [
        { id: "details",  label: "Details" },
        { id: "proposal", label: "Proposal" },
        { id: "actions",  label: "Actions" },
      ]
    : [
        { id: "details",  label: "Details" },
        ...(showPayments ? [{ id: "payments", label: "Payments" }] : []),
        { id: "actions",  label: "Actions" },
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
  }, [isRequested]); // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 116;
    window.scrollTo({ top, behavior: "smooth" });
  }

  return (
    <>
      {/* Sticky section nav */}
      <div style={{
        position: "sticky",
        top: 56,
        zIndex: 20,
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 0,
        padding: "0 24px",
      }}>
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

      {/* Page header */}
      <div style={{ padding: "28px 24px 8px", textAlign: "center" }}>
        <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.3 }}>
          {(b.title as string) ?? (b.service as string) ?? "Booking"}
        </h1>
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

      {/* Sections */}
      <div style={{ padding: "24px 24px 0", maxWidth: 720, margin: "0 auto" }}>
        <DetailsSection booking={b} />

        {isRequested && <ProposalSection booking={b} planLevel={planLevel} />}

        {!isRequested && showPayments && wallet && (
          <BookingWallet wallet={wallet} />
        )}

        <ActionsSection booking={b} wallet={wallet} />
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;

  // ── Invalid token ──────────────────────────────────────────────────────────
  if (data.accessType === "invalid_token") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <TopBar />
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

  // ── Re-auth ────────────────────────────────────────────────────────────────
  if (data.accessType === "reauth") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <TopBar />
        <ReauthForm bookingId={data.bookingId as string} />
      </div>
    );
  }

  const {
    booking,
    userEmail,
    isOwner,
    accessType,
    role,
    proposal,
    bookingToken,
    wallet,
    planId,
    isBeta,
  } = data as {
    booking: Booking;
    userEmail: string;
    isOwner: boolean;
    accessType: string;
    role: string;
    proposal: Proposal;
    bookingToken: string | null;
    wallet: WalletData | null;
    planId: number | null;
    isBeta: boolean;
  };

  const b = booking;
  const planLevel = getPlanLevel(planId, isBeta);

  // ── Owner / authenticated member — full rich UI ────────────────────────────
  if (isOwner) {
    return (
      <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
        <TopBar />
        <PaymentSuccessBanner />
        <MemberView
          booking={b}
          wallet={wallet}
          planLevel={planLevel}
          userEmail={userEmail}
        />
      </div>
    );
  }

  // ── Guest / participant — tab view ─────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"details" | "proposal" | "actions">("details");

  const tabs =
    role === "buyer"
      ? (["details", "proposal", "actions"] as const)
      : role === "crew"
      ? (["details"] as const)
      : null;

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <TopBar />

      {accessType === "token" && (
        <div style={{ background: "rgba(245,166,35,0.08)", borderBottom: "1px solid rgba(245,166,35,0.2)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>You're viewing this booking as a guest.</p>
          <a href="/join" style={{ color: ACCENT, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Create a SQRZ account →</a>
        </div>
      )}

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px" }}>
        {!b ? (
          <p style={{ color: "var(--text-muted)", textAlign: "center" }}>Booking not found.</p>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <StatusBadge status={(b.status as string) ?? "pending"} />
              </div>
              <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
                {(b.title as string) ?? (b.service as string) ?? "Booking"}
              </h1>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {(b.date_start as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📅 {formatDate(b.date_start as string)}</span>
                )}
                {(b.city as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city as string}{b.venue ? `, ${b.venue}` : ""}</span>
                )}
              </div>
            </div>

            {tabs && (
              <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab as "details" | "proposal" | "actions")}
                    style={{
                      padding: "8px 16px",
                      background: "none",
                      border: "none",
                      borderBottom: activeTab === tab ? `2px solid ${ACCENT}` : "2px solid transparent",
                      color: activeTab === tab ? ACCENT : "var(--text-muted)",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      textTransform: "capitalize",
                      fontFamily: FONT_BODY,
                      marginBottom: -1,
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}

            {(!tabs || activeTab === "details") && <GuestDetailsCard b={b} />}
            {tabs && activeTab === "proposal" && role === "buyer" && <GuestProposalCard proposal={proposal} />}
            {tabs && activeTab === "actions" && role === "buyer" && (
              <GuestActionsCard bookingId={b.id as string} bookingToken={bookingToken} status={b.status as string} />
            )}

            {!tabs && proposal && <GuestProposalCard proposal={proposal} />}
          </>
        )}
      </div>

    </div>
  );
}
