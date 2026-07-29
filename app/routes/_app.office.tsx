import { Link, useLoaderData } from "react-router";
import { useState } from "react";
import { redirect } from "react-router";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  venue_city: string | null;
  created_at: string | null;
  buyer_name: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_STATUSES = ["requested", "pending", "confirmed"];
const DONE_STATUSES = ["completed", "declined"];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested:  { bg: "rgba(245,166,35,0.12)", text: "#F5A623" },
  pending:    { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed:  { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed:  { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  declined:   { bg: "rgba(239,68,68,0.12)",  text: "#ef4444" },
};

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: ownerBookingsRaw } = await supabase
    .from("bookings")
    .select("id, title, service, status, venue_city, created_at, booking_participants(name, role)")
    .eq("owner_id", profile.id as string)
    .order("created_at", { ascending: false });

  const ownerBookings: Booking[] = (ownerBookingsRaw ?? []).map((b: any) => {
    const buyer = (b.booking_participants ?? []).find((p: any) => p.role === "buyer");
    return {
      id: b.id,
      title: b.title,
      service: b.service,
      status: b.status,
      venue_city: b.venue_city ?? null,
      created_at: b.created_at,
      buyer_name: buyer?.name ?? null,
    };
  });

  return Response.json(
    { ownerBookings },
    { headers }
  );
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
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.completed;
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

// ─── Booking row (flat OPEN/DONE list) ────────────────────────────────────────

function BookingRow({ booking, muted }: { booking: Booking; muted: boolean }) {
  return (
    <Link
      to={`/booking/${booking.id}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        textDecoration: "none",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          color: muted ? "var(--text-muted)" : "var(--text)",
          fontSize: 14,
          fontWeight: 600,
          margin: "0 0 3px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {booking.title ?? booking.service ?? "Untitled"}
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {[booking.service, booking.buyer_name, booking.venue_city].filter(Boolean).join(" · ")}
        </p>
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
        {formatDate(booking.created_at)}
      </span>
      <StatusBadge status={booking.status} />
    </Link>
  );
}

function BookingList({ bookings, muted }: { bookings: Booking[]; muted: boolean }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      {bookings.map((booking, i) => (
        <div key={booking.id}>
          <BookingRow booking={booking} muted={muted} />
          {i !== bookings.length - 1 && <div style={{ borderTop: "1px solid var(--border)" }} />}
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { ownerBookings } = useLoaderData<typeof loader>() as {
    ownerBookings: Booking[];
  };

  const [showCompleted, setShowCompleted] = useState(false);

  const openBookings = ownerBookings.filter((b) => OPEN_STATUSES.includes(b.status));
  const doneBookings = ownerBookings.filter((b) => DONE_STATUSES.includes(b.status));

  return (
    <div style={{ padding: "28px 24px", fontFamily: FONT_BODY }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          Office
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
          Your booking pipeline
        </p>
      </div>

      {/* ─── My Bookings (OPEN / DONE) — incoming bookings, owner/artist only ── */}
      <div style={{ maxWidth: 720 }}>
        <div style={{ marginBottom: 10 }}>
          <span style={{ color: "var(--text)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Open
          </span>
        </div>

        {openBookings.length === 0 ? (
          <div style={{ background: "var(--surface-muted)", border: "1px dashed var(--border)", borderRadius: 12, padding: "20px 16px" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55 }}>
              New booking requests will appear here. Share your profile to get started.
            </p>
          </div>
        ) : (
          <BookingList bookings={openBookings} muted={false} />
        )}

        {doneBookings.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => setShowCompleted((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "none",
                border: "none",
                padding: "0 0 10px",
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Done
              </span>
              <span style={{ color: ACCENT, fontSize: 12, fontWeight: 700 }}>
                {showCompleted ? "Hide" : `Show ${doneBookings.length} completed`}
              </span>
            </button>
            {showCompleted && <BookingList bookings={doneBookings} muted={true} />}
          </div>
        )}
      </div>
    </div>
  );
}
