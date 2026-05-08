import { useEffect, useMemo, useRef, useState } from "react";
import { StreamChat } from "stream-chat";
import NewBookingModal from "~/components/NewBookingModal";

type ServiceOption = {
  id: string;
  title: string;
  booking_type: string;
};

type InquirySession = {
  apiKey: string;
  token: string;
  threads: Array<{
    id: string;
    visitorName: string | null;
    visitorEmail: string | null;
    channelId: string;
    createdAt: string;
  }>;
  streamUser: {
    id: string;
    name: string;
  };
};

type StreamMessage = {
  id: string;
  text: string;
  userId: string;
  createdAt: string;
};

type StreamMessagePayload = {
  id?: string;
  text?: string;
  created_at?: string;
  user?: {
    id?: string;
  };
};

function mapMessages(messages: StreamMessagePayload[]) {
  return messages.map((message) => ({
    id: String(message.id ?? crypto.randomUUID()),
    text: String(message.text ?? ""),
    userId: String(message.user?.id ?? ""),
    createdAt: String(message.created_at ?? new Date().toISOString()),
  }));
}

type StreamChannelLike = {
  state: {
    messages: StreamMessagePayload[];
  };
  watch: () => Promise<void>;
  on: (eventType: string, listener: (event: { user?: { id?: string } }) => void) => { unsubscribe?: () => void };
  sendMessage: (message: { text: string }) => Promise<unknown>;
  markRead?: () => Promise<unknown>;
};

