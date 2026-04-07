import { redirect, useLoaderData } from "react-router";
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
  city: string | null;
  venue: string | null;
  myRole: "owner" | "buyer";
};

// ─── Constants ────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: "requested", label: "Requested" },
  { key: "pending",   label: "Pending"   },
  { key: "confirmed", label: "Confirmed" },
  { key: "completed", label: "Completed" },
] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  pending:   { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)",  text: "#4ade80" },
  completed: { bg: "var(--surface-muted)", text: "var(--text-muted)" },
  archived:  { bg: "var(--surface-muted)", text: "var(--text-muted)" },
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  console.log("[office] user.id:", user?.id);
  console.log("[office] profile:", profile?.id, profile?.email);

  const admin = createSupabaseAdminClient();

  const [
    { data: ownerBookings, error: ownerError },
    { data: participantRows },
  ] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, title, service, status, date_start, date_end, city, venue")
      .eq("owner_id", profile.id as string)
      .order("created_at", { ascending: false }),
    admin
      .from("booking_participants")
      .select("bookings(id, title, service, status, date_start, date_end, city, venue)")
      .eq("user_id", user.id)
      .eq("role", "buyer"),
  ]);

  console.log("[office] owner bookings error:", ownerError);
  console.log("[office] owner bookings count:", ownerBookings?.length);
  console.log("[office] profile.id used:", profile.id);

  const ownerSet: Booking[] = (ownerBookings ?? []).map((b) => ({ ...b, myRole: "owner" as const }));

  // Flatten nested booking rows from participant join, skip nulls
  const buyerSet: Booking[] = (participantRows ?? [])
    .map((row) => (row.bookings as unknown) as Booking | null)
    .filter((b): b is Booking => !!b && !["archived"].includes(b.status))
    .map((b) => ({ ...b, myRole: "buyer" as const }));

  // Merge — owner wins on duplicates
  const ownerIds = new Set(ownerSet.map((b) => b.id));
  const merged = [...ownerSet, ...buyerSet.filter((b) => !ownerIds.has(b.id))];

  return Response.json({ bookings: merged, profile }, { headers });
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

    // Send magic link access email to the booking requester
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
      // Non-fatal — booking was accepted; magic link failure logged silently
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

// ─── Role badge ───────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: "owner" | "buyer" }) {
  const isOwner = role === "owner";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 5,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.04em",
        background: isOwner ? "rgba(245,166,35,0.15)" : "rgba(136,136,136,0.15)",
        color: isOwner ? "#F5A623" : "var(--text-muted)",
        textTransform: "uppercase",
      }}
    >
      {isOwner ? "Booked" : "Requested"}
    </span>
  );
}

// ─── Booking card ─────────────────────────────────────────────────────────────

function BookingCard({ booking }: { booking: Booking }) {
  return (
    <a
      href={`/booking/${booking.id}`}
      target="_blank"
      rel="noopener noreferrer"
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
      <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 5px", lineHeight: 1.35 }}>
        {booking.title ?? booking.service ?? "Untitled"}
      </p>
      {booking.city && (
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 5px" }}>
          📍 {booking.city}{booking.venue ? ` · ${booking.venue}` : ""}
        </p>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 10px" }}>
        {formatDate(booking.date_start)}
      </p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <StatusBadge status={booking.status} />
        <RoleBadge role={booking.myRole} />
      </div>
    </a>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { bookings } = useLoaderData<typeof loader>();

  return (
    <div
      style={{
        padding: "28px 24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header */}
      <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
        Office
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 28px" }}>
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
                <p
                  style={{
                    color: "var(--text-muted)",
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
                  <BookingCard key={booking.id} booking={booking} />
                ))
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
