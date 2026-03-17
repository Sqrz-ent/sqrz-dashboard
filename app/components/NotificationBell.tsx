import { useState, useEffect, useRef } from "react";
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

function notifLabel(service: string | null, city: string | null): string {
  const parts = [service, city].filter(Boolean);
  return parts.length > 0 ? parts.join(" in ") : "View details";
}

// ─── Toast item ───────────────────────────────────────────────────────────────

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  // Auto-dismiss after 5s
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      onClick={onDismiss}
      style={{
        background: "#1a1a1a",
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
        <p
          style={{
            color: "#ffffff",
            fontSize: 13,
            fontWeight: 600,
            margin: "0 0 3px",
          }}
        >
          New booking request
        </p>
        <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, margin: 0 }}>
          {notifLabel(toast.service, toast.city)}
        </p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        style={{
          background: "none",
          border: "none",
          color: "rgba(255,255,255,0.3)",
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

export default function NotificationBell() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, toasts, dismissToast } =
    useNotifications();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <>
      {/* ── Bell button + dropdown ───────────────────────────────────────────── */}
      <div ref={containerRef} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={`Notifications${unreadCount > 0 ? ` — ${unreadCount} unread` : ""}`}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "6px 8px",
            borderRadius: 8,
            color: open ? "#F5A623" : "rgba(255,255,255,0.55)",
            fontSize: 18,
            lineHeight: 1,
            position: "relative",
            display: "flex",
            alignItems: "center",
          }}
        >
          🔔
          {unreadCount > 0 && (
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
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        {/* Dropdown */}
        {open && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              width: 320,
              background: "#1a1a1a",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
              zIndex: 100,
              overflow: "hidden",
              animation: "dropdownIn 0.15s ease",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "13px 16px 11px",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={{ color: "#ffffff", fontSize: 13, fontWeight: 700 }}>
                Notifications
              </span>
              {unreadCount > 0 && (
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
                  {unreadCount} unread
                </span>
              )}
            </div>

            {/* List */}
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {notifications.length === 0 ? (
                <div
                  style={{
                    padding: "36px 16px",
                    textAlign: "center",
                    color: "rgba(255,255,255,0.2)",
                    fontSize: 13,
                  }}
                >
                  No notifications yet
                </div>
              ) : (
                notifications.slice(0, 20).map((n) => (
                  <Link
                    key={n.id}
                    to="/office"
                    onClick={() => {
                      markAsRead(n.id);
                      setOpen(false);
                    }}
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    <div
                      style={{
                        padding: "11px 16px",
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        background: n.read ? "transparent" : "rgba(245,166,35,0.04)",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                      }}
                    >
                      {/* Unread dot */}
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
                            color: "#ffffff",
                            fontSize: 13,
                            fontWeight: n.read ? 400 : 600,
                            margin: "0 0 3px",
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                          }}
                        >
                          New booking request
                          {n.service ? ` — ${n.service}` : ""}
                        </p>
                        <p
                          style={{
                            color: "rgba(255,255,255,0.35)",
                            fontSize: 11,
                            margin: 0,
                          }}
                        >
                          {[n.city, timeAgo(n.created_at)].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && (
              <div
                style={{
                  padding: "10px 16px",
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <button
                  onClick={markAllAsRead}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(255,255,255,0.35)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Mark all as read
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Toast stack (bottom-right, fixed) ───────────────────────────────── */}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 200,
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
      </div>

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
