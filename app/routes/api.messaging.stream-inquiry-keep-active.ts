import { createSupabaseAdminClient, createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";

// "Keep Active" action for an inquiry thread. Lightweight: upserts the corresponding
// `leads` row as active and bumps its updated_at so it sorts to the top of the Active
// list. The thread itself is NOT closed. Dual-auth (cookie web + Bearer native).
export async function action({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let headers = new Headers();
  let user;

  if (bearerToken) {
    const supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
  } else {
    const { supabase: cookieClient, headers: cookieHeaders } = createSupabaseServerClient(request);
    headers = cookieHeaders;
    ({ data: { user } } = await cookieClient.auth.getUser());
  }

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const body = await request.json();
  const threadId = String(body?.threadId ?? "");
  if (!threadId) {
    return Response.json({ error: "Missing threadId" }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile?.id) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  const { data: thread } = await admin
    .from("profile_inquiry_threads")
    .select("id, profile_id, visitor_name, visitor_email")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread || thread.profile_id !== profile.id) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }

  // Upsert the lead as active. On conflict the UPDATE fires the leads_updated_at
  // trigger, bumping updated_at → sorts to the top of the Active list. Thread stays open.
  const { error: leadError } = await admin
    .from("leads")
    .upsert(
      {
        thread_id: threadId,
        profile_id: profile.id,
        name: thread.visitor_name,
        email: thread.visitor_email,
        source: "chat",
        status: "active",
      },
      { onConflict: "thread_id" },
    );

  if (leadError) {
    return Response.json({ error: leadError.message }, { status: 500, headers });
  }

  return Response.json({ ok: true }, { headers });
}
