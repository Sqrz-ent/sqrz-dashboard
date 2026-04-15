// Universal messages inbox — slide-in panel showing all booking conversations
// Desktop: right panel (380px), Mobile: bottom sheet

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  created_at: string;
  title: string | null;
  service: string | null;
  buyer_label: string | null;
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

const STATUS_LABEL: Record<string, string> = {
  lead:      "Lead",
  requested: "Requested",
  pending:   "Pending",
  confirmed: "Confirmed",
  completed: "Completed",
  declined:  "Declined",
  archived:  "Archived",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConvTitle(conv: Conversation): string {
  if (conv.status === "lead") {
    return conv.buyer_label ?? "Guest via chat";
  }
  if (conv.title && conv.title !== "Booking Request") {
    return conv.title;
  }
  if (conv.service) {
    return conv.service;
  }
  return "Booking request";
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function avatarLetter(conv: Conversation): string {
  return getConvTitle(conv).charAt(0).toUpperCase();
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#888888";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 6,
        background: `${color}22`,
        color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.02em",
        textTransform: "capitalize",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ─── Thread view ──────────────────────────────────────────────────────────────

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
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isInitialRef = useRef(true);

  // Get auth user id (different from profiles.id for migrated users)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAuthUserId(data.user?.id ?? null);
    });
  }, []);

  // Fetch messages on open — reset initial flag so we snap on first load
  useEffect(() => {
    isInitialRef.current = true;
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

  // Scroll to bottom — instant on initial load, smooth on new messages
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (isInitialRef.current) {
      el.scrollTop = el.scrollHeight;
      isInitialRef.current = false;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
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
    } catch (e) {
      console.error("Send failed:", e);
    } finally {
      setSending(false);
    }
  }

  const isLead = conv.status === "lead";
  const buyerName = conv.buyer_label
    ? conv.buyer_label.replace(" via chat", "")
    : getConvTitle(conv);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Messages — scrollable area */}
      <div
        ref={messagesContainerRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", margin: "auto" }}>
            No messages yet
          </p>
        ) : (
          messages.map((msg) => {
            const isOwner = msg.sender_id === authUserId;
            const senderLabel = msg.sender_name ?? (isOwner ? "You" : "Guest");
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: isOwner ? "flex-end" : "flex-start",
                  gap: 3,
                }}
              >
                {/* Sender name */}
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 10,
                    fontWeight: 600,
                    paddingLeft: isOwner ? 0 : 2,
                    paddingRight: isOwner ? 2 : 0,
                  }}
                >
                  {isOwner ? "You" : senderLabel}
                </span>
                {/* Bubble */}
                <div
                  style={{
                    background: isOwner ? "#F5A623" : "var(--surface-muted)",
                    border: isOwner ? "none" : "1px solid var(--border)",
                    borderRadius: isOwner ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                    padding: "8px 12px",
                    maxWidth: "82%",
                    color: isOwner ? "#111" : "var(--text)",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {msg.message}
                </div>
                {/* Timestamp */}
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 10,
                    opacity: 0.7,
                    paddingLeft: isOwner ? 0 : 2,
                    paddingRight: isOwner ? 2 : 0,
                  }}
                >
                  {formatTimestamp(msg.created_at)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Reply input — fixed at bottom, outside scroll */}
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          padding: "10px 12px",
          background: "var(--surface)",
          display: "flex",
          gap: 8,
        }}
      >
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder={`Reply to ${buyerName}…`}
          disabled={sending}
          style={{
            flex: 1,
            background: "var(--surface-muted)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 11px",
            color: "var(--text)",
            fontSize: 14,
            outline: "none",
            opacity: sending ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !reply.trim()}
          style={{
            padding: "8px 14px",
            background: "#F5A623",
            border: "none",
            borderRadius: 8,
            color: "#111",
            fontSize: 12,
            fontWeight: 700,
            cursor: sending || !reply.trim() ? "default" : "pointer",
            opacity: sending || !reply.trim() ? 0.45 : 1,
            flexShrink: 0,
          }}
        >
          Send
        </button>
      </div>

      {/* Lead actions — only for lead status */}
      {isLead && (
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
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
        </div>
      )}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Fetch all conversations when panel opens and profileId is ready
  useEffect(() => {
    if (!open || !profileId) return;

    async function load() {
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, status, created_at, title, service")
        .eq("owner_id", profileId)
        .order("created_at", { ascending: false });

      if (!bookings || bookings.length === 0) {
        setConversations([]);
        return;
      }

      const bookingIds = (bookings as { id: string }[]).map((b) => b.id);

      const [{ data: messages }, { data: participants }] = await Promise.all([
        supabase
          .from("messages")
          .select("id, booking_id, message, sender_name, sender_id, created_at, is_read")
          .in("booking_id", bookingIds)
          .order("created_at", { ascending: true }),
        supabase
          .from("booking_participants")
          .select("booking_id, email")
          .in("booking_id", bookingIds)
          .eq("role", "buyer"),
      ]);

      const buyerLabelMap: Record<string, string> = {};
      for (const p of (participants ?? []) as { booking_id: string; email: string | null }[]) {
        if (p.booking_id && p.email) {
          buyerLabelMap[p.booking_id] = `${p.email} via chat`;
        }
      }

      const msgsByBooking: Record<string, ConvMessage[]> = {};
      for (const msg of (messages ?? []) as ConvMessage[]) {
        const bid = msg.booking_id ?? "";
        if (!msgsByBooking[bid]) msgsByBooking[bid] = [];
        msgsByBooking[bid].push(msg);
      }

      const convs: Conversation[] = (
        bookings as Array<{ id: string; status: string; created_at: string; title: string | null; service: string | null }>
      ).map((b) => ({
        ...b,
        buyer_label: buyerLabelMap[b.id] ?? null,
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

  // Reset selection when panel closes
  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);

  // Keyboard close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedId) setSelectedId(null);
        else onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, selectedId]);

  async function handleConvert(id: string) {
    await supabase.from("bookings").update({ status: "requested" }).eq("id", id);
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: "requested" } : c))
    );
    setSelectedId(null);
  }

  async function handleDecline(id: string) {
    await supabase.from("bookings").update({ status: "declined" }).eq("id", id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setSelectedId(null);
  }

  if (!mounted) return null;

  const selectedConv = selectedId ? conversations.find((c) => c.id === selectedId) ?? null : null;

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
        className="sqrz-msgs-panel"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 420,
          height: "100vh",
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          boxShadow: "12px 0 48px rgba(0,0,0,0.55)",
          zIndex: 9991,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.25s cubic-bezier(0.25,0.8,0.25,1)",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            flexShrink: 0,
            padding: "14px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {selectedConv ? (
            // Thread header
            <>
              <button
                onClick={() => setSelectedId(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 18,
                  cursor: "pointer",
                  padding: "0 4px",
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                aria-label="Back to conversations"
              >
                ←
              </button>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 13,
                    fontWeight: 700,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {getConvTitle(selectedConv)}
                </span>
                <StatusBadge status={selectedConv.status} />
              </div>
              <button
                onClick={onClose}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 18,
                  cursor: "pointer",
                  padding: "2px 4px",
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                aria-label="Close panel"
              >
                ✕
              </button>
            </>
          ) : (
            // List header
            <>
              <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, flex: 1 }}>
                Messages
              </span>
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
              <button
                onClick={onClose}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 20,
                  cursor: "pointer",
                  padding: "2px 4px",
                  lineHeight: 1,
                }}
                aria-label="Close panel"
              >
                ✕
              </button>
            </>
          )}
        </div>

        {/* Content */}
        {selectedConv ? (
          // Thread view — fills remaining panel height, no external scroll
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <ConversationThread
              conv={selectedConv}
              profileId={profileId}
              profileName={profileName}
              onConvert={() => handleConvert(selectedConv.id)}
              onDecline={() => handleDecline(selectedConv.id)}
            />
          </div>
        ) : (
          // Conversation list
          <div style={{ flex: 1, overflowY: "auto" }}>
            {conversations.length === 0 ? (
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No conversations yet</p>
                <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0", opacity: 0.6 }}>
                  Messages from your booking inquiries will appear here.
                </p>
              </div>
            ) : (
              <>
                {/* Empty thread hint */}
                <div
                  style={{
                    padding: "10px 16px 8px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <p style={{ color: "var(--text-muted)", fontSize: 11, margin: 0, opacity: 0.7 }}>
                    Select a conversation to start messaging
                  </p>
                </div>

                {conversations.map((conv) => {
                  const msgs = conv.messages ?? [];
                  const lastMsg = msgs[msgs.length - 1];
                  const unreadCount = msgs.filter(
                    (m) => m.is_read === false && m.sender_id !== profileId
                  ).length;
                  const lastActivity = lastMsg?.created_at ?? conv.created_at;
                  const isHovered = hoveredId === conv.id;

                  return (
                    <button
                      key={conv.id}
                      onClick={() => setSelectedId(conv.id)}
                      onMouseEnter={() => setHoveredId(conv.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 16px",
                        background: isHovered ? "var(--surface-muted)" : "transparent",
                        borderLeft: `3px solid ${isHovered ? "#F5A623" : "transparent"}`,
                        borderTop: "none",
                        borderRight: "none",
                        borderBottom: "1px solid var(--border)",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background 0.12s ease, border-color 0.12s ease",
                      }}
                    >
                      {/* Avatar circle */}
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: "50%",
                          background: "rgba(245,166,35,0.18)",
                          color: "#F5A623",
                          fontSize: 15,
                          fontWeight: 800,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          border: "1px solid rgba(245,166,35,0.25)",
                        }}
                      >
                        {avatarLetter(conv)}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
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
                            {getConvTitle(conv)}
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
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <StatusBadge status={conv.status} />
                          <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                            {timeAgo(lastActivity)}
                          </span>
                        </div>
                        {lastMsg && (
                          <p
                            style={{
                              color: "var(--text-muted)",
                              fontSize: 11,
                              margin: 0,
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {truncate(lastMsg.message ?? "", 48)}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Mobile bottom sheet */}
      <style>{`
        @media (max-width: 480px) {
          .sqrz-msgs-panel {
            top: auto !important;
            left: 0 !important;
            bottom: 0 !important;
            width: 100vw !important;
            height: 85vh !important;
            border-right: none !important;
            border-top: 1px solid var(--border) !important;
            border-radius: 16px 16px 0 0 !important;
            transform: ${open ? "translateY(0)" : "translateY(100%)"} !important;
            transition: transform 0.25s cubic-bezier(0.25,0.8,0.25,1) !important;
          }
        }
      `}</style>
    </>,
    document.body
  );
}
