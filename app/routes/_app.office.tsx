import { redirect, useLoaderData } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { StreamChat } from "stream-chat";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import {
  isStreamConfigured,
  listBookingChatSummariesForStreamUser,
  toStreamUserIdForProfile,
  type BookingChatSummary,
} from "~/lib/messaging/stream.server";

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
  chat_summary?: BookingChatSummary | null;
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
  chat_summary?: BookingChatSummary | null;
};

type Service = {
  id: string;
  title: string;
  booking_type: string;
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
  pending_payment: { bg: "rgba(251,191,36,0.12)",  text: "#fbbf24" },
};

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

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
    <a
      href={finalHref}
      target={isStandalone ? undefined : "_blank"}
      rel={isStandalone ? undefined : "noopener noreferrer"}
      style={style}
    >
      {children}
    </a>
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
    { data: services },
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
    admin
      .from("profile_services")
      .select("id, title, booking_type")
      .eq("profile_id", profile.id as string)
      .eq("is_active", true)
      .order("sort_order"),
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
      chat_summary: null,
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
        [p.first_name, p.last_name].filter(Boolean).join(" ") ||
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
      chat_summary: null,
    }))
    .sort((a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    );

  if (isStreamConfigured()) {
    const allBookingIds = [...new Set([...ownerBookings, ...buyerBookings].map((booking) => booking.id))];
    if (allBookingIds.length > 0) {
      try {
        const chatSummaries = await listBookingChatSummariesForStreamUser({
          streamUserId: toStreamUserIdForProfile(profile.id as string),
          bookingIds: allBookingIds,
        });

        for (const booking of ownerBookings) {
          booking.chat_summary = chatSummaries[booking.id] ?? null;
        }
        for (const booking of buyerBookings) {
          booking.chat_summary = chatSummaries[booking.id] ?? null;
        }
      } catch {
        // Non-fatal: Office still renders even if chat summaries are unavailable.
      }
    }
  }

  return Response.json(
    { ownerBookings, buyerBookings, services: services ?? [], planId: profile.plan_id ?? null },
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

function formatTime(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function bookingUrgencyValue(booking: Booking | BuyerBooking) {
  const unreadCount = Number(booking.chat_summary?.unreadCount ?? 0);
  const lastMessageAt = booking.chat_summary?.lastMessageAt
    ? new Date(booking.chat_summary.lastMessageAt).getTime()
    : 0;
  const createdAt = "created_at" in booking && booking.created_at
    ? new Date(booking.created_at).getTime()
    : 0;

  return {
    unreadCount,
    lastActivityAt: lastMessageAt || createdAt || 0,
  };
}

function sortBookingsByUrgency<T extends Booking | BuyerBooking>(bookings: T[]) {
  return [...bookings].sort((a, b) => {
    const aUrgency = bookingUrgencyValue(a);
    const bUrgency = bookingUrgencyValue(b);

    if (aUrgency.unreadCount !== bUrgency.unreadCount) {
      return bUrgency.unreadCount - aUrgency.unreadCount;
    }

    if (aUrgency.lastActivityAt !== bUrgency.lastActivityAt) {
      return bUrgency.lastActivityAt - aUrgency.lastActivityAt;
    }

    return 0;
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

// ─── Booking card (My Bookings kanban) ────────────────────────────────────────

function BookingCard({ booking }: { booking: Booking }) {
  const venueParts = [booking.venue_city, booking.venue_address, booking.venue_zip, booking.venue_country].filter(Boolean);
  const unreadCount = Number(booking.chat_summary?.unreadCount ?? 0);
  const lastReadLabel = formatTime(booking.chat_summary?.lastReadAt ?? null);
  return (
    <OfficeBookingLink
      href={`/booking/${booking.id}`}
      style={{
        display: "block",
        width: "100%",
        background: "var(--surface)",
        border: unreadCount > 0 ? "1px solid rgba(245,166,35,0.42)" : "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
        textDecoration: "none",
        marginBottom: 8,
        cursor: "pointer",
        boxShadow: unreadCount > 0 ? "0 0 0 1px rgba(245,166,35,0.08), 0 12px 28px rgba(245,166,35,0.08)" : "none",
      }}
    >
      {unreadCount > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
            padding: "7px 9px",
            borderRadius: 8,
            background: "rgba(245,166,35,0.08)",
            color: ACCENT,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.01em" }}>
            {unreadCount} new {unreadCount === 1 ? "message" : "messages"}
          </span>
          {lastReadLabel && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>
              Last read {lastReadLabel}
            </span>
          )}
        </div>
      )}
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

  const isPendingPayment = booking.status === "pending_payment";
  const unreadCount = Number(booking.chat_summary?.unreadCount ?? 0);
  const lastReadLabel = formatTime(booking.chat_summary?.lastReadAt ?? null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        background: "var(--surface)",
        border: unreadCount > 0
          ? "1px solid rgba(245,166,35,0.42)"
          : isPendingPayment
            ? "1px solid rgba(251,191,36,0.3)"
            : "1px solid var(--border)",
        borderRadius: 10,
        marginBottom: 8,
      }}
    >
      <OfficeBookingLink
        href={href}
        style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
      >
        {unreadCount > 0 && (
          <p style={{ color: ACCENT, fontSize: 11, fontWeight: 800, margin: "0 0 4px" }}>
            {unreadCount} new {unreadCount === 1 ? "message" : "messages"}
            {lastReadLabel ? ` · Last read ${lastReadLabel}` : ""}
          </p>
        )}
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
      {isPendingPayment ? (
        <OfficeBookingLink
          href={href}
          style={{
            flexShrink: 0,
            padding: "5px 12px",
            borderRadius: 20,
            border: "none",
            background: "#fbbf24",
            color: "#000",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Complete Payment
        </OfficeBookingLink>
      ) : (
        <StatusBadge status={booking.status} />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { ownerBookings, buyerBookings, planId } = useLoaderData<typeof loader>() as {
    ownerBookings: Booking[];
    buyerBookings: BuyerBooking[];
    planId: number | null;
  };

  // Local copy of owner bookings — patched in real-time by Stream events for paid users.
  // For free users this simply mirrors the loader data and stays static.
  const [streamOwnerBookings, setStreamOwnerBookings] = useState<Booking[]>(ownerBookings);

  // Keep in sync if loader data ever refreshes (e.g. after window.location.reload()).
  useEffect(() => {
    setStreamOwnerBookings(ownerBookings);
  }, [ownerBookings]);

  const sortedOwnerBookings = useMemo(
    () => sortBookingsByUrgency(streamOwnerBookings),
    [streamOwnerBookings]
  );
  const sortedBuyerBookings = useMemo(
    () => sortBookingsByUrgency(buyerBookings),
    [buyerBookings]
  );

  // Stream subscription for paid users — event-driven chat_summary updates, no polling.
  const streamClientRef = useRef<StreamChat | null>(null);
  useEffect(() => {
    const isPaid = planId != null && planId >= 1;
    if (!isPaid) return;

    let active = true;
    const unsubs: Array<() => void> = [];

    async function initStream() {
      let apiKey: string;
      let token: string;
      let streamUserId: string;
      try {
        const res = await fetch("/api/messaging/stream-token");
        if (!res.ok) return;
        const data = await res.json() as {
          apiKey?: string;
          token?: string;
          streamUser?: { id: string };
        };
        if (!data.apiKey || !data.token || !data.streamUser?.id) return;
        apiKey = data.apiKey;
        token = data.token;
        streamUserId = data.streamUser.id;
      } catch {
        return;
      }

      if (!active) return;

      const client = StreamChat.getInstance(apiKey);
      if (client.userID && client.userID !== streamUserId) {
        await client.disconnectUser().catch(() => {});
      }
      if (!client.userID) {
        try {
          await client.connectUser({ id: streamUserId }, token);
        } catch {
          return;
        }
      }

      if (!active) return;
      streamClientRef.current = client;

      function handleMessageEvent(event: Record<string, any>) {
        if (!active) return;
        // Skip messages sent by this user
        if ((event.user?.id as string | undefined) === streamUserId) return;

        const channelId: string = event.channel_id ?? "";
        const bookingIdMatch = channelId.match(/^booking_(.+)_main$/);
        const bookingId = bookingIdMatch?.[1] ?? null;
        if (!bookingId) return;

        const messageAt: string =
          (event.message as any)?.created_at ?? new Date().toISOString();

        setStreamOwnerBookings((prev) =>
          prev.map((b) =>
            b.id === bookingId
              ? {
                  ...b,
                  chat_summary: {
                    bookingId,
                    unreadCount: (b.chat_summary?.unreadCount ?? 0) + 1,
                    lastMessageAt: messageAt,
                    lastReadAt: b.chat_summary?.lastReadAt ?? null,
                  },
                }
              : b
          )
        );
      }

      // notification.message_new — fires for channels the client is not currently watching
      const sub1 = client.on("notification.message_new", handleMessageEvent);
      unsubs.push(() => sub1.unsubscribe());

      // message.new — fires for channels actively watched (e.g. if chat panel is also open)
      const sub2 = client.on("message.new", handleMessageEvent);
      unsubs.push(() => sub2.unsubscribe());
    }

    initStream();

    return () => {
      active = false;
      for (const unsub of unsubs) unsub();
      if (streamClientRef.current) {
        streamClientRef.current.disconnectUser().catch(() => {});
        streamClientRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

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

      {/* ─── SECTION 1: My Bookings (kanban) ─────────────────────────────────── */}
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
          const colBookings = sortedOwnerBookings.filter((b) => b.status === col.key);
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
            {sortedBuyerBookings.map((booking) => (
              <MyRequestRow key={booking.id} booking={booking} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
