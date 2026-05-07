// Intercom-style floating chat bubble, bottom-right corner
// Props: bookingId, currentUserEmail, isOwner

import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { StreamChat } from "stream-chat";
import { supabase } from "~/lib/supabase.client";
import type { MessagingProvider } from "~/lib/messaging/types";
import AttachmentSheet from "./AttachmentSheet";
import MessageAttachment from "./MessageAttachment";

interface MessageAttachmentData {
  type: string;
  image_url?: string;
  fallback?: string;
}

interface Message {
  id: string;
  booking_id: string;
  sender_id: string | null;
  sender_name: string | null;
  message: string | null;
  created_at: string;
  attachments?: MessageAttachmentData[];
}

function mapStreamMessages(channelMessages: Array<Record<string, any>>, bookingId: string): Message[] {
  return channelMessages.map((message) => ({
    id: String(message.id ?? crypto.randomUUID()),
    booking_id: bookingId,
    sender_id: (message.user?.id as string | undefined) ?? null,
    sender_name: (message.user?.name as string | undefined) ?? null,
    message: (message.text as string | undefined) ?? null,
    created_at: (message.created_at as string | undefined) ?? new Date().toISOString(),
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as Array<Record<string, unknown>>).map((a) => ({
          type: String(a.type ?? ""),
          image_url: a.image_url ? String(a.image_url) : undefined,
          fallback: a.fallback ? String(a.fallback) : undefined,
        }))
      : undefined,
  }));
}

interface BookingChatProps {
  bookingId: string;
  currentUserEmail: string;
  isOwner: boolean;
  messagingProvider?: MessagingProvider;
  bookingToken?: string | null;
  /** Display name to use as sender_name — no email addresses ever exposed */
  senderName?: string;
  /** Name of the other participant — used as fallback when a message has no sender_name */
  participantName?: string;
  onAfterSend?: (message: string) => void;
}

