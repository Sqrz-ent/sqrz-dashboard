// Slide-in leads panel — desktop: right side, mobile: bottom sheet
// Shows all status='lead' bookings with inline conversation threads

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { supabase } from "~/lib/supabase.client";
import type { Lead } from "~/hooks/useNotifications";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  channel_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  message: string | null;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Thread view for a single lead ────────────────────────────────────────────

function LeadThread({
  lead,
  profileId,
  profileName,
  onConvert,
  onDecline,
}: {
  lead: Lead;
  profileId: string | null;
  profileName: string | null;
  onConvert: () => void;
  onDecline: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch channel + messages
  useEffect(() => {
    async function load() {
      const { data: channels } = await supabase
        .from("channels")
        .select("id")
        .eq("booking_id", lead.id)
        .order("created_at", { ascending: true })
        .limit(1);

      const chId = (channels?.[0] as { id: string } | undefined)?.id ?? null;
      setChannelId(chId);

      if (chId) {
        const { data: msgs } = await supabase
          .from("messages")
          .select("id, channel_id, sender_id, sender_name, message, created_at")
          .eq("channel_id", chId)
          .order("created_at", { ascending: true });
        setMessages((msgs ?? []) as Message[]);
      }
    }
    load();
  }, [lead.id]);

  // Realtime subscription
  useEffect(() => {
    if (!channelId) return;

    const ch = supabase
      .channel(`lead-messages-${channelId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `channel_id=eq.${channelId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [channelId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const content = reply.trim();
    if (!content || sending) return;
    setSending(true);

    let chId = channelId;

    // Create channel if none exists
    if (!chId) {
      const { data: newCh } = await supabase
        .from("channels")
        .insert({ booking_id: lead.id, name: "general" })
        .select()
        .single();
      if (newCh) {
        const c = newCh as { id: string };
        setChannelId(c.id);
        chId = c.id;
      }
    }

    if (!chId) { setSending(false); return; }

    await supabase.from("messages").insert({
      booking_id: lead.id,
      channel_id: chId,
      sender_id: profileId ?? null,
      sender_name: profileName ?? "You",
      message: content,
      is_read: false,
    });

    setReply("");
    setSending(false);
  }

  return (
    <div style={{ background: "var(--surface-muted)", borderRadius: 10, overflow: "hidden" }}>
      {/* Messages */}
      <div
        style={{
          maxHeight: 220,
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
            const isOwner = msg.sender_id === profileId;
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
                      {msg.sender_name ?? "Guest"}
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
      <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
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
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

interface LeadsPanelProps {
  open: boolean;
  onClose: () => void;
  leads: Lead[];
  convertLead: (id: string) => Promise<void>;
  declineLead: (id: string) => Promise<void>;
  profileId: string | null;
  profileName: string | null;
}

export default function LeadsPanel({
  open,
  onClose,
  leads,
  convertLead,
  declineLead,
  profileId,
  profileName,
}: LeadsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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

  if (!mounted) return null;

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
            <span style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>Leads</span>
            {leads.length > 0 && (
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
                {leads.length}
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

        {/* Lead list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {leads.length === 0 ? (
            <div style={{ padding: "48px 24px", textAlign: "center" }}>
              <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No leads yet</p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "6px 0 0", opacity: 0.6 }}>
                Leads from your profile booking form will appear here.
              </p>
            </div>
          ) : (
            leads.map((lead) => {
              const isExpanded = expandedId === lead.id;
              return (
                <div
                  key={lead.id}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  {/* Lead row header — click to expand */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "14px 20px",
                      background: isExpanded ? "rgba(245,166,35,0.05)" : "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {/* Unread dot */}
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: "#F5A623",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p
                        style={{
                          color: "var(--text)",
                          fontSize: 13,
                          fontWeight: 600,
                          margin: "0 0 3px",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {lead.guest_name ?? lead.guest_email ?? "Anonymous"}
                      </p>
                      {lead.description && !isExpanded && (
                        <p
                          style={{
                            color: "var(--text-muted)",
                            fontSize: 12,
                            margin: "0 0 2px",
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {lead.description}
                        </p>
                      )}
                      <p style={{ color: "var(--text-muted)", fontSize: 11, margin: 0 }}>
                        {timeAgo(lead.created_at)}
                        {lead.budget_range ? ` · ${lead.budget_range}` : ""}
                      </p>
                    </div>
                    <span style={{ color: "var(--text-muted)", fontSize: 12, flexShrink: 0 }}>
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  </button>

                  {/* Expanded thread */}
                  {isExpanded && (
                    <div style={{ padding: "0 12px 14px" }}>
                      <LeadThread
                        lead={lead}
                        profileId={profileId}
                        profileName={profileName}
                        onConvert={() => {
                          convertLead(lead.id);
                          setExpandedId(null);
                        }}
                        onDecline={() => {
                          declineLead(lead.id);
                          setExpandedId(null);
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Mobile bottom sheet override */}
      <style>{`
        @media (max-width: 480px) {
          .leads-panel-inner {
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
