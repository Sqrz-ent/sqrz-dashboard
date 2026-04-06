import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/booking.$id";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserClient } from "~/lib/supabase.client";
import BookingChat from "~/components/BookingChat";

const FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = Record<string, unknown>;
type Participant = { id: string; booking_id: string; email: string | null; role: string; invite_token: string; user_id: string | null };
type Proposal = { id: string; booking_id: string; rate: number | null; currency: string | null; message: string | null; status: string | null; require_hotel: boolean | null; require_travel: boolean | null; require_food: boolean | null } | null;

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // PKCE code exchange — magic link returns here with ?code=
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  // ── 1. TOKEN PATH — always checked first, no auth required ──────────────────
  const token = url.searchParams.get("token");
  if (token) {
    const admin = createSupabaseAdminClient();

    // Single JOIN query using select with nested relation
    const { data: row } = await admin
      .from("booking_participants")
      .select("id, booking_id, email, role, invite_token, user_id, bookings(*)")
      .eq("booking_id", params.id)
      .eq("invite_token", token)
      .limit(1)
      .maybeSingle();

    if (!row) {
      return Response.json({ accessType: "invalid_token" }, { headers });
    }

    const booking = (row as Record<string, unknown>).bookings as Booking;
    const participant: Participant = {
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
      },
      { headers }
    );
  }

  // ── 2. SESSION PATH ──────────────────────────────────────────────────────────
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

    const { data: proposal } = await supabase
      .from("booking_proposals")
      .select("*")
      .eq("booking_id", params.id)
      .maybeSingle();

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : "member",
        userEmail: profile?.email ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        bookingToken: null,
      },
      { headers }
    );
  }

  // ── 3. NO TOKEN, NO SESSION → inline re-auth ─────────────────────────────────
  return Response.json({ accessType: "reauth", bookingId: params.id }, { headers });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bookingToken = formData.get("bookingToken") as string | null;

  if (intent === "confirm_booking" || intent === "decline_booking") {
    // Token-based access: verify participant via admin client
    if (bookingToken) {
      const admin = createSupabaseAdminClient();
      const { data: participant } = await admin
        .from("booking_participants")
        .select("role")
        .eq("booking_id", params.id)
        .eq("invite_token", bookingToken)
        .maybeSingle();

      if (!participant) {
        return Response.json({ error: "Unauthorized" }, { headers, status: 403 });
      }

      const newStatus = intent === "confirm_booking" ? "confirmed" : "requested";
      const { error } = await admin
        .from("bookings")
        .update({ status: newStatus })
        .eq("id", params.id);

      return Response.json({ ok: !error }, { headers });
    }

    // Session-based access
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { headers, status: 401 });

    const newStatus = intent === "confirm_booking" ? "confirmed" : "requested";
    const { error } = await supabase
      .from("bookings")
      .update({ status: newStatus })
      .eq("id", params.id);

    return Response.json({ ok: !error }, { headers });
  }

  return Response.json({ ok: false }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  pending:   { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)",  text: "#4ade80" },
  completed: { bg: "var(--surface-muted)",   text: "var(--text-muted)" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.completed;
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: "20px 22px",
  marginBottom: 20,
};

const metaLabel: React.CSSProperties = {
  color: "var(--text-muted)", fontSize: 11, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function DetailsCard({ b }: { b: Booking }) {
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {(b.service as string) && (
          <div><p style={metaLabel}>Service</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p></div>
        )}
        {(b.venue as string) && (
          <div><p style={metaLabel}>Venue</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue as string}</p></div>
        )}
        {(b.city as string) && (
          <div><p style={metaLabel}>City</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.city as string}</p></div>
        )}
        {(b.address as string) && (
          <div><p style={metaLabel}>Address</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.address as string}</p></div>
        )}
      </div>
      {(b.description as string | null) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={metaLabel}>Message</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{b.description as string}</p>
        </div>
      )}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
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
            <p style={metaLabel}>Rate</p>
            <p style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              {proposal.rate} {proposal.currency ?? "EUR"}
            </p>
          </div>
        )}
        <div>
          <p style={metaLabel}>Requirements</p>
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
          <p style={metaLabel}>Message from artist</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{proposal.message}</p>
        </div>
      )}
    </div>
  );
}