export default function BookingChat({
  bookingId,
  currentUserEmail,
  isOwner,
  messagingProvider = "supabase",
  bookingToken = null,
  senderName,
  participantName,
  onAfterSend,
}: BookingChatProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [otherPartyTyping, setOtherPartyTyping] = useState(false);
  const [otherPartySeen, setOtherPartySeen] = useState(false);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null);
  const [currentSenderId, setCurrentSenderId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamClientRef = useRef<StreamChat | null>(null);
  const streamChannelRef = useRef<any>(null);

  // ── Resolve auth user on mount ────────────────────────────────────────────────
  useEffect(() => {
    if (messagingProvider !== "supabase") return;

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setAuthUser({ id: user.id, email: user.email ?? currentUserEmail });
        setCurrentSenderId(user.id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagingProvider]);

  // ── Fetch messages + realtime subscription ────────────────────────────────────
  useEffect(() => {
    if (messagingProvider !== "supabase") return;
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
  }, [bookingId, open, messagingProvider]);

  // ── Stream bootstrap + subscription ──────────────────────────────────────────
  useEffect(() => {
    if (messagingProvider !== "stream" || !bookingId) return;

    let active = true;
    const subs: Array<{ unsubscribe?: () => void }> = [];

    async function initStream() {
      setLoading(true);
      setStreamError(null);

      try {
        const params = new URLSearchParams({ bookingId });
        if (bookingToken) params.set("token", bookingToken);

        const response = await fetch(`/api/messaging/stream-token?${params.toString()}`);
        const payload = await response.json() as {
          apiKey?: string;
          token?: string;
          channelId?: string;
          streamUser?: { id: string; name: string };
          error?: string;
        };

        if (!response.ok || !payload.apiKey || !payload.token || !payload.channelId || !payload.streamUser?.id) {
          throw new Error(payload.error ?? "Failed to initialize Stream chat");
        }

        const client = StreamChat.getInstance(payload.apiKey);
        if (client.userID && client.userID !== payload.streamUser.id) {
          await client.disconnectUser();
        }
        if (!client.userID) {
          await client.connectUser(
            { id: payload.streamUser.id, name: payload.streamUser.name ?? senderName ?? "SQRZ User" },
            payload.token
          );
        }

        const channel = client.channel("messaging", payload.channelId);
        await channel.watch();

        if (!active) return;

        streamClientRef.current = client;
        streamChannelRef.current = channel;
        setAuthUser({ id: payload.streamUser.id, email: currentUserEmail });
        setCurrentSenderId(payload.streamUser.id);
        setMessages(mapStreamMessages(channel.state.messages as Array<Record<string, any>>, bookingId));
        setUnreadCount(typeof channel.countUnread === "function" ? channel.countUnread() : 0);

        if (open) {
          await channel.markRead();
          if (active) setUnreadCount(0);
        }

        const myStreamUserId = payload.streamUser?.id ?? "";

        // Derive initial read-receipt state
        {
          const readState = (channel.state as any)?.read as Record<string, { last_read: string | Date }> | undefined;
          if (readState && myStreamUserId) {
            const msgs = (channel.state.messages ?? []) as Array<Record<string, any>>;
            const myLastMsg = [...msgs].reverse().find((m) => (m.user as any)?.id === myStreamUserId);
            if (myLastMsg) {
              const myLastMsgTime = new Date(myLastMsg.created_at as string).getTime();
              const seen = Object.entries(readState).some(([userId, r]) => {
                if (userId === myStreamUserId) return false;
                const t = r.last_read instanceof Date ? r.last_read.getTime() : new Date(r.last_read as string).getTime();
                return t >= myLastMsgTime;
              });
              if (active) setOtherPartySeen(seen);
            }
          }
        }

        subs.push(channel.on("message.new", async (event: Record<string, any>) => {
          if (!active) return;

          setMessages(mapStreamMessages(channel.state.messages as Array<Record<string, any>>, bookingId));

          const eventSenderId = event.user?.id as string | undefined;
          if (!open && eventSenderId && eventSenderId !== myStreamUserId) {
            setUnreadCount((count) => count + 1);
          }

          if (open) {
            try {
              await channel.markRead();
              if (active) setUnreadCount(0);
            } catch {
              // Non-fatal — UI can still update from local message state.
            }
          }
        }));

        subs.push(channel.on("typing.start", (event: Record<string, any>) => {
          if (!active) return;
          if ((event.user?.id as string | undefined) !== myStreamUserId) {
            setOtherPartyTyping(true);
          }
        }));

        subs.push(channel.on("typing.stop", (event: Record<string, any>) => {
          if (!active) return;
          if ((event.user?.id as string | undefined) !== myStreamUserId) {
            setOtherPartyTyping(false);
          }
        }));

        subs.push(channel.on("message.read", (_event: Record<string, any>) => {
          if (!active) return;
          const readState = (channel.state as any)?.read as Record<string, { last_read: string | Date }> | undefined;
          if (!readState || !myStreamUserId) return;
          const msgs = (channel.state.messages ?? []) as Array<Record<string, any>>;
          const myLastMsg = [...msgs].reverse().find((m) => (m.user as any)?.id === myStreamUserId);
          if (!myLastMsg) return;
          const myLastMsgTime = new Date(myLastMsg.created_at as string).getTime();
          const seen = Object.entries(readState).some(([userId, r]) => {
            if (userId === myStreamUserId) return false;
            const t = r.last_read instanceof Date ? r.last_read.getTime() : new Date(r.last_read as string).getTime();
            return t >= myLastMsgTime;
          });
          setOtherPartySeen(seen);
        }));
      } catch (error) {
        console.error("[BookingChat] Stream init failed:", error);
        if (active) {
          setStreamError(error instanceof Error ? error.message : "Stream chat failed to load");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    initStream();

    return () => {
      active = false;
      for (const sub of subs) sub.unsubscribe?.();
      streamChannelRef.current = null;
      if (streamClientRef.current) {
        streamClientRef.current.disconnectUser().catch(() => {});
        streamClientRef.current = null;
      }
    };
  }, [bookingId, bookingToken, currentUserEmail, messagingProvider, senderName]);

  useEffect(() => {
    if (!open || messagingProvider !== "stream" || !streamChannelRef.current) return;

    streamChannelRef.current.markRead()
      .then(() => setUnreadCount(0))
      .catch(() => {});
  }, [open, messagingProvider]);

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
    try {
      if (messagingProvider === "stream") {
        if (!streamChannelRef.current) {
          throw new Error("Stream channel is not ready yet");
        }

        (streamChannelRef.current as any).stopTyping?.()?.catch?.(() => {});
        await streamChannelRef.current.sendMessage({ text: content });
        setMessages(mapStreamMessages(
          streamChannelRef.current.state.messages as Array<Record<string, any>>,
          bookingId
        ));
      } else {
        await supabase.from("messages").insert({
          booking_id: bookingId,
          message: content,
          sender_id: authUser?.id ?? null,
          sender_name: senderName ?? null,
        });
      }

      setText("");
      onAfterSend?.(content);
    } catch (error) {
      console.error("[BookingChat] send failed:", error);
      if (messagingProvider === "stream") {
        setStreamError(error instanceof Error ? error.message : "Failed to send message");
      }
    } finally {
      setSending(false);
    }
  }

  // ── Attach image (Stream only) ────────────────────────────────────────────────
  async function handleAttachFile(file: File) {
    setUploadError(null);

    if (!file.type.startsWith("image/")) {
      setUploadError("Only image files are supported.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("Image must be 5 MB or smaller.");
      return;
    }
    if (!streamChannelRef.current) {
      setUploadError("Chat is not ready. Please try again.");
      return;
    }

    setUploading(true);
    try {
      const result = await (streamChannelRef.current as any).sendImage(file) as { file: string };
      const imageUrl = result.file;
      (streamChannelRef.current as any).stopTyping?.()?.catch?.(() => {});
      await streamChannelRef.current.sendMessage({
        text: "",
        attachments: [{ type: "image", image_url: imageUrl, fallback: file.name }],
      });
      setMessages(mapStreamMessages(
        streamChannelRef.current.state.messages as Array<Record<string, any>>,
        bookingId
      ));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Failed to upload image.");
    } finally {
      setUploading(false);
    }
  }

  // ── Styles ───────────────────────────────────────────────────────────────────
  const accent = "#F5A623";
  const dark = "var(--surface)";
  const panelBg = "var(--surface)";
  const fontFamily =
    "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

  const lastSentMessageId = useMemo(() => {
    if (!currentSenderId) return null;
    return [...messages].reverse().find((m) => m.sender_id === currentSenderId)?.id ?? null;
  }, [messages, currentSenderId]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

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
                const isMine = !!currentSenderId && msg.sender_id === currentSenderId;
                const rawLabel = msg.sender_name ?? (participantName ?? "Guest");
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
                      {msg.message && <p style={{ margin: 0 }}>{msg.message}</p>}
                      {msg.attachments?.map((att, i) =>
                        att.type === "image" && att.image_url ? (
                          <MessageAttachment key={i} url={att.image_url} fallback={att.fallback} />
                        ) : null
                      )}
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
                      {isMine && msg.id === lastSentMessageId && otherPartySeen && messagingProvider === "stream" && (
                        <p
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            margin: "2px 0 0",
                            textAlign: "right",
                            opacity: 0.8,
                          }}
                        >
                          Seen
                        </p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {loading && messages.length === 0 && (
              <p
                style={{
                  color: "var(--text-muted)",
                  fontSize: 12,
                  textAlign: "center",
                  margin: "12px auto 0",
                }}
              >
                Connecting chat...
              </p>
            )}
            {streamError && messagingProvider === "stream" && (
              <p
                style={{
                  color: "#fca5a5",
                  fontSize: 12,
                  textAlign: "center",
                  margin: "12px auto 0",
                  maxWidth: 220,
                  lineHeight: 1.4,
                }}
              >
                {streamError}
              </p>
            )}
            {otherPartyTyping && messagingProvider === "stream" && (
              <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 4 }}>
                <div
                  style={{
                    background: "var(--surface-muted)",
                    border: "1px solid var(--border)",
                    borderRadius: "14px 14px 14px 4px",
                    padding: "6px 11px",
                    color: "var(--text-muted)",
                    fontSize: 11,
                  }}
                >
                  {participantName ?? "Other party"} is typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Upload error */}
          {uploadError && (
            <p
              style={{
                fontSize: 11,
                color: "#fca5a5",
                padding: "0 12px 6px",
                margin: 0,
                flexShrink: 0,
              }}
            >
              {uploadError}
            </p>
          )}

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
            {messagingProvider === "stream" && (
              <button
                onClick={() => { setUploadError(null); setAttachSheetOpen(true); }}
                disabled={uploading || loading}
                aria-label="Attach image"
                style={{
                  width: 36,
                  height: 36,
                  padding: 0,
                  background: "var(--surface-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  fontSize: 16,
                  cursor: uploading || loading ? "default" : "pointer",
                  opacity: uploading || loading ? 0.5 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {uploading ? "…" : "📎"}
              </button>
            )}
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (streamChannelRef.current) {
                  (streamChannelRef.current as any).keystroke?.()?.catch?.(() => {});
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Type a message…"
              disabled={sending || loading || uploading}
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
                opacity: sending || loading || uploading ? 0.6 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending || loading || uploading}
              style={{
                padding: "9px 14px",
                background: accent,
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 12,
                fontWeight: 700,
                cursor: !text.trim() || sending || loading || uploading ? "default" : "pointer",
                opacity: !text.trim() || sending || loading || uploading ? 0.5 : 1,
                fontFamily,
                flexShrink: 0,
              }}
            >
              Send
            </button>
          </div>

          {attachSheetOpen && (
            <AttachmentSheet
              onFile={handleAttachFile}
              onClose={() => setAttachSheetOpen(false)}
              fontFamily={fontFamily}
            />
          )}

          {/* Upgrade prompt — free-tier owner only */}
          {messagingProvider === "supabase" && isOwner && (
            <p
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                textAlign: "center",
                margin: 0,
                padding: "6px 12px 10px",
                flexShrink: 0,
                fontFamily,
              }}
            >
              <a href="/account" style={{ color: "var(--text-muted)", fontWeight: 600, textDecoration: "underline" }}>
                Upgrade
              </a>
              {" to unlock image sharing, typing indicators and read receipts"}
            </p>
          )}
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
