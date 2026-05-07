import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const body = await request.json();
  const threadId = String(body?.threadId ?? "");
  const status = String(body?.status ?? "");

  if (!threadId || !["closed", "converted"].includes(status)) {
    return Response.json({ error: "Invalid request" }, { status: 400, headers });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, plan_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile?.id) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  if (profile.plan_id == null || Number(profile.plan_id) <= 0) {
    return Response.json({ error: "Premium plan required" }, { status: 403, headers });
  }

  const admin = createSupabaseAdminClient();
  const { data: thread } = await admin
    .from("profile_inquiry_threads")
    .select("id, profile_id")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread || thread.profile_id !== profile.id) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }

  const { error } = await admin
    .from("profile_inquiry_threads")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers });
  }

  return Response.json({ ok: true }, { headers });
}
