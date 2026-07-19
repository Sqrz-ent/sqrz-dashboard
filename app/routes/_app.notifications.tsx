import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/_app.notifications";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const ACCENT = "#F5A623";

type NotificationRow = {
  id: string;
  type: "campaign_status" | "campaign_ended" | "booking" | "advisor_warning" | "chat_request";
  subtype: string | null;
  related_id: string | null;
  deep_link: string | null;
  read_at: string | null;
  created_at: string;
};

// Reads go through the user-scoped client so the notifications RLS policy
// (profile_id = get_profile_id_for_user(auth.uid())) does the ownership check.
export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, type, subtype, related_id, deep_link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return Response.json({ notifications: notifications ?? [] }, { headers });
}

// Mark a notification read. RLS scopes the update to the owner's rows.
export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ ok: false }, { status: 401, headers });

  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  if (!id) return Response.json({ ok: false }, { status: 400, headers });

  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);

  return Response.json({ ok: !error }, { headers });
}

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

export default function NotificationsPage() {
  const { notifications } = useLoaderData() as { notifications: NotificationRow[] };
  const fetcher = useFetcher();
  const navigate = useNavigate();

  function open(n: NotificationRow) {
    if (!n.read_at) {
      fetcher.submit({ id: n.id }, { method: "post" });
    }
    if (n.deep_link) navigate(n.deep_link);
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px 80px" }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          marginBottom: 12,
          display: "block",
        }}
      >
        Notifications
      </span>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "6px 20px",
        }}
      >
        {notifications.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", padding: "32px 0" }}>
            No notifications yet
          </div>
        ) : (
          notifications.map((n, i) => {
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
          })
        )}
      </div>
    </div>
  );
}
