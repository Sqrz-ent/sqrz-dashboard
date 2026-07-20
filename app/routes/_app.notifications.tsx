import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.notifications";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { NotificationList, type NotificationRow } from "~/components/NotificationList";

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

export default function NotificationsPage() {
  const { notifications } = useLoaderData() as { notifications: NotificationRow[] };

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
        <NotificationList notifications={notifications} />
      </div>
    </div>
  );
}
