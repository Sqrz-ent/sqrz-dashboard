import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/booking.$id";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserSupabase } from "~/lib/supabase.client";
import BookingChat from "~/components/BookingChat";

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = {
  id: string;
  profile_id: string | null;
  body: string | null;
  created_at: string;
};

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

    const { data: channel } = await supabase
      .from("channels")
      .select("id")
      .eq("booking_id", params.id)
      .maybeSingle();

    let messages: Message[] = [];
    if (channel) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("id, message, sender_name, sender_id, created_at")
        .eq("channel_id", channel.id)
        .order("created_at", { ascending: true });
      messages = (msgs ?? []) as Message[];
    }

    return Response.json(
      {
        booking,
        userId: user.id,
        userEmail: profile?.email ?? user.email ?? "",
        isOwner,
        channelId: channel?.id ?? null,
        initialMessages: messages,
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

    const { data: channel } = await supabase
      .from("channels")
      .select("id")
      .eq("booking_id", params.id)
      .maybeSingle();

    let messages: Message[] = [];
    if (channel) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("id, message, sender_name, sender_id, created_at")
        .eq("channel_id", channel.id)
        .order("created_at", { ascending: true });
      messages = (msgs ?? []) as Message[];
    }

    return Response.json(
      {
        booking,
        userId: null,
        userEmail: participant.email ?? "",
        isOwner: false,
        channelId: channel?.id ?? null,
        initialMessages: messages,
        accessType: "token",
        participant,
      },
      { headers }
    );
  }

  // ── No auth, no token ──
  return redirect(`/guest-login?booking=${params.id}`, { headers });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "send_message") {
    const body = (formData.get("body") as string | null)?.trim();
    if (!body) return Response.json({ ok: true }, { headers });

    let channelId = formData.get("channel_id") as string | null;

    if (!channelId) {
      const { data: newChannel } = await supabase
        .from("channels")
        .insert({ booking_id: params.id })
        .select("id")
        .single();
      channelId = newChannel?.id ?? null;
    }

    if (channelId) {
      // Resolve profile.id from user.id
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      await supabase.from("messages").insert({
        channel_id: channelId,
        profile_id: (profile as Record<string, unknown> | null)?.id ?? null,
        body,
      });
    }

    return Response.json({ ok: true, channelId }, { headers });
  }

  return Response.json({ ok: true }, { headers });
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
  completed: { bg: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.4)" },
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

// ─── Chat ─────────────────────────────────────────────────────────────────────

