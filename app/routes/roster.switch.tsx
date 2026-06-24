import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getOwnerProfile } from "~/lib/profile.server";
import { canManage, setActingAsCookie } from "~/lib/agent.server";

export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/**
 * POST /roster/switch — begin managing a talent profile.
 * Writes acting_as_profile_id into the session cookie (after validating the
 * delegation) and redirects into the dashboard, now acting as the talent.
 */
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const owner = await getOwnerProfile(supabase, user.id);
  if (!owner) return redirect("/login", { headers });

  const formData = await request.formData();
  const targetId = (formData.get("profileId") as string | null)?.trim() ?? "";
  if (!targetId) {
    return Response.json({ error: "profileId is required" }, { status: 400 });
  }

  const allowed = await canManage(owner.id as string, targetId);
  if (!allowed) {
    return Response.json({ error: "You do not manage this profile" }, { status: 403 });
  }

  headers.append("Set-Cookie", setActingAsCookie(targetId));
  return redirect("/", { headers });
}
