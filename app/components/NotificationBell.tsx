import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useNotifications, type Toast } from "~/hooks/useNotifications";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Toast item ───────────────────────────────────────────────────────────────

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      onClick={onDismiss}
      style={{
        background: "var(--surface)",
        border: "1px solid rgba(245,166,35,0.4)",
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
        cursor: "pointer",
        minWidth: 280,
        maxWidth: 360,
        animation: "toastIn 0.2s ease",
      }}
    >
      <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>🔔</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 3px" }}>
          {toast.title ?? "New booking request"}
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
          {[toast.buyer_name, toast.service].filter(Boolean).join(" · ") || "New booking request"}
        </p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 18,
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
          lineHeight: 1,
          marginTop: -2,
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// ─── Bell + dropdown ──────────────────────────────────────────────────────────

export default function NotificationBell({ onOpenMessages }: { onOpenMessages?: () => void }) {
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    toasts,
    dismissToast,
    leads,
    unreadMessageCount,
    profileId,
    profileName,
  } = useNotifications();

  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });
  const bellRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      const inBell = bellRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inBell && !inDropdown) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function handleBellClick() {
    if (!open && bellRef.current) {
      const rect = bellRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
    setOpen((v) => !v);
  }

  const totalBadge = unreadCount + unreadMessageCount;

  return (
    <>
      {/* Bell button */}
      <button
        ref={bellRef}
        onClick={handleBellClick}
        aria-label={`Notifications${totalBadge > 0 ? ` — ${totalBadge} unread` : ""}`}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "6px 8px",
          borderRadius: 8,
          color: open ? "#F5A623" : "var(--text-muted)",
          fontSize: 18,
          lineHeight: 1,
          position: "relative",
          display: "flex",
          alignItems: "center",
        }}
      >
        🔔
        {totalBadge > 0 && (
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              background: "#F5A623",
              color: "#111111",
              fontSize: 9,
              fontWeight: 800,
              borderRadius: "50%",
              width: 15,
              height: 15,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              letterSpacing: "-0.02em",
            }}
          >
            {totalBadge > 9 ? "9+" : totalBadge}
          </span>
        )}
      </button>

      {/* ── Dropdown via portal ──────────────────────────────────────────── */}
      {mounted && open && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: dropdownPos.top,
            right: dropdownPos.right,
            width: 320,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
            zIndex: 9999,
            overflow: "hidden",
            animation: "dropdownIn 0.15s ease",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "13px 16px 11px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
              Notifications
            </span>
            {totalBadge > 0 && (
              <span
                style={{
                  background: "rgba(245,166,35,0.15)",
                  color: "#F5A623",
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 10,
                  padding: "2px 8px",
                }}
              >
                {totalBadge} unread
              </span>
            )}
          </div>

          {/* List */}
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {/* Messages entry row — always visible */}
            {(
              <button
                onClick={() => { onOpenMessages?.(); setOpen(false); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 16px",
                  background: "rgba(245,166,35,0.06)",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "#F5A623",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>
                    Messages
                  </span>
                  {unreadMessageCount > 0 && (
                    <span
                      style={{
                        background: "rgba(245,166,35,0.15)",
                        color: "#F5A623",
                        fontSize: 10,
                        fontWeight: 700,
                        borderRadius: 8,
                        padding: "1px 6px",
                      }}
                    >
                      {unreadMessageCount} unread
                    </span>
                  )}
                </div>
                <span style={{ color: "#F5A623", fontSize: 12, fontWeight: 600 }}>
                  View →
                </span>
              </button>
            )}

            {/* Booking notifications */}
            {notifications.length === 0 ? (
              <div
                style={{
                  padding: "24px 16px",
                  textAlign: "center",
                  color: "var(--text-muted)",
                  fontSize: 13,
                }}
              >
                No new requests
              </div>
            ) : (
              <>
                <div
                  style={{
                    padding: "7px 16px 6px",
                    background: "var(--surface-muted)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text-muted)", letterSpacing: "0.07em", textTransform: "uppercase" }}>
                    New requests
                  </span>
                </div>
                {notifications.slice(0, 20).map((n) => (
                  <Link
                    key={n.id}
                    to="/office"
                    onClick={() => { markAsRead(n.id); setOpen(false); }}
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    <div
                      style={{
                        padding: "11px 16px",
                        borderBottom: "1px solid var(--border)",
                        background: n.read ? "transparent" : "rgba(245,166,35,0.04)",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: n.read ? "transparent" : "#F5A623",
                          flexShrink: 0,
                          marginTop: 5,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p
                          style={{
                            color: "var(--text)",
                            fontSize: 13,
                            fontWeight: n.read ? 400 : 600,
                            margin: "0 0 3px",
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {n.title ?? "New booking request"}
                        </p>
                        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: 0 }}>
                          {[n.buyer_name, n.service].filter(Boolean).join(" · ") || "New booking request"} · {timeAgo(n.created_at)}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </>
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
              <button
                onClick={markAllAsRead}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Mark all as read
              </button>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* ── Toast stack via portal ───────────────────────────────────────── */}
      {mounted && createPortal(
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignItems: "flex-end",
            pointerEvents: "none",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          }}
        >
          {toasts.map((toast) => (
            <div key={toast.toastId} style={{ pointerEvents: "all" }}>
              <ToastItem toast={toast} onDismiss={() => dismissToast(toast.toastId)} />
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* Animations */}
      <style>{`
        @keyframes dropdownIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(16px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </>
  );
}
