import { createSupabaseServerClient } from "~/lib/supabase.server";
import { deactivatePushSubscription } from "~/lib/push.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const body = await request.json();
  const endpoint = String(body?.endpoint ?? "");

  if (!endpoint) {
    return Response.json({ error: "Missing endpoint" }, { status: 400, headers });
  }

  try {
    await deactivatePushSubscription(endpoint);
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to disable subscription" },
      { status: 500, headers }
    );
  }
}
