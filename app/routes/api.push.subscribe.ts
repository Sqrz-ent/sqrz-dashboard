import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { savePushSubscription } from "~/lib/push.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile?.id) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  const body = await request.json();
  const endpoint = String(body?.endpoint ?? "");
  const p256dh = String(body?.keys?.p256dh ?? "");
  const auth = String(body?.keys?.auth ?? "");

  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: "Invalid subscription payload" }, { status: 400, headers });
  }

  try {
    await savePushSubscription({
      profileId: profile.id as string,
      userId: user.id,
      endpoint,
      p256dh,
      auth,
      platform: typeof body?.platform === "string" ? body.platform : null,
      userAgent: typeof body?.userAgent === "string" ? body.userAgent : null,
      appScope: typeof body?.appScope === "string" ? body.appScope : null,
    });

    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to save subscription" },
      { status: 500, headers }
    );
  }
}