function formatTimestamp(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function InquiryBubble({
  enabled,
  services,
  requiresPaymentDefault = false,
}: {
  enabled: boolean;
  services: ServiceOption[];
  requiresPaymentDefault?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<InquirySession | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [newBookingOpen, setNewBookingOpen] = useState(false);
  const [newBookingPrefill, setNewBookingPrefill] = useState<{ client_name?: string; client_email?: string; description?: string } | undefined>(undefined);
  const [emptyDraft, setEmptyDraft] = useState("");
  const [convertingThreadId, setConvertingThreadId] = useState<string | null>(null);
  const clientRef = useRef<StreamChat | null>(null);
  const channelRef = useRef<StreamChannelLike | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentThreadId = selectedThreadId ?? session?.threads[0]?.id ?? null;
  const pollKey = useMemo(() => currentThreadId ?? "none", [currentThreadId]);
  const activeThread = session?.threads.find((thread) => thread.id === currentThreadId) ?? session?.threads[0] ?? null;
  const waitingThreads = session?.threads.filter((thread) => thread.id !== activeThread?.id) ?? [];
  const launcherBottom = "max(88px, calc(env(safe-area-inset-bottom) + 20px))";
  const panelBottom = "max(160px, calc(env(safe-area-inset-bottom) + 92px))";

  async function loadThreads() {
    const response = await fetch("/api/messaging/stream-inquiry");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to load inquiry");
    }

    if (!payload?.threads?.length) {
      setSession(null);
      setMessages([]);
      setUnreadCount(0);
      setSelectedThreadId(null);
      return;
    }

    setSession(payload as InquirySession);
    setSelectedThreadId((prev) => {
      const stillExists = payload.threads.some((thread: { id: string }) => thread.id === prev);
      return stillExists ? prev : payload.threads[0]?.id ?? null;
    });
  }

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function refreshThreads() {
      try {
        await loadThreads();
        if (cancelled) return;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load inquiry");
        }
      }
    }

    void refreshThreads();
    const intervalId = window.setInterval(() => {
      if (!open) {
        void refreshThreads();
      }
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, open, pollKey]);

  useEffect(() => {
    if (!session || !activeThread) return;

    let active = true;
    let subscription: { unsubscribe?: () => void } | null = null;
    let typingStartSub: { unsubscribe?: () => void } | null = null;
    let typingStopSub: { unsubscribe?: () => void } | null = null;
    const activeSession = session;
    const thread = activeThread;

    async function connect() {
      setLoading(true);
      const client = StreamChat.getInstance(activeSession.apiKey);
      if (client.userID && client.userID !== activeSession.streamUser.id) {
        await client.disconnectUser();
      }
      if (!client.userID) {
        await client.connectUser(activeSession.streamUser, activeSession.token);
      }

      if (!active) return;

      const channel = client.channel("messaging", thread.channelId) as unknown as StreamChannelLike;
      await channel.watch();
      if (!active) return;

      clientRef.current = client;
      channelRef.current = channel;
      setMessages(mapMessages(channel.state.messages));
      setError(null);
      setLoading(false);

      subscription = channel.on("message.new", (event) => {
        setMessages(mapMessages(channel.state.messages));
        if (!open && event.user?.id !== activeSession.streamUser.id) {
          setUnreadCount((count) => count + 1);
        }
      });

      typingStartSub = (channel as any).on("typing.start", (event: any) => {
        if (!active) return;
        if (event.user?.id !== activeSession.streamUser.id) setVisitorTyping(true);
      });

      typingStopSub = (channel as any).on("typing.stop", (event: any) => {
        if (!active) return;
        if (event.user?.id !== activeSession.streamUser.id) setVisitorTyping(false);
      });
    }

    void connect().catch((err) => {
      if (active) {
        setLoading(false);
        setError(err instanceof Error ? err.message : "Failed to connect inquiry");
      }
    });

    return () => {
      active = false;
      subscription?.unsubscribe?.();
      typingStartSub?.unsubscribe?.();
      typingStopSub?.unsubscribe?.();
    };
  }, [session, activeThread, open]);

  useEffect(() => {
    if (open) {
      setUnreadCount(0);
      channelRef.current?.markRead?.().catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    return () => {
      const client = clientRef.current;
      if (client) {
        client.disconnectUser().catch(() => {});
      }
    };
  }, []);

  if (!enabled) return null;

  async function updateThreadStatus(status: "closed" | "converted") {
    if (!activeThread || updatingStatus) return;

    setUpdatingStatus(true);
    setError(null);
    try {
      const response = await fetch("/api/messaging/stream-inquiry-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: activeThread.id,
          status,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to update inquiry");
      }

      await loadThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update inquiry");
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleNewBookingSuccess(_clientEmail: string, bookingId: string) {
    const threadId = convertingThreadId;
    setConvertingThreadId(null);
    setNewBookingPrefill(undefined);

    if (threadId && bookingId) {
      try {
        const convertResponse = await fetch("/api/messaging/stream-inquiry-convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, bookingId }),
        });
        const convertPayload = await convertResponse.json();
        if (!convertResponse.ok) {
          throw new Error(convertPayload?.error ?? "Failed to convert inquiry");
        }
        await loadThreads();
        window.open(`/booking/${bookingId}`, "_blank");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to convert inquiry");
      }
    } else {
      window.location.reload();
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending || !channelRef.current) return;

    setSending(true);
    setError(null);
    try {
      (channelRef.current as any).stopTyping?.()?.catch?.(() => {});
      await channelRef.current.sendMessage({ text });
      setMessages(mapMessages(channelRef.current.state.messages as StreamMessagePayload[]));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const visitorName = activeThread?.visitorName || activeThread?.visitorEmail || "Visitor";

  if (!enabled) return null;

  return (
    <>
      {open && (
        <div
          style={{
            position: "fixed",
            right: 20,
            bottom: panelBottom,
            width: "min(360px, calc(100vw - 32px))",
            height: 480,
            background: "var(--surface)",
            border: "1px solid rgba(245,166,35,0.28)",
            borderRadius: 20,
            boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
            overflow: "hidden",
            zIndex: 120,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "14px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "rgba(245,166,35,0.06)",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                {activeThread ? visitorName : "Live inquiry"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                <span>
                  {activeThread
                    ? `Live inquiry${waitingThreads.length > 0 ? ` · +${waitingThreads.length} waiting` : ""}`
                    : "No active conversation yet"}
                </span>
                {activeThread && (
                  <>
                    <span style={{ opacity: 0.4 }}>·</span>
                    <button
                      onClick={() => void updateThreadStatus("closed")}
                      disabled={updatingStatus}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: 11,
                        color: "var(--text-muted)",
                        cursor: updatingStatus ? "default" : "pointer",
                        opacity: updatingStatus ? 0.4 : 1,
                        textDecoration: "underline",
                        fontFamily: "inherit",
                      }}
                    >
                      Close inquiry
                    </button>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {activeThread && waitingThreads.length > 0 && (
                <select
                  value={activeThread.id}
                  onChange={(event) => {
                    setSelectedThreadId(event.target.value);
                    setMessages([]);
                  }}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                    borderRadius: 8,
                    fontSize: 11,
                    padding: "5px 8px",
                  }}
                >
                  {[activeThread, ...waitingThreads].map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {(thread.visitorName || thread.visitorEmail || "Visitor").slice(0, 20)}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            {!session || !activeThread ? (
              <div
                style={{
                  margin: "auto 0",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  textAlign: "center",
                  padding: "0 10px",
                }}
              >
                Draft your proposal and send it directly to your client.
              </div>
            ) : loading ? (
              <div style={{ margin: "auto 0", color: "var(--text-muted)", fontSize: 13 }}>Connecting…</div>
            ) : messages.length === 0 ? (
              <div style={{ margin: "auto 0", color: "var(--text-muted)", fontSize: 13 }}>Waiting for the first message…</div>
            ) : (
              messages.map((message) => {
                const isOwner = message.userId === session.streamUser.id;
                return (
                  <div
                    key={message.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: isOwner ? "flex-end" : "flex-start",
                      gap: 4,
                    }}
                  >
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      {isOwner ? "You" : visitorName}
                    </div>
                    <div
                      style={{
                        maxWidth: "82%",
                        padding: "10px 12px",
                        borderRadius: isOwner ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                        background: isOwner ? "#F5A623" : "var(--surface-muted)",
                        color: isOwner ? "#111" : "var(--text)",
                        fontSize: 13,
                        lineHeight: 1.5,
                        border: isOwner ? "none" : "1px solid var(--border)",
                      }}
                    >
                      {message.text}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", opacity: 0.7 }}>
                      {formatTimestamp(message.createdAt)}
                    </div>
                  </div>
                );
              })
            )}
            {visitorTyping && session && activeThread && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {visitorName}
                </div>
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "16px 16px 16px 4px",
                    background: "var(--surface-muted)",
                    color: "var(--text-muted)",
                    fontSize: 13,
                    border: "1px solid var(--border)",
                  }}
                >
                  typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── Empty state: no active inquiry ───────────────────────────── */}
          {!activeThread ? (
            <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "grid", gap: 8 }}>
              <textarea
                value={emptyDraft}
                onChange={(event) => setEmptyDraft(event.target.value)}
                placeholder="Message to buyer…"
                rows={3}
                style={{
                  width: "100%",
                  background: "var(--surface-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  color: "var(--text)",
                  padding: "12px 14px",
                  fontSize: 16,
                  resize: "none",
                  boxSizing: "border-box",
                  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
                  outline: "none",
                }}
              />
              <button
                onClick={() => {
                  setConvertingThreadId(null);
                  setNewBookingPrefill({ description: emptyDraft || undefined });
                  setNewBookingOpen(true);
                }}
                style={{
                  width: "100%",
                  background: "#F5A623",
                  color: "#111",
                  border: "none",
                  borderRadius: 10,
                  padding: "11px 16px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                + Create Proposal
              </button>
            </div>
          ) : (
            /* ── Active inquiry: Convert CTA + reply input ───────────────── */
            <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "grid", gap: 8 }}>
              {error && <div style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>}

              {/* Reply input */}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (channelRef.current) {
                      (channelRef.current as any).keystroke?.()?.catch?.(() => {});
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={`Reply to ${visitorName}…`}
                  style={{
                    flex: 1,
                    background: "var(--surface-muted)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    color: "var(--text)",
                    padding: "12px 14px",
                    fontSize: 16,
                  }}
                />
                <button
                  onClick={() => void handleSend()}
                  disabled={sending || !draft.trim()}
                  style={{
                    background: "#F5A623",
                    color: "#111",
                    border: "none",
                    borderRadius: 12,
                    padding: "0 16px",
                    fontSize: 13,
                    fontWeight: 700,
                    opacity: sending || !draft.trim() ? 0.55 : 1,
                    cursor: sending || !draft.trim() ? "default" : "pointer",
                  }}
                >
                  Send
                </button>
              </div>

              {/* Convert CTA — pinned last */}
              <button
                onClick={() => {
                  setConvertingThreadId(activeThread.id);
                  setNewBookingPrefill({
                    client_name: activeThread.visitorName ?? undefined,
                    client_email: activeThread.visitorEmail ?? undefined,
                  });
                  setNewBookingOpen(true);
                }}
                disabled={updatingStatus}
                style={{
                  width: "100%",
                  background: "#F5A623",
                  color: "#111",
                  border: "none",
                  borderRadius: 10,
                  padding: "11px 16px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: updatingStatus ? "default" : "pointer",
                  opacity: updatingStatus ? 0.55 : 1,
                }}
              >
                Create Proposal
              </button>
            </div>
          )}
        </div>
      )}

      <button
        onClick={() => setOpen((value) => !value)}
        style={{
          position: "fixed",
          right: 20,
          bottom: launcherBottom,
          width: 58,
          height: 58,
          borderRadius: "50%",
          border: "1px solid rgba(245,166,35,0.35)",
          background: "linear-gradient(180deg, #F5A623, #D89516)",
          color: "#111",
          fontSize: 22,
          fontWeight: 800,
          boxShadow: "0 18px 40px rgba(0,0,0,0.32)",
          cursor: "pointer",
          zIndex: 120,
        }}
        aria-label="Open inquiry chat"
      >
        💬
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 2,
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              background: "#111",
              color: "#F5A623",
              fontSize: 10,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
        <span
          style={{
            position: "absolute",
            top: 62,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10,
            fontWeight: 700,
            color: "#111",
            opacity: 0.72,
            whiteSpace: "nowrap",
          }}
        >
          {session?.threads.length ? (session.threads.length > 1 ? `${session.threads.length} active` : "1 active") : "ready"}
        </span>
      </button>

      <NewBookingModal
        isOpen={newBookingOpen}
        onClose={() => {
          setNewBookingOpen(false);
          setConvertingThreadId(null);
          setNewBookingPrefill(undefined);
        }}
        services={services}
        onSuccess={handleNewBookingSuccess}
        prefill={newBookingPrefill}
        requiresPaymentDefault={requiresPaymentDefault}
      />
    </>
  );
}
