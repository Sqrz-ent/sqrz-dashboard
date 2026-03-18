import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.office.$id";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserSupabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRequest = {
  id: string;
  from_profile_id: string | null;
  message: string | null;
  service: string | null;
  budget_min: number | null;
  budget_max: number | null;
  currency: string | null;
  event_date: string | null;
  event_location: string | null;
  status: string | null;
};

type Participant = {
  id: string;
  profile_id: string | null;
  role: string | null;
  pay: number | null;
  pay_status: string | null;
  invite_token: string | null;
};

type Message = {
  id: string;
  profile_id: string | null;
  body: string | null;
  created_at: string;
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
  address: string | null;
  rate: number | null;
  currency: string | null;
  owner_id: string;
  booking_requests: BookingRequest[];
  booking_participants: Participant[];
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers: responseHeaders });

  const { data: booking } = await supabase
    .from("bookings")
    .select(`
      *,
      booking_requests(*),
      booking_participants(*)
    `)
    .eq("id", params.id)
    .eq("owner_id", profile.id as string)
    .single();

  if (!booking) return redirect("/office", { headers: responseHeaders });

  // Fetch channel for chat
  const { data: channel } = await supabase
    .from("channels")
    .select("id")
    .eq("booking_id", params.id)
    .maybeSingle();

  // Fetch initial messages if channel exists
  let messages: Message[] = [];
  if (channel) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, profile_id, body, created_at")
      .eq("channel_id", channel.id)
      .order("created_at", { ascending: true });
    messages = (msgs ?? []) as Message[];
  }

  return Response.json(
    {
      booking,
      profileId: profile.id as string,
      channelId: channel?.id ?? null,
      initialMessages: messages,
    },
    { headers: responseHeaders }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers: responseHeaders });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_status") {
    const status = formData.get("status") as string;
    await supabase
      .from("bookings")
      .update({ status })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: true }, { headers: responseHeaders });
  }

  if (intent === "send_message") {
    const body = (formData.get("body") as string | null)?.trim();
    if (!body) return Response.json({ ok: true }, { headers: responseHeaders });

    let channelId = formData.get("channel_id") as string | null;

    // Create channel if it doesn't exist yet
    if (!channelId) {
      const { data: newChannel } = await supabase
        .from("channels")
        .insert({ booking_id: params.id })
        .select("id")
        .single();
      channelId = newChannel?.id ?? null;
    }

    if (channelId) {
      await supabase.from("messages").insert({
        channel_id: channelId,
        profile_id: profile.id as string,
        body,
      });
    }

    return Response.json({ ok: true, channelId }, { headers: responseHeaders });
  }

  return Response.json({ ok: true }, { headers: responseHeaders });
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

// ─── Design tokens ────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 16,
};

