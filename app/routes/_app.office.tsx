import { useEffect } from "react";
import { redirect, useLoaderData, useSearchParams, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRequest = {
  from_profile_id: string | null;
  message: string | null;
  service: string | null;
  budget_min: number | null;
  budget_max: number | null;
};

type Booking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  date_end: string | null;
  city: string | null;
  venue: string | null;
  rate: number | null;
  currency: string | null;
  booking_requests: BookingRequest[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: "requested", label: "Requested", accent: "#F5A623" },
  { key: "pending",   label: "Pending",   accent: "#60a5fa" },
  { key: "confirmed", label: "Confirmed", accent: "#4ade80" },
  { key: "completed", label: "Completed", accent: "rgba(255,255,255,0.35)" },
] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  pending:   { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)",  text: "#4ade80" },
  completed: { bg: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.4)" },
  archived:  { bg: "rgba(255,255,255,0.04)", text: "rgba(255,255,255,0.25)" },
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return redirect("/login", { headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, session.user.id);
  if (!profile) return redirect("/login", { headers: responseHeaders });

  const { data: bookings } = await supabase
    .from("bookings")
    .select(`
      id, title, service, status, date_start, date_end,
      city, venue, rate, currency,
      booking_requests(from_profile_id, message, service, budget_min, budget_max)
    `)
    .eq("owner_id", profile.id as string)
    .order("created_at", { ascending: false });

  return Response.json({ bookings: bookings ?? [] }, { headers: responseHeaders });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401, headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, session.user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers: responseHeaders });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const bookingId = formData.get("booking_id") as string;

  if (intent === "accept") {
    await supabase
      .from("bookings")
      .update({ status: "pending" })
      .eq("id", bookingId)
      .eq("owner_id", profile.id as string);
  } else if (intent === "decline") {
    await supabase
      .from("bookings")
      .update({ status: "archived" })
      .eq("id", bookingId)
      .eq("owner_id", profile.id as string);
  }

  return Response.json({ ok: true }, { headers: responseHeaders });
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

