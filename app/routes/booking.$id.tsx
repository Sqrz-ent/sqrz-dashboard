import { useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/booking.$id";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserClient } from "~/lib/supabase.client";
import BookingChat from "~/components/BookingChat";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // Handle PKCE code exchange (magic link redirects here with ?code=)
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  // ── 1. Token path — checked first ──
  const token = url.searchParams.get("token");
  if (token) {
    const admin = createSupabaseAdminClient();
    const { data: participant } = await admin
      .from("booking_participants")
      .select("id, booking_id, email, role, invite_token, user_id")
      .eq("booking_id", params.id)
      .eq("invite_token", token)
      .limit(1)
      .maybeSingle();

    if (!participant) {
      return Response.json(
        { accessType: "invalid_token" },
        { headers }
      );
    }

    const { data: booking } = await admin
      .from("bookings")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();

    return Response.json(
      {
        booking,
        userId: participant.user_id ?? null,
        userEmail: participant.email ?? "",
        isOwner: false,
        accessType: "token",
        participant,
      },
      { headers }
    );
  }

  // ── 2. Session path ──
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking } = await supabase
      .from("bookings")
      .select("*, booking_participants(*)")
      .eq("id", params.id)
      .maybeSingle();

    if (!booking) {
      return Response.json({ accessType: "invalid_token" }, { headers });
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

  // ── 3. No token, no session → inline re-auth ──
  return Response.json(
    { accessType: "reauth", bookingId: params.id },
    { headers }
  );
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

const FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

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
          emailRedirectTo: `${window.location.origin}/booking/${bookingId}`,
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
    <div style={{ maxWidth: 400, margin: "80px auto", padding: "0 24px", textAlign: "center", fontFamily: FONT }}>
      <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
      <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
        Access this booking
      </h2>
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
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 15,
              boxSizing: "border-box" as const,
              marginBottom: 12,
              fontFamily: FONT,
            }}
          />
          {error && <p style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 10 }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "13px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: FONT,
            }}
          >
            {loading ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;

  // Invalid token
  if (data.accessType === "invalid_token") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", padding: "0 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
          <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
            Invalid or expired link
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            This booking link is no longer valid. Check your email for the correct link.
          </p>
        </div>
      </div>
    );
  }

  // Re-auth required
  if (data.accessType === "reauth") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT }}>
        <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 800, letterSpacing: "0.2em" }}>
            [<span style={{ color: ACCENT }}> SQRZ </span>]
          </span>
        </div>
        <ReauthForm bookingId={data.bookingId as string} />
      </div>
    );
  }

  // Booking view
  const { booking, userId, userEmail, isOwner, accessType } = data as {
    booking: Record<string, unknown> | null;
    userId: string | null;
    userEmail: string;
    isOwner: boolean;
    accessType: string;
  };
  const b = booking;

  return (
    <div
      style={{
        background: "var(--bg)",
        minHeight: "100vh",
        fontFamily: FONT,
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
          [<span style={{ color: ACCENT }}> SQRZ </span>]
        </span>
        {accessType === "authenticated" && (
          <a href="/" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>
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
            style={{ color: ACCENT, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}
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

              {(b.message as string | null) && (
                <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Message</p>
                  <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
                    {b.message as string}
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
