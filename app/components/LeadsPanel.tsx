// Universal messages inbox — slide-in panel showing all booking conversations
// Desktop: right panel (380px), Mobile: bottom sheet

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { supabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConvMessage {
  id: string;
  booking_id?: string;
  message: string | null;
  sender_name: string | null;
  sender_id: string | null;
  created_at: string;
  is_read: boolean | null;
}

interface Conversation {
  id: string;
  status: string;
  guest_name: string | null;
  guest_email: string | null;
  created_at: string;
  messages: ConvMessage[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  lead:      "#888888",
  requested: "#F3B130",
  pending:   "#F3B130",
  confirmed: "#22c55e",
  completed: "#888888",
  declined:  "#888888",
  archived:  "#888888",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

// ─── Thread view ─────────────────────────────────────────────────────────────

function ConversationThread({
  conv,
  profileId,
  profileName,
  onConvert,
  onDecline,
}: {
  conv: Conversation;
  profileId: string | null;
  profileName: string | null;
  onConvert: () => void;
  onDecline: () => void;
}) {
  const [messages, setMessages] = useState<ConvMessage[]>(conv.messages ?? []);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Get auth user id (different from profiles.id for migrated users)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAuthUserId(data.user?.id ?? null);
    });
  }, []);

  // Fetch messages on open
  useEffect(() => {
    supabase
      .from("messages")
      .select("id, booking_id, message, sender_name, sender_id, created_at, is_read")
      .eq("booking_id", conv.id)
      .order("created_at", { ascending: true })
      .then(({ data }) => { if (data) setMessages(data as ConvMessage[]); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Mark as read when authUserId is known
  useEffect(() => {
    if (!authUserId) return;
    supabase
      .from("messages")
      .update({ is_read: true })
      .eq("booking_id", conv.id)
      .neq("sender_id", authUserId)
      .then(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id, authUserId]);

  // Realtime
  useEffect(() => {
    const ch = supabase
      .channel(`conv-messages-${conv.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `booking_id=eq.${conv.id}` },
        (payload) => { setMessages((prev) => [...prev, payload.new as ConvMessage]); }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [conv.id]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const content = reply.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await supabase.from("messages").insert({
        booking_id: conv.id,
        sender_id: authUserId,
        sender_name: profileName ?? "You",
        message: content,
        is_read: false,
      });
      setReply("");
      // Notify guest by email (fire and forget)
      if (conv.guest_email) {
        fetch("/api/notify-guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingId: conv.id,
            guestEmail: conv.guest_email,
            guestName: conv.guest_name,
            memberName: profileName,
            message: content,
          }),
        }).catch(() => {});
      }
    } catch (e) {
      console.error("Send failed:", e);
    } finally {
      setSending(false);
    }
  }

  const isLead = conv.status === "lead";

  return (
    <div style={{ background: "var(--surface-muted)", borderRadius: 10, overflow: "hidden" }}>
      {/* Messages */}
      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", margin: "16px 0" }}>
            No messages yet
          </p>
        ) : (
          messages.map((msg) => {
            const isOwner = msg.sender_id === authUserId;
            const displayName = msg.sender_name === "Guest"
              ? (conv.guest_name ?? "Guest")
              : (msg.sender_name ?? "Guest");
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: isOwner ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    background: isOwner ? "rgba(245,166,35,0.15)" : "var(--surface)",
                    border: `1px solid ${isOwner ? "rgba(245,166,35,0.3)" : "var(--border)"}`,
                    borderRadius: isOwner ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    padding: "7px 11px",
                    maxWidth: "85%",
                  }}
                >
                  {!isOwner && (
                    <p style={{ color: "#F5A623", fontSize: 10, fontWeight: 700, margin: "0 0 2px" }}>
                      {displayName}
                    </p>
                  )}
                  <p style={{ color: "var(--text)", fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                    {msg.message}
                  </p>
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 2 }}>
                  {timeAgo(msg.created_at)}
                </span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply input */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 12px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder="Reply…"
          style={{
            flex: 1,
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "7px 10px",
            color: "var(--text)",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !reply.trim()}
          style={{
            padding: "7px 14px",
            background: "#F5A623",
            border: "none",
            borderRadius: 8,
            color: "#111",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            opacity: sending || !reply.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
        {isLead ? (
          <>
            <button
              onClick={onConvert}
              style={{
                flex: 1,
                padding: "8px 12px",
                background: "#F5A623",
                border: "none",
                borderRadius: 8,
                color: "#111",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Convert to booking →
            </button>
            <button
              onClick={onDecline}
              style={{
                padding: "8px 12px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text-muted)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Decline
            </button>
          </>
        ) : (
          <Link
            to={`/office/${conv.id}`}
            style={{
              flex: 1,
              padding: "8px 12px",
              background: "rgba(245,166,35,0.1)",
              border: "1px solid rgba(245,166,35,0.25)",
              borderRadius: 8,
              color: "#F5A623",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              textDecoration: "none",
              textAlign: "center",
            }}
          >
            Open in Office →
          </Link>
        )}
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

interface LeadsPanelProps {
  open: boolean;
  onClose: () => void;
  profileId: string | null;
  profileName: string | null;
}

export default function LeadsPanel({
  open,
  onClose,
  profileId,
  profileName,
}: LeadsPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Fetch all conversations when panel opens and profileId is ready
  useEffect(() => {
    if (!open || !profileId) return;

    async function load() {
      // Step 1: fetch all bookings owned by this profile
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, status, guest_name, guest_email, created_at")
        .eq("owner_id", profileId)
        .order("created_at", { ascending: false });

      if (!bookings || bookings.length === 0) {
        setConversations([]);
        return;
      }

      // Step 2: fetch all messages for those bookings
      const bookingIds = (bookings as { id: string }[]).map((b) => b.id);
      const { data: messages } = await supabase
        .from("messages")
        .select("id, booking_id, message, sender_name, sender_id, created_at, is_read")
        .in("booking_id", bookingIds)
        .order("created_at", { ascending: true });

      // Group messages by booking_id
      const msgsByBooking: Record<string, ConvMessage[]> = {};
      for (const msg of (messages ?? []) as ConvMessage[]) {
        const bid = msg.booking_id ?? "";
        if (!msgsByBooking[bid]) msgsByBooking[bid] = [];
        msgsByBooking[bid].push(msg);
      }

      // Merge and sort by latest activity
      const convs: Conversation[] = (bookings as Conversation[]).map((b) => ({
        ...b,
        messages: msgsByBooking[b.id] ?? [],
      }));

      convs.sort((a, b) => {
        const aLast = a.messages.at(-1)?.created_at ?? a.created_at;
        const bLast = b.messages.at(-1)?.created_at ?? b.created_at;
        return new Date(bLast).getTime() - new Date(aLast).getTime();
      });

      setConversations(convs);
    }
    load();
  }, [open, profileId]);

  // Close expanded thread when panel closes
  useEffect(() => {
    if (!open) setExpandedId(null);
  }, [open]);

  // Keyboard close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleConvert(id: string) {
    await supabase.from("bookings").update({ status: "requested" }).eq("id", id);
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: "requested" } : c))
    );
    setExpandedId(null);
  }

  async function handleDecline(id: string) {
    await supabase.from("bookings").update({ status: "declined" }).eq("id", id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setExpandedId(null);
  }

  if (!mounted) return null;

  const totalUnread = conversations.reduce((sum, c) => {
    const count = (c.messages ?? []).filter(
      (m) => m.is_read === false && m.sender_id !== profileId
    ).length;
    return sum + count;
  }, 0);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 9990,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "all" : "none",
          transition: "opacity 0.2s ease",
        }}
      />

      {/* Panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: open ? 0 : -420,
          width: 380,
          height: "100vh",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 48px rgba(0,0,0,0.55)",
          zIndex: 9991,
          display: "flex",
          flexDirection: "column",
          transition: "right 0.25s cubic-bezier(0.25,0.8,0.25,1)",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>Messages</span>
            {totalUnread > 0 && (
              <span
                style={{
                  background: "rgba(245,166,35,0.15)",
                  color: "#F5A623",
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 10,
                  padding: "2px 8px",
                }}
              >
                {totalUnread} unread
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 20,
              cursor: "pointer",
              padding: "2px 6px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Conversation list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {conversations.length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No conversations yet</p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0", opacity: 0.6 }}>
                Messages from your booking inquiries will appear here.
              </p>
            </div>
          ) : (
            conversations.map((conv) => {
              const isExpanded = expandedId === conv.id;
              const msgs = conv.messages ?? [];
              const lastMsg = msgs[msgs.length - 1];
              const unreadCount = msgs.filter(
                (m) => m.is_read === false && m.sender_id !== profileId
              ).length;
              const statusDot = STATUS_COLOR[conv.status] ?? "#888888";
              const lastActivity = lastMsg?.created_at ?? conv.created_at;

              return (
                <div key={conv.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  {/* Row header */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : conv.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "13px 20px",
                      background: isExpanded ? "rgba(245,166,35,0.04)" : "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {/* Status dot */}
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: statusDot,
                        flexShrink: 0,
                      }}
                    />

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <p
                          style={{
                            color: "var(--text)",
                            fontSize: 13,
                            fontWeight: unreadCount > 0 ? 700 : 500,
                            margin: 0,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {conv.guest_name ?? conv.guest_email ?? "Unknown visitor"}
                        </p>
                        {unreadCount > 0 && (
                          <span
                            style={{
                              background: "#F5A623",
                              color: "#111",
                              fontSize: 9,
                              fontWeight: 800,
                              borderRadius: "50%",
                              width: 16,
                              height: 16,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            {unreadCount > 9 ? "9+" : unreadCount}
                          </span>
                        )}
                      </div>
                      <p
                        style={{
                          color: "var(--text-muted)",
                          fontSize: 11,
                          margin: "0 0 3px",
                          textTransform: "capitalize",
                        }}
                      >
                        {conv.status}
                      </p>
                      {lastMsg && (
                        <p
                          style={{
                            color: "var(--text-muted)",
                            fontSize: 12,
                            margin: 0,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {truncate(lastMsg.message ?? "", 50)}
                        </p>
                      )}
                    </div>

                    {/* Time + chevron */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: 4,
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                        {timeAgo(lastActivity)}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {/* Expanded thread */}
                  {isExpanded && (
                    <div style={{ padding: "0 12px 14px" }}>
                      <ConversationThread
                        conv={conv}
                        profileId={profileId}
                        profileName={profileName}
                        onConvert={() => handleConvert(conv.id)}
                        onDecline={() => handleDecline(conv.id)}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Mobile bottom sheet */}
      <style>{`
        @media (max-width: 480px) {
          .sqrz-msgs-panel {
            top: auto !important;
            bottom: ${open ? "0" : "-100%"} !important;
            right: 0 !important;
            width: 100% !important;
            height: 85vh !important;
            border-left: none !important;
            border-top: 1px solid var(--border) !important;
            border-radius: 16px 16px 0 0 !important;
          }
        }
      `}</style>
    </>,
    document.body
  );
}
