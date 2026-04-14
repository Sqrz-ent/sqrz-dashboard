// Intercom-style floating chat bubble, bottom-right corner
// Props: bookingId, currentUserEmail, isOwner

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { supabase } from "~/lib/supabase.client";

interface Message {
  id: string;
  booking_id: string;
  sender_id: string | null;
  sender_name: string | null;
  message: string | null;
  created_at: string;
}

interface BookingChatProps {
  bookingId: string;
  currentUserEmail: string;
  isOwner: boolean;
  /** Display name to use as sender_name — no email addresses ever exposed */
  senderName?: string;
  onAfterSend?: (message: string) => void;
}

export default function BookingChat({
  bookingId,
  currentUserEmail,
  isOwner,
  senderName,
  onAfterSend,
}: BookingChatProps) {
  console.log("[BookingChat] render props:", { bookingId, currentUserEmail });
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Resolve auth user on mount ────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setAuthUser({ id: user.id, email: user.email ?? currentUserEmail });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch messages + realtime subscription ────────────────────────────────────
  useEffect(() => {
    if (!bookingId) return;

    // Fetch initial messages
    supabase
      .from("messages")
      .select("id, booking_id, message, sender_name, sender_id, created_at")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        setMessages((data ?? []) as Message[]);
      });

    // Realtime subscription
    const channel = supabase
      .channel(`booking-${bookingId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `booking_id=eq.${bookingId}`,
        },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
          if (!open) {
            setUnreadCount((n) => n + 1);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, open]);

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

    setSending(true);
    await supabase.from("messages").insert({
      booking_id: bookingId,
      message: content,
      sender_id: authUser?.id ?? null,
      sender_name: senderName ?? null,
    });
    setText("");
    setSending(false);
    onAfterSend?.(content);
  }

  // ── Styles ───────────────────────────────────────────────────────────────────
  const accent = "#F5A623";
  const dark = "var(--surface)";
  const panelBg = "var(--surface)";
  const fontFamily =
    "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  console.log("[BookingChat] mounted, bookingId:", bookingId);

  return createPortal(
    <div style={{
      position: "fixed",
      bottom: "80px",
      right: "16px",
      zIndex: 2147483647,
      isolation: "isolate",
      pointerEvents: "auto",
    }}>
      {/* Expanded panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 156,
            right: 24,
            width: 320,
            height: 480,
            background: panelBg,
            border: "1px solid var(--border)",
            borderRadius: 16,
            zIndex: 2147483647,
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
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                color: "var(--text)",
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
                color: "var(--text-muted)",
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
                  color: "var(--text-muted)",
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
                  authUser &&
                  msg.sender_id === authUser.id;
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
                        color: isMine ? "#111" : "var(--text)",
                        border: isMine
                          ? "none"
                          : "1px solid var(--border)",
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
                            color: "var(--text-muted)",
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
              borderTop: "1px solid var(--border)",
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
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                padding: "9px 11px",
                color: "var(--text)",
                fontSize: 16,
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
          bottom: 80,
          right: 16,
          width: "56px",
          height: "56px",
          minWidth: "56px",
          minHeight: "56px",
          borderRadius: "50%",
          backgroundColor: "#F5A623",
          border: "none",
          fontSize: 22,
          cursor: "pointer",
          zIndex: 2147483647,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
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
              color: "var(--text)",
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
    </div>,
    document.body
  );
}