const sectionLabel: React.CSSProperties = {
  color: "rgba(255,255,255,0.3)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

const fieldValue: React.CSSProperties = {
  color: "#fff",
  fontSize: 14,
  margin: 0,
};

const STATUS_OPTS = ["requested", "pending", "confirmed", "completed", "archived"] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)",  text: "#F5A623" },
  pending:   { bg: "rgba(96,165,250,0.12)",  text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)",  text: "#4ade80" },
  completed: { bg: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.4)" },
  archived:  { bg: "rgba(255,255,255,0.04)", text: "rgba(255,255,255,0.25)" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.archived;
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

// ─── Tab: Details ─────────────────────────────────────────────────────────────

function DetailsTab({
  booking,
  profileId,
}: {
  booking: Booking;
  profileId: string;
}) {
  const statusFetcher = useFetcher<{ ok?: boolean }>();
  const req = booking.booking_requests?.[0];

  return (
    <div>
      {/* Status */}
      <div style={card}>
        <p style={sectionLabel}>Status</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <StatusBadge status={booking.status} />
          <statusFetcher.Form method="post" style={{ marginLeft: "auto" }}>
            <input type="hidden" name="intent" value="update_status" />
            <select
              name="status"
              defaultValue={booking.status}
              onChange={(e) =>
                statusFetcher.submit(e.currentTarget.form!, { method: "post" })
              }
              style={{
                background: "#111",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                color: "#fff",
                fontSize: 13,
                padding: "6px 10px",
                cursor: "pointer",
                outline: "none",
              }}
            >
              {STATUS_OPTS.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </statusFetcher.Form>
        </div>
      </div>

      {/* Dates */}
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <p style={sectionLabel}>Start date</p>
            <p style={fieldValue}>{formatDate(booking.date_start)}</p>
          </div>
          {booking.date_end && booking.date_end !== booking.date_start && (
            <div>
              <p style={sectionLabel}>End date</p>
              <p style={fieldValue}>{formatDate(booking.date_end)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Location */}
      {(booking.city || booking.venue || booking.address) && (
        <div style={card}>
          <p style={{ ...sectionLabel, marginBottom: 12 }}>Location</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {booking.venue && (
              <div>
                <p style={sectionLabel}>Venue</p>
                <p style={fieldValue}>{booking.venue}</p>
              </div>
            )}
            {booking.city && (
              <div>
                <p style={sectionLabel}>City</p>
                <p style={fieldValue}>{booking.city}</p>
              </div>
            )}
          </div>
          {booking.address && (
            <div style={{ marginTop: 12 }}>
              <p style={sectionLabel}>Address</p>
              <p style={{ ...fieldValue, color: "rgba(255,255,255,0.7)", fontSize: 13 }}>
                {booking.address}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Rate */}
      {booking.rate && (
        <div style={card}>
          <p style={sectionLabel}>Rate</p>
          <p style={{ ...fieldValue, color: "#F5A623", fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {formatRate(booking.rate, booking.currency)}
          </p>
        </div>
      )}

      {/* Original request */}
      {req && (
        <div style={card}>
          <p style={{ ...sectionLabel, marginBottom: 12 }}>Original request</p>
          {req.service && (
            <div style={{ marginBottom: 12 }}>
              <p style={sectionLabel}>Service</p>
              <p style={fieldValue}>{req.service}</p>
            </div>
          )}
          {(req.budget_min || req.budget_max) && (
            <div style={{ marginBottom: 12 }}>
              <p style={sectionLabel}>Budget</p>
              <p style={fieldValue}>
                {[
                  req.budget_min ? formatRate(req.budget_min, req.currency ?? booking.currency) : null,
                  req.budget_max ? formatRate(req.budget_max, req.currency ?? booking.currency) : null,
                ]
                  .filter(Boolean)
                  .join(" – ")}
              </p>
            </div>
          )}
          {req.message && (
            <div>
              <p style={sectionLabel}>Message</p>
              <p
                style={{
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 13,
                  lineHeight: 1.65,
                  margin: "6px 0 0",
                  background: "#111",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 10,
                  padding: "12px 14px",
                }}
              >
                {req.message}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Team ────────────────────────────────────────────────────────────────

function TeamTab({ participants }: { participants: Participant[] }) {
  const payStatusColor = (s: string | null) =>
    s === "paid" ? "#4ade80" : s === "pending" ? "#F5A623" : "rgba(255,255,255,0.3)";

  return (
    <div>
      {participants.length === 0 ? (
        <div style={{ ...card, textAlign: "center", padding: "36px 24px" }}>
          <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 14, margin: 0 }}>
            No team members yet.
          </p>
        </div>
      ) : (
        participants.map((p) => (
          <div key={p.id} style={{ ...card, display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "rgba(245,166,35,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              👤
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ color: "#fff", fontSize: 13, fontWeight: 600, margin: "0 0 2px" }}>
                {p.role ?? "Team member"}
              </p>
              {p.pay && (
                <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, margin: 0 }}>
                  ${p.pay.toLocaleString()}
                </p>
              )}
            </div>
            {p.pay_status && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: payStatusColor(p.pay_status),
                  textTransform: "capitalize",
                }}
              >
                {p.pay_status}
              </span>
            )}
          </div>
        ))
      )}

      {/* Invite placeholder */}
      <div
        style={{
          border: "1px dashed rgba(255,255,255,0.1)",
          borderRadius: 12,
          padding: "18px",
          textAlign: "center",
        }}
      >
        <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 13, margin: 0 }}>
          Invite team member — coming soon
        </p>
      </div>
    </div>
  );
}

// ─── Tab: Payments ────────────────────────────────────────────────────────────

function PaymentsTab() {
  return (
    <div
      style={{
        ...card,
        textAlign: "center",
        padding: "48px 24px",
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>💳</div>
      <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 14, margin: 0 }}>
        Payments — coming soon
      </p>
    </div>
  );
}

// ─── Tab: Chat ────────────────────────────────────────────────────────────────

function ChatTab({
  channelId: initialChannelId,
  initialMessages,
  profileId,
  bookingId,
}: {
  channelId: string | null;
  initialMessages: Message[];
  profileId: string;
  bookingId: string;
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [channelId, setChannelId] = useState(initialChannelId);
  const fetcher = useFetcher<{ ok?: boolean; channelId?: string }>();
  const formRef = useRef<HTMLFormElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Real-time subscription
  useEffect(() => {
    if (!channelId) return;

    const channel = browserSupabase
      .channel(`messages:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
        }
      )
      .subscribe();

    return () => {
      browserSupabase.removeChannel(channel);
    };
  }, [channelId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset form + capture new channelId after send
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      formRef.current?.reset();
      if (fetcher.data.channelId && !channelId) {
        setChannelId(fetcher.data.channelId);
      }
    }
  }, [fetcher.state, fetcher.data, channelId]);

  const isSending = fetcher.state !== "idle";

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (formRef.current) fetcher.submit(formRef.current);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: 480 }}>
      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 0 8px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {messages.length === 0 ? (
          <p
            style={{
              color: "rgba(255,255,255,0.2)",
              fontSize: 13,
              textAlign: "center",
              margin: "auto",
              padding: "32px 0",
            }}
          >
            No messages yet. Start the conversation.
          </p>
        ) : (
          messages.map((msg) => {
            const isMine = msg.profile_id === profileId;
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  justifyContent: isMine ? "flex-end" : "flex-start",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    maxWidth: "72%",
                    background: isMine ? "#F5A623" : "#1a1a1a",
                    color: isMine ? "#111" : "rgba(255,255,255,0.85)",
                    border: isMine ? "none" : "1px solid rgba(255,255,255,0.07)",
                    borderRadius: isMine ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                    padding: "9px 13px",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  <p style={{ margin: 0 }}>{msg.body}</p>
                  <p
                    style={{
                      fontSize: 10,
                      opacity: 0.55,
                      margin: "4px 0 0",
                      textAlign: isMine ? "right" : "left",
                    }}
                  >
                    {new Date(msg.created_at).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <fetcher.Form
        ref={formRef}
        method="post"
        style={{
          display: "flex",
          gap: 8,
          paddingTop: 12,
          borderTop: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <input type="hidden" name="intent" value="send_message" />
        <input type="hidden" name="channel_id" value={channelId ?? ""} />
        <input type="hidden" name="booking_id" value={bookingId} />
        <textarea
          name="body"
          placeholder="Type a message… (Enter to send)"
          rows={1}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            background: "#111",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10,
            padding: "10px 13px",
            color: "#fff",
            fontSize: 13,
            resize: "none",
            outline: "none",
            lineHeight: 1.5,
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={isSending}
          style={{
            padding: "10px 16px",
            background: "#F5A623",
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            cursor: isSending ? "default" : "pointer",
            opacity: isSending ? 0.6 : 1,
            alignSelf: "flex-end",
          }}
        >
          Send
        </button>
      </fetcher.Form>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = ["Details", "Team", "Payments", "Chat"] as const;
type Tab = (typeof TABS)[number];

export default function BookingDetailPage() {
  const { booking, profileId, channelId, initialMessages } =
    useLoaderData<typeof loader>();
  const [activeTab, setActiveTab] = useState<Tab>("Details");

  const b = booking as unknown as Booking;

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "28px 24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Back link */}
      <Link
        to="/office"
        style={{
          color: "rgba(255,255,255,0.35)",
          fontSize: 13,
          textDecoration: "none",
          display: "inline-block",
          marginBottom: 20,
        }}
      >
        ← Back to pipeline
      </Link>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            color: "#fff",
            fontSize: 22,
            fontWeight: 700,
            margin: "0 0 8px",
            lineHeight: 1.3,
          }}
        >
          {b.title ?? b.service ?? "Booking"}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StatusBadge status={b.status} />
          {b.city && (
            <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13 }}>
              📍 {b.city}
            </span>
          )}
          {b.date_start && (
            <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13 }}>
              {new Date(b.date_start).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 24,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeTab === tab
                ? "2px solid #F5A623"
                : "2px solid transparent",
              color: activeTab === tab ? "#F5A623" : "rgba(255,255,255,0.4)",
              fontSize: 13,
              fontWeight: activeTab === tab ? 700 : 500,
              padding: "10px 16px",
              cursor: "pointer",
              transition: "color 0.15s",
              marginBottom: -1,
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "Details" && (
        <DetailsTab booking={b} profileId={profileId as string} />
      )}
      {activeTab === "Team" && (
        <TeamTab participants={b.booking_participants} />
      )}
      {activeTab === "Payments" && <PaymentsTab />}
      {activeTab === "Chat" && (
        <ChatTab
          channelId={channelId as string | null}
          initialMessages={initialMessages as Message[]}
          profileId={profileId as string}
          bookingId={b.id}
        />
      )}
    </div>
  );
}
