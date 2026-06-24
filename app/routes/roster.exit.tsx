import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { clearActingAsCookie } from "~/lib/agent.server";

export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/**
 * POST /roster/exit — stop managing a talent and return to your own profile.
 * Clears acting_as_profile_id from the session and redirects to the roster.
 */
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { supabase, headers } = createSupabaseServerClient(request);
  // Requires a session, but no delegation check — exiting is always allowed.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  headers.append("Set-Cookie", clearActingAsCookie());
  return redirect("/roster", { headers });
}
