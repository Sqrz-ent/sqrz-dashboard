import { createSupabaseServerClient } from "~/lib/supabase.server";
import { listOpenInquiryThreadsForProfile } from "~/lib/messaging/inquiry.server";

export async function loader({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
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
    return Response.json({ threads: [] }, { headers });
  }

  try {
    const session = await listOpenInquiryThreadsForProfile(profile.id as string);
    return Response.json(session ?? { threads: [] }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load inquiry thread" },
      { status: 500, headers }
    );
  }
}
