import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/booking.$id";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import BookingChat from "~/components/BookingChat";

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // Handle PKCE code exchange (magic link redirects here with ?code=)
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  const { data: { user } } = await supabase.auth.getUser();

  // ── Ensure guest is a booking participant (required for RLS) ──
  if (user && code) {
    const { data: existing } = await supabase
      .from("booking_participants")
      .select("id")
      .eq("booking_id", params.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing) {
      await supabase.from("booking_participants").insert({
        booking_id: params.id,
        user_id: user.id,
        email: user.email,
        role: "guest",
        is_admin: false,
      });
    }
  }

  // ── Authenticated path ──
  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("*, booking_requests(*), booking_participants(*)")
      .eq("id", params.id)
      .maybeSingle();

    console.log("[booking] params.id:", params.id);
    console.log("[booking] user.id:", user?.id);
    console.log("[booking] booking:", booking?.id);
    console.log("[booking] error:", bookingError);

    if (!booking) {
      return redirect("/login?reason=no_access", { headers });
    }

    const isOwner = !!(profile && booking.owner_id === profile.id);

    return Response.json(
      {
        booking,
        userId: user.id,
        userEmail: profile?.email ?? user.email ?? "",
        isOwner,
        accessType: "authenticated",
        participant: null,
      },
      { headers }
    );
  }

  // ── Token path ──
  const token = url.searchParams.get("token");
  if (token) {
    const { data: participant } = await supabase
      .from("booking_participants")
      .select("*, bookings(*)")
      .eq("invite_token", token)
      .eq("booking_id", params.id)
      .single();

    if (!participant) {
      return redirect("/login?reason=invalid_token", { headers });
    }

    const booking = (participant as Record<string, unknown>).bookings;

    return Response.json(
      {
        booking,
        userId: null,
        userEmail: participant.email ?? "",
        isOwner: false,
        accessType: "token",
        participant,
      },
      { headers }
    );
  }

  // ── No auth, no token ──
  return redirect(`/guest-login?booking=${params.id}`, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatRate(rate: number | null, currency: string | null): string {
  if (!rate) return "—";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${sym}${rate.toLocaleString()}`;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)", text: "#F5A623" },
  pending:   { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed: { bg: "var(--surface-muted)", text: "var(--text-muted)" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.completed;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 6,
        fontSize: 12,
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const { booking, userId, userEmail, isOwner, accessType } =
    useLoaderData<typeof loader>();

  const b = booking as Record<string, unknown> | null;
  const req = (b?.booking_requests as Record<string, unknown>[] | undefined)?.[0];

  return (
    <div
      style={{
        background: "var(--bg)",
        minHeight: "100vh",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        color: "var(--text)",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 800, letterSpacing: "0.2em" }}>
          [<span style={{ color: "#F5A623" }}> SQRZ </span>]
        </span>
        {accessType === "authenticated" && (
          <a
            href="/"
            style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}
          >
            ← Dashboard
          </a>
        )}
      </div>

      {/* Guest banner */}
      {accessType === "token" && (
        <div
          style={{
            background: "rgba(245,166,35,0.08)",
            borderBottom: "1px solid rgba(245,166,35,0.2)",
            padding: "12px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            You're viewing this booking as a guest.
          </p>
          <a
            href="/join"
            style={{
              color: "#F5A623",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Create a SQRZ account →
          </a>
        </div>
      )}

      {/* Content */}
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px" }}>
        {!b ? (
          <p style={{ color: "var(--text-muted)", textAlign: "center" }}>Booking not found.</p>
        ) : (
          <>
            {/* Header */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <StatusBadge status={(b.status as string) ?? "pending"} />
              </div>
              <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
                {(b.title as string) ?? (b.service as string) ?? "Booking"}
              </h1>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {(b.date_start as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    📅 {formatDate(b.date_start as string)}
                  </span>
                )}
                {(b.city as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                    📍 {b.city as string}{b.venue ? `, ${b.venue}` : ""}
                  </span>
                )}
              </div>
            </div>

            {/* Details card */}
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 16,
                padding: "20px 22px",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                {(b.service as string) && (
                  <div>
                    <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Service</p>
                    <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p>
                  </div>
                )}
                {(b.rate as number) && (
                  <div>
                    <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Rate</p>
                    <p style={{ color: "#F5A623", fontSize: 14, fontWeight: 700, margin: 0 }}>
                      {formatRate(b.rate as number, b.currency as string)}
                    </p>
                  </div>
                )}
                {(b.venue as string) && (
                  <div>
                    <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Venue</p>
                    <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue as string}</p>
                  </div>
                )}
                {(b.city as string) && (
                  <div>
                    <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>City</p>
                    <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.city as string}</p>
                  </div>
                )}
              </div>

              {(req?.message as string | null) && (
                <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Message</p>
                  <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
                    {req?.message as string}
                  </p>
                </div>
              )}
            </div>

          </>
        )}
      </div>

      <BookingChat
        bookingId={(b?.id as string) ?? ""}
        currentUserEmail={userEmail ?? ""}
        isOwner={isOwner ?? false}
      />
    </div>
  );
}