function ChatSection({
  channelId: initialChannelId,
  initialMessages,
  userId,
  bookingId,
}: {
  channelId: string | null;
  initialMessages: Message[];
  userId: string | null;
  bookingId: string;
}) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [channelId, setChannelId] = useState(initialChannelId);
  const fetcher = useFetcher<{ ok?: boolean; channelId?: string }>();
  const formRef = useRef<HTMLFormElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!channelId) return;
    const channel = browserSupabase
      .channel(`booking-chat:${channelId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `channel_id=eq.${channelId}` },
        (payload) => setMessages((prev) => [...prev, payload.new as Message])
      )
      .subscribe();
    return () => { browserSupabase.removeChannel(channel); };
  }, [channelId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      formRef.current?.reset();
      if (fetcher.data.channelId && !channelId) setChannelId(fetcher.data.channelId);
    }
  }, [fetcher.state, fetcher.data, channelId]);

  const isSending = fetcher.state !== "idle";

  return (
    <div
      style={{
        background: "#161616",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 16,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <p
          style={{
            color: "rgba(255,255,255,0.3)",
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            margin: 0,
          }}
        >
          Chat
        </p>
      </div>

      {/* Messages */}
      <div style={{ height: 320, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column" }}>
        {messages.length === 0 ? (
          <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 13, textAlign: "center", margin: "auto" }}>
            No messages yet.
          </p>
        ) : (
          messages.map((msg) => {
            const isMine = userId && msg.profile_id === userId;
            return (
              <div
                key={msg.id}
                style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start", marginBottom: 10 }}
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
                  <p style={{ fontSize: 10, opacity: 0.55, margin: "4px 0 0", textAlign: isMine ? "right" : "left" }}>
                    {new Date(msg.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        {userId ? (
          <fetcher.Form ref={formRef} method="post" style={{ display: "flex", gap: 8 }}>
            <input type="hidden" name="intent" value="send_message" />
            <input type="hidden" name="channel_id" value={channelId ?? ""} />
            <input type="hidden" name="booking_id" value={bookingId} />
            <input
              name="body"
              placeholder="Type a message…"
              autoComplete="off"
              style={{
                flex: 1,
                background: "#111",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: "10px 13px",
                color: "#fff",
                fontSize: 13,
                outline: "none",
                fontFamily: "inherit",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (formRef.current) fetcher.submit(formRef.current);
                }
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
              }}
            >
              Send
            </button>
          </fetcher.Form>
        ) : (
          <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, margin: 0, textAlign: "center" }}>
            <a href={`/guest-login?booking=${bookingId}`} style={{ color: "#F5A623", textDecoration: "none" }}>
              Sign in
            </a>
            {" "}to reply
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const { booking, userId, userEmail, isOwner, channelId, initialMessages, accessType } =
    useLoaderData<typeof loader>();

  const b = booking as Record<string, unknown> | null;
  const req = (b?.booking_requests as Record<string, unknown>[] | undefined)?.[0];

  return (
    <div
      style={{
        background: "#111111",
        minHeight: "100vh",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        color: "#e5e7eb",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ color: "#ffffff", fontSize: 15, fontWeight: 800, letterSpacing: "0.2em" }}>
          [<span style={{ color: "#F5A623" }}> SQRZ </span>]
        </span>
        {accessType === "authenticated" && (
          <a
            href="/"
            style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, textDecoration: "none" }}
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
          <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, margin: 0 }}>
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
          <p style={{ color: "rgba(255,255,255,0.4)", textAlign: "center" }}>Booking not found.</p>
        ) : (
          <>
            {/* Header */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <StatusBadge status={(b.status as string) ?? "pending"} />
              </div>
              <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>
                {(b.title as string) ?? (b.service as string) ?? "Booking"}
              </h1>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {(b.date_start as string) && (
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
                    📅 {formatDate(b.date_start as string)}
                  </span>
                )}
                {(b.city as string) && (
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
                    📍 {b.city as string}{b.venue ? `, ${b.venue}` : ""}
                  </span>
                )}
              </div>
            </div>

            {/* Details card */}
            <div
              style={{
                background: "#1a1a1a",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 16,
                padding: "20px 22px",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                {(b.service as string) && (
                  <div>
                    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Service</p>
                    <p style={{ color: "#fff", fontSize: 14, margin: 0 }}>{b.service as string}</p>
                  </div>
                )}
                {(b.rate as number) && (
                  <div>
                    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Rate</p>
                    <p style={{ color: "#F5A623", fontSize: 14, fontWeight: 700, margin: 0 }}>
                      {formatRate(b.rate as number, b.currency as string)}
                    </p>
                  </div>
                )}
                {(b.venue as string) && (
                  <div>
                    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>Venue</p>
                    <p style={{ color: "#fff", fontSize: 14, margin: 0 }}>{b.venue as string}</p>
                  </div>
                )}
                {(b.city as string) && (
                  <div>
                    <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px" }}>City</p>
                    <p style={{ color: "#fff", fontSize: 14, margin: 0 }}>{b.city as string}</p>
                  </div>
                )}
              </div>

              {(req?.message as string | null) && (
                <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 8px" }}>Message</p>
                  <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
                    {req?.message as string}
                  </p>
                </div>
              )}
            </div>

            {/* Chat */}
            <ChatSection
              channelId={channelId as string | null}
              initialMessages={initialMessages as Message[]}
              userId={userId as string | null}
              bookingId={b.id as string}
            />
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
