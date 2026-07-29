import { Link, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
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
const OFFICE_BOOKING_NAV_EVENT = "sqrz:office-booking-navigation";

function withOfficeReturn(href: string) {
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}from=office`;
}

function useIsStandalonePwa() {
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const compute = () => {
      const standalone = typeof window !== "undefined" && (
        window.matchMedia?.("(display-mode: standalone)")?.matches ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      );
      setIsStandalone(Boolean(standalone));
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

  return isStandalone;
}

function OfficeBookingLink({
  href,
  children,
  style,
}: {
  href: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const isStandalone = useIsStandalonePwa();
  const finalHref = withOfficeReturn(href);

  return (
    <Link
      to={finalHref}
      target={isStandalone ? undefined : "_blank"}
      rel={isStandalone ? undefined : "noopener noreferrer"}
      onClick={(event) => {
        if (
          !isStandalone ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        ) {
          return;
        }
        window.dispatchEvent(new CustomEvent(OFFICE_BOOKING_NAV_EVENT));
      }}
      style={style}
    >
      {children}
    </Link>
  );
}

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
    <OfficeBookingLink
      href={`/booking/${booking.id}`}
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
    </OfficeBookingLink>
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

  const [openingBooking, setOpeningBooking] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const openBookings = ownerBookings.filter((b) => OPEN_STATUSES.includes(b.status));
  const doneBookings = ownerBookings.filter((b) => DONE_STATUSES.includes(b.status));

  useEffect(() => {
    function handleBookingNavigation() {
      setOpeningBooking(true);
    }

    window.addEventListener(OFFICE_BOOKING_NAV_EVENT, handleBookingNavigation);
    return () => window.removeEventListener(OFFICE_BOOKING_NAV_EVENT, handleBookingNavigation);
  }, []);

  useEffect(() => {
    if (!openingBooking) return;
    const timeout = setTimeout(() => setOpeningBooking(false), 8000);
    return () => clearTimeout(timeout);
  }, [openingBooking]);

  return (
    <div style={{ padding: "28px 24px", fontFamily: FONT_BODY }}>
      {openingBooking && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "radial-gradient(circle at 50% 16%, rgba(245, 166, 35, 0.22), transparent 42%), color-mix(in srgb, var(--bg) 92%, transparent)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              textAlign: "center",
              color: "var(--text)",
            }}
          >
            <img
              src="/sqrz-logo-mark.png"
              alt="SQRZ"
              style={{ width: 88, height: 88, objectFit: "contain", display: "block" }}
            />
            <div style={{ color: "var(--text-muted)", fontSize: 14, fontWeight: 600 }}>
              Opening booking...
            </div>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                border: "3px solid rgba(245,166,35,0.22)",
                borderTopColor: ACCENT,
                animation: "sqrz-pwa-spin 900ms linear infinite",
              }}
            />
          </div>
        </div>
      )}
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
