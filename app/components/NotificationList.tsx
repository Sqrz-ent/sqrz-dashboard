import { useFetcher, useNavigate } from "react-router";

const ACCENT = "#F5A623";

export type NotificationRow = {
  id: string;
  type: "campaign_status" | "campaign_ended" | "booking" | "advisor_warning" | "chat_request";
  subtype: string | null;
  related_id: string | null;
  deep_link: string | null;
  read_at: string | null;
  created_at: string;
};

const TYPE_META: Record<NotificationRow["type"], { icon: string; label: (subtype: string | null) => string }> = {
  campaign_status: {
    icon: "🚀",
    label: (s) => `Campaign update${s ? ` — ${s.replace(/_/g, " ")}` : ""}`,
  },
  campaign_ended: {
    icon: "🏁",
    label: (s) => `Campaign ended${s ? ` — ${s.replace(/_/g, " ")}` : ""}`,
  },
  booking: {
    icon: "📋",
    label: (s) =>
      s === "requested" ? "New booking request"
      : s === "confirmed" ? "Booking confirmed"
      : s === "cancelled" ? "Booking cancelled"
      : `Booking update${s ? ` — ${s}` : ""}`,
  },
  advisor_warning: {
    icon: "⚠️",
    label: () => "Advisor alert — campaign needs attention",
  },
  chat_request: {
    icon: "💬",
    label: () => "New inquiry",
  },
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// Shared notifications list — renders the rows + tap behavior used by both the
// /notifications page and the nav-bell popover. Tapping a row marks it read
// (POST to the /notifications action) and navigates to its deep_link. Callers
// provide their own outer container; onNavigate lets the popover close first.
export function NotificationList({
  notifications,
  onNavigate,
}: {
  notifications: NotificationRow[];
  onNavigate?: () => void;
}) {
  const fetcher = useFetcher();
  const navigate = useNavigate();

  function open(n: NotificationRow) {
    if (!n.read_at) {
      fetcher.submit({ id: n.id }, { method: "post", action: "/notifications" });
    }
    onNavigate?.();
    if (n.deep_link) navigate(n.deep_link);
  }

  if (notifications.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "32px 0" }}>
        No notifications yet
      </div>
    );
  }

  return (
    <>
      {notifications.map((n, i) => {
        const meta = TYPE_META[n.type] ?? { icon: "🔔", label: () => n.type };
        const unread = !n.read_at;
        return (
          <button
            key={n.id}
            type="button"
            onClick={() => open(n)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              borderBottom: i < notifications.length - 1 ? "1px solid var(--border)" : "none",
              padding: "14px 0",
              cursor: n.deep_link ? "pointer" : "default",
            }}
          >
            <span style={{ fontSize: 18, flexShrink: 0 }}>{meta.icon}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 14,
                  fontWeight: unread ? 700 : 500,
                  color: "var(--text)",
                }}
              >
                {meta.label(n.subtype)}
              </span>
              <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {timeAgo(n.created_at)}
              </span>
            </span>
            {unread && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: ACCENT,
                  flexShrink: 0,
                }}
              />
            )}
          </button>
        );
      })}
    </>
  );
}