function ActionsCard({ bookingId, bookingToken, status }: { bookingId: string; bookingToken: string | null; status: string }) {
  const fetcher = useFetcher();
  const isPending = fetcher.state !== "idle";
  const currentStatus = (fetcher.data as { ok?: boolean } | undefined)?.ok
    ? fetcher.formData?.get("intent") === "confirm_booking" ? "confirmed" : "requested"
    : status;

  return (
    <div style={card}>
      <p style={{ ...metaLabel, marginBottom: 14 }}>Actions</p>
      {currentStatus === "confirmed" ? (
        <p style={{ color: "#4ade80", fontSize: 14, fontWeight: 600, margin: 0 }}>✓ Booking confirmed</p>
      ) : (
        <fetcher.Form method="post" style={{ display: "flex", gap: 10 }}>
          <input type="hidden" name="bookingToken" value={bookingToken ?? ""} />
          <button
            name="intent" value="confirm_booking"
            disabled={isPending}
            style={{ flex: 1, padding: "12px", background: ACCENT, color: "#111", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}
          >
            {isPending ? "…" : "Confirm booking"}
          </button>
          <button
            name="intent" value="decline_booking"
            disabled={isPending}
            style={{ padding: "12px 20px", background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 14, cursor: "pointer", fontFamily: FONT }}
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
    <div style={{ maxWidth: 400, margin: "80px auto", padding: "0 24px", textAlign: "center", fontFamily: FONT }}>
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
            type="email" placeholder="your@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required
            style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 15, boxSizing: "border-box" as const, marginBottom: 12, fontFamily: FONT }}
          />
          {error && <p style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 10 }}>{error}</p>}
          <button
            type="submit" disabled={loading}
            style={{ width: "100%", padding: "13px", background: ACCENT, color: "#111", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: FONT }}
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
  const [activeTab, setActiveTab] = useState<"details" | "proposal" | "actions">("details");

  // ── Invalid token ────────────────────────────────────────────────────────────
  if (data.accessType === "invalid_token") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", padding: "0 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
          <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Invalid or expired link</h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>This booking link is no longer valid. Check your email for the correct link.</p>
        </div>
      </div>
    );
  }

  // ── Re-auth ──────────────────────────────────────────────────────────────────
  if (data.accessType === "reauth") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT }}>
        <TopBar accessType="reauth" />
        <ReauthForm bookingId={data.bookingId as string} />
      </div>
    );
  }

  // ── Booking view ─────────────────────────────────────────────────────────────
  const { booking, userEmail, isOwner, accessType, role, proposal, bookingToken } = data as {
    booking: Booking | null;
    userEmail: string;
    isOwner: boolean;
    accessType: string;
    role: string;
    proposal: Proposal;
    bookingToken: string | null;
  };
  const b = booking;

  // Tab config by role
  const tabs =
    role === "buyer"
      ? (["details", "proposal", "actions"] as const)
      : role === "crew"
      ? (["details"] as const)
      : null; // owner/member — no tab nav, just show all

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT, color: "var(--text)" }}>
      <TopBar accessType={accessType as string} />

      {/* Guest banner */}
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
            {/* Header */}
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

            {/* Tab nav — buyer and crew only */}
            {tabs && (
              <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
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
                      fontFamily: FONT,
                      marginBottom: -1,
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}

            {/* Content — role-gated */}
            {(!tabs || activeTab === "details") && <DetailsCard b={b} />}

            {tabs && activeTab === "proposal" && role === "buyer" && (
              <ProposalCard proposal={proposal} />
            )}

            {tabs && activeTab === "actions" && role === "buyer" && (
              <ActionsCard bookingId={b.id as string} bookingToken={bookingToken} status={b.status as string} />
            )}

            {/* Owner/member: show all sections without tabs */}
            {!tabs && (
              <>
                {proposal && <ProposalCard proposal={proposal} />}
              </>
            )}
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

function TopBar({ accessType }: { accessType: string }) {
  return (
    <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 800, letterSpacing: "0.2em" }}>
        [<span style={{ color: ACCENT }}> SQRZ </span>]
      </span>
      {accessType === "authenticated" && (
        <a href="/" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Dashboard</a>
      )}
    </div>
  );
}
