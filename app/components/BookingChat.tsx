// Intercom-style floating chat bubble, bottom-right corner
// Props: bookingId, currentUserEmail, isOwner

import { useEffect, useRef, useState } from "react";
import { supabase } from "~/lib/supabase.client";

interface Channel {
  id: string;
  name: string | null;
  booking_id: string;
}

interface Message {
  id: string;
  channel_id: string;
  sender_id: string | null;
  sender_name: string | null;
  message: string | null;
  created_at: string;
}

interface BookingChatProps {
  bookingId: string;
  currentUserEmail: string;
  isOwner: boolean;
}

export default function BookingChat({
  bookingId,
  currentUserEmail,
  isOwner,
}: BookingChatProps) {
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Step 1: fetch channels on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!bookingId) return;

    supabase
      .from("channels")
      .select("*")
      .eq("booking_id", bookingId)
      .then(({ data }) => {
        const rows = (data ?? []) as Channel[];
        setChannels(rows);
        if (rows.length > 0 && !activeChannelId) {
          setActiveChannelId(rows[0].id);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  // ── Step 2: fetch messages + subscribe on activeChannelId change ─────────────
  useEffect(() => {
    if (!activeChannelId) return;

    // Fetch initial messages
    supabase
      .from("messages")
      .select("id, channel_id, message, sender_name, sender_id, created_at")
      .eq("channel_id", activeChannelId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        setMessages((data ?? []) as Message[]);
      });

    // Realtime subscription
    const channel = supabase
      .channel(`booking-chat-float:${activeChannelId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `channel_id=eq.${activeChannelId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          setMessages((prev) => [...prev, newMsg]);
          if (!open) {
            setUnreadCount((n) => n + 1);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeChannelId, open]);

  // ── Auto-scroll to bottom ────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Reset unread when opening ─────────────────────────────────────────────────
  function handleOpen() {
    setOpen(true);
    setUnreadCount(0);
  }

  // ── Send message ─────────────────────────────────────────────────────────────
  async function handleSend() {
    const content = text.trim();
    if (!content || sending) return;

    let channelId = activeChannelId;

    // Create a default channel if none exists
    if (!channelId) {
      const { data: newChannel } = await supabase
        .from("channels")
        .insert({ booking_id: bookingId, name: "general" })
        .select()
        .single();
      if (newChannel) {
        const c = newChannel as Channel;
        setChannels((prev) => [...prev, c]);
        setActiveChannelId(c.id);
        channelId = c.id;
      }
    }

    if (!channelId) return;

    setSending(true);
    await supabase.from("messages").insert({
      booking_id: bookingId,
      channel_id: channelId,
      message: content,
      sender_id: currentUserEmail || null,
      sender_name: currentUserEmail || null,
    });
    setText("");
    setSending(false);
  }

  // ── New channel (owner only) ──────────────────────────────────────────────────
  async function handleNewChannel() {
    const { data } = await supabase
      .from("channels")
      .insert({ booking_id: bookingId, name: "general" })
      .select()
      .single();
    if (data) {
      const c = data as Channel;
      setChannels((prev) => [...prev, c]);
      setActiveChannelId(c.id);
    }
  }

  // ── Styles ───────────────────────────────────────────────────────────────────
  const accent = "#F5A623";
  const dark = "#111111";
  const panelBg = "#1a1a1a";
  const fontFamily =
    "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

  return (
    <>
      {/* Expanded panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 90,
            right: 24,
            width: 320,
            height: 480,
            background: panelBg,
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 16,
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            fontFamily,
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 16px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                color: "#fff",
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "0.01em",
              }}
            >
              Chat
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.4)",
                fontSize: 18,
                cursor: "pointer",
                padding: "0 2px",
                lineHeight: 1,
              }}
              aria-label="Close chat"
            >
              ×
            </button>
          </div>

          {/* Channel tabs */}
          {channels.length > 1 && (
            <div
              style={{
                display: "flex",
                gap: 0,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
                flexShrink: 0,
                overflowX: "auto",
              }}
            >
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => setActiveChannelId(ch.id)}
                  style={{
                    background: "none",
                    border: "none",
                    borderBottom:
                      activeChannelId === ch.id
                        ? `2px solid ${accent}`
                        : "2px solid transparent",
                    color:
                      activeChannelId === ch.id
                        ? accent
                        : "rgba(255,255,255,0.4)",
                    fontSize: 12,
                    fontWeight: activeChannelId === ch.id ? 700 : 500,
                    padding: "8px 14px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    marginBottom: -1,
                    fontFamily,
                  }}
                >
                  {ch.name ?? "Channel"}
                </button>
              ))}
            </div>
          )}

          {/* New channel button (owner only) */}
          {isOwner && (
            <div
              style={{
                padding: "6px 12px",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={handleNewChannel}
                style={{
                  background: "none",
                  border: "1px solid rgba(245,166,35,0.25)",
                  borderRadius: 6,
                  color: accent,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 10px",
                  cursor: "pointer",
                  fontFamily,
                }}
              >
                + New Channel
              </button>
            </div>
          )}

          {/* Message list */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 12,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {messages.length === 0 ? (
              <p
                style={{
                  color: "rgba(255,255,255,0.2)",
                  fontSize: 12,
                  textAlign: "center",
                  margin: "auto",
                }}
              >
                No messages yet.
              </p>
            ) : (
              messages.map((msg) => {
                const isMine =
                  currentUserEmail &&
                  msg.sender_id === currentUserEmail;
                const rawLabel = msg.sender_name ?? msg.sender_id ?? "Unknown";
                const senderLabel =
                  rawLabel.length > 22
                    ? rawLabel.slice(0, 20) + "…"
                    : rawLabel;

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
                        maxWidth: "78%",
                        background: isMine ? accent : dark,
                        color: isMine ? "#111" : "rgba(255,255,255,0.85)",
                        border: isMine
                          ? "none"
                          : "1px solid rgba(255,255,255,0.07)",
                        borderRadius: isMine
                          ? "14px 14px 4px 14px"
                          : "14px 14px 14px 4px",
                        padding: "8px 11px",
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      {!isMine && (
                        <p
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: "rgba(255,255,255,0.4)",
                            margin: "0 0 3px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {senderLabel}
                        </p>
                      )}
                      <p style={{ margin: 0 }}>{msg.message}</p>
                      <p
                        style={{
                          fontSize: 10,
                          opacity: 0.5,
                          margin: "3px 0 0",
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

          {/* Input row */}
          <div
            style={{
              padding: "10px 12px",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Type a message…"
              disabled={sending}
              style={{
                flex: 1,
                background: "#0e0e0e",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 9,
                padding: "9px 11px",
                color: "#fff",
                fontSize: 12,
                outline: "none",
                fontFamily,
                opacity: sending ? 0.6 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending}
              style={{
                padding: "9px 14px",
                background: accent,
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 700,
                cursor: !text.trim() || sending ? "default" : "pointer",
                opacity: !text.trim() || sending ? 0.5 : 1,
                fontFamily,
                flexShrink: 0,
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Collapsed bubble */}
      <button
        onClick={open ? () => setOpen(false) : handleOpen}
        aria-label={open ? "Close chat" : "Open chat"}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: accent,
          color: dark,
          border: "none",
          fontSize: 22,
          cursor: "pointer",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 20px rgba(245,166,35,0.35)",
          fontFamily,
        }}
      >
        💬
        {unreadCount > 0 && !open && (
          <span
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              width: 18,
              height: 18,
              background: "#ef4444",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}
