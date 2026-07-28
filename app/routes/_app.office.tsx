import { Link, redirect, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  date_end: string | null;
  venue_address: string | null;
  venue_city: string | null;
  venue_zip: string | null;
  venue_country: string | null;
  buyer_name: string | null;
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
};

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";
const OFFICE_BOOKING_NAV_EVENT = "sqrz:office-booking-navigation";

const COLUMN_EMPTY_TEXT: Record<string, string> = {
  requested: "New booking requests will appear here. Share your profile to get started.",
  pending: "When you send a proposal it lands here, waiting for the client to respond.",
  confirmed: "Accepted proposals move here. This is your active work.",
  completed: "Finished bookings live here. Your track record.",
};

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

function useIsMobileOfficeViewport() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 767px)")
      : null;
    const compute = () => setIsMobile(Boolean(media?.matches));

    compute();
    media?.addEventListener?.("change", compute);

    return () => {
      media?.removeEventListener?.("change", compute);
    };
  }, []);

  return isMobile;
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

  const admin = createSupabaseAdminClient();

  const [
    { data: ownerBookingsRaw },
    { data: participantRows },
  ] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, title, service, status, date_start, date_end, venue_address, venue_city, venue_zip, venue_country, booking_participants(name, role)")
      .eq("owner_id", profile.id as string)
      .order("created_at", { ascending: false }),
    admin
      .from("booking_participants")
      .select("invite_token, bookings(id, title, service, status, date_start, date_end, created_at, owner_id)")
      .eq("user_id", user.id)
      .eq("role", "buyer"),
  ]);

  const ownerBookings: Booking[] = (ownerBookingsRaw ?? []).map((b: any) => {
    const buyer = (b.booking_participants ?? []).find((p: any) => p.role === "buyer");
    return {
      id: b.id,
      title: b.title,
      service: b.service,
      status: b.status,
      date_start: b.date_start,
      date_end: b.date_end,
      venue_address: b.venue_address ?? null,
      venue_city: b.venue_city ?? null,
      venue_zip: b.venue_zip ?? null,
      venue_country: b.venue_country ?? null,
      buyer_name: buyer?.name ?? null,
    };
  });

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
      !!r.booking && !Array.isArray(r.booking) && !["archived", "cancelled"].includes(r.booking.status) && !ownerIdSet.has(r.booking.id)
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
    { ownerBookings, buyerBookings },
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

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = new Date(start);
  if (!end || end === start) {
    return s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const e = new Date(end);
  const startStr = s.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr = e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${startStr} – ${endStr}`;
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
  const venueParts = [booking.venue_city, booking.venue_address, booking.venue_zip, booking.venue_country].filter(Boolean);
  return (
    <OfficeBookingLink
      href={`/booking/${booking.id}`}
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
        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 2px" }}>
          {booking.service}
        </p>
      )}
      {booking.buyer_name && (
        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 5px" }}>
          {booking.buyer_name}
        </p>
      )}
      {venueParts.length > 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 5px" }}>
          📍 {venueParts.join(" · ")}
        </p>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 10px" }}>
        {formatDateRange(booking.date_start, booking.date_end)}
      </p>
      <StatusBadge status={booking.status} />
    </OfficeBookingLink>
  );
}

// ─── My Requests row ──────────────────────────────────────────────────────────

function MyRequestRow({ booking }: { booking: BuyerBooking }) {
  const href = booking.invite_token
    ? `/booking/${booking.id}?token=${booking.invite_token}`
    : `/booking/${booking.id}`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        marginBottom: 8,
      }}
    >
      <OfficeBookingLink
        href={href}
        style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
      >
        <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {booking.title ?? booking.service ?? "Untitled"}
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "2px 0 0" }}>
          {booking.owner_name}
        </p>
      </OfficeBookingLink>
      <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
        {formatDate(booking.date_start)}
      </span>
      <StatusBadge status={booking.status} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { ownerBookings, buyerBookings } = useLoaderData<typeof loader>() as {
    ownerBookings: Booking[];
    buyerBookings: BuyerBooking[];
  };

  const [openingBooking, setOpeningBooking] = useState(false);
  const isMobileOfficeViewport = useIsMobileOfficeViewport();

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
    <div style={{ padding: isMobileOfficeViewport ? "28px 0" : "28px 24px", fontFamily: FONT_BODY }}>
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
      <div style={{ marginBottom: 28, padding: isMobileOfficeViewport ? "0 24px" : 0 }}>
        <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          Office
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
          Your booking pipeline
        </p>
      </div>

      {/* ─── SECTION 1: My Bookings (kanban) ─────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: 14,
          overflowX: "auto",
          padding: isMobileOfficeViewport ? "0 16px 16px" : "0 0 16px",
          alignItems: "flex-start",
          width: "100%",
          WebkitOverflowScrolling: "touch",
          scrollPaddingInline: isMobileOfficeViewport ? 16 : 0,
        }}
      >
        {COLUMNS.map((col) => {
          const colBookings = ownerBookings.filter((b) => b.status === col.key);
          return (
            <div
              key={col.key}
              style={{
                minWidth: 200,
                flex: "1 1 0",
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
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px dashed var(--border)",
                    borderRadius: 10,
                    padding: "12px 14px",
                  }}
                >
                  <p
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 12,
                      margin: 0,
                      lineHeight: 1.55,
                    }}
                  >
                    {COLUMN_EMPTY_TEXT[col.key]}
                  </p>
                </div>
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
    </div>
  );
}