function formatRate(rate: number | null, currency: string | null): string {
  if (!rate) return "—";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${sym}${rate.toLocaleString()}`;
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

// ─── Booking card ─────────────────────────────────────────────────────────────

function BookingCard({ booking, onClick }: { booking: Booking; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        background: "#1a1a1a",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        padding: "12px 14px",
        textAlign: "left",
        cursor: "pointer",
        marginBottom: 8,
        display: "block",
      }}
    >
      <p style={{ color: "#fff", fontSize: 13, fontWeight: 600, margin: "0 0 5px", lineHeight: 1.35 }}>
        {booking.title ?? booking.service ?? "Untitled"}
      </p>
      {booking.city && (
        <p style={{ color: "rgba(255,255,255,0.38)", fontSize: 12, margin: "0 0 5px" }}>
          📍 {booking.city}{booking.venue ? ` · ${booking.venue}` : ""}
        </p>
      )}
      <p style={{ color: "rgba(255,255,255,0.28)", fontSize: 11, margin: "0 0 10px" }}>
        {formatDate(booking.date_start)}
      </p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#F5A623", fontSize: 12, fontWeight: 600 }}>
          {formatRate(booking.rate, booking.currency)}
        </span>
      </div>
    </button>
  );
}

// ─── Shared label/value styles ────────────────────────────────────────────────

const metaLabel: React.CSSProperties = {
  color: "rgba(255,255,255,0.3)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 4px",
};

const metaValue: React.CSSProperties = {
  color: "#fff",
  fontSize: 13,
  margin: 0,
};

// ─── Preview modal ────────────────────────────────────────────────────────────

function BookingModal({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const fetcher = useFetcher<{ ok?: boolean }>();

  // Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close after successful accept/decline
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose]);

  const req = booking.booking_requests?.[0];
  const busy = fetcher.state !== "idle";

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.65)",
          zIndex: 40,
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
        }}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(540px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 64px)",
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 18,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          animation: "modalIn 0.18s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 22px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h2 style={{ color: "#fff", fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>
              {booking.title ?? booking.service ?? "Booking"}
            </h2>
            <StatusBadge status={booking.status} />
          </div>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.07)",
              border: "none",
              color: "rgba(255,255,255,0.6)",
              width: 28,
              height: 28,
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 18,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
            <div>
              <p style={metaLabel}>Date</p>
              <p style={metaValue}>{formatDate(booking.date_start)}</p>
            </div>
            {booking.city && (
              <div>
                <p style={metaLabel}>Location</p>
                <p style={metaValue}>
                  {booking.city}{booking.venue ? `, ${booking.venue}` : ""}
                </p>
              </div>
            )}
            {booking.rate && (
              <div>
                <p style={metaLabel}>Rate</p>
                <p style={{ ...metaValue, color: "#F5A623", fontWeight: 600 }}>
                  {formatRate(booking.rate, booking.currency)}
                </p>
              </div>
            )}
            {req && (req.budget_min || req.budget_max) && (
              <div>
                <p style={metaLabel}>Budget</p>
                <p style={metaValue}>
                  {[
                    req.budget_min ? formatRate(req.budget_min, booking.currency) : null,
                    req.budget_max ? formatRate(req.budget_max, booking.currency) : null,
                  ]
                    .filter(Boolean)
                    .join(" – ")}
                </p>
              </div>
            )}
          </div>

          {req?.message && (
            <div style={{ marginBottom: 18 }}>
              <p style={metaLabel}>Request message</p>
              <p
                style={{
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  margin: 0,
                  background: "#111",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: 10,
                  padding: "12px 14px",
                }}
              >
                {req.message}
              </p>
            </div>
          )}

          <Link
            to={`/office/${booking.id}`}
            style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, textDecoration: "none" }}
          >
            Open full page →
          </Link>
        </div>

        {/* Footer — accept/decline only for requested */}
        {booking.status === "requested" && (
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1px solid rgba(255,255,255,0.07)",
              display: "flex",
              gap: 10,
            }}
          >
            <fetcher.Form method="post" style={{ flex: 1 }}>
              <input type="hidden" name="intent" value="accept" />
              <input type="hidden" name="booking_id" value={booking.id} />
              <button
                type="submit"
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "11px",
                  background: "#F5A623",
                  color: "#111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                Accept
              </button>
            </fetcher.Form>
            <fetcher.Form method="post" style={{ flex: 1 }}>
              <input type="hidden" name="intent" value="decline" />
              <input type="hidden" name="booking_id" value={booking.id} />
              <button
                type="submit"
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "11px",
                  background: "rgba(255,255,255,0.07)",
                  color: busy ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.7)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                Decline
              </button>
            </fetcher.Form>
          </div>
        )}
      </div>

      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
      `}</style>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { bookings } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeBookingId = searchParams.get("booking");
  const activeBooking = activeBookingId
    ? (bookings as Booking[]).find((b) => b.id === activeBookingId) ?? null
    : null;

  function openBooking(id: string) {
    setSearchParams({ booking: id }, { preventScrollReset: true });
  }

  function closeModal() {
    setSearchParams({}, { preventScrollReset: true });
  }

  return (
    <div
      style={{
        padding: "28px 24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header */}
      <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
        Office
      </h1>
      <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 14, margin: "0 0 28px" }}>
        Your booking pipeline
      </p>

      {/* Kanban board */}
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
          const colBookings = (bookings as Booking[]).filter((b) => b.status === col.key);
          return (
            <div
              key={col.key}
              style={{
                minWidth: 232,
                flex: "0 0 232px",
                background: "#161616",
                border: "1px solid rgba(255,255,255,0.06)",
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
                    color: col.accent,
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
                      background: col.accent,
                      color: col.key === "completed" ? "rgba(255,255,255,0.6)" : "#111",
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
                    color: "rgba(255,255,255,0.12)",
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
                  <BookingCard
                    key={booking.id}
                    booking={booking}
                    onClick={() => openBooking(booking.id)}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>

      {/* Preview modal */}
      {activeBooking && (
        <BookingModal booking={activeBooking} onClose={closeModal} />
      )}
    </div>
  );
}
