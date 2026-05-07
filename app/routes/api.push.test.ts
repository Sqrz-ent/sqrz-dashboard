import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { isPushConfigured, sendNotificationEvent } from "~/lib/push.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  if (!isPushConfigured()) {
    return Response.json({ error: "Web Push is not configured" }, { status: 503, headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile?.id) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  try {
    const result = await sendNotificationEvent({
      profileId: profile.id as string,
      recipientProfileId: profile.id as string,
      actorProfileId: profile.id as string,
      type: "inquiry_message",
      sourceId: "push-test",
      title: "SQRZ notifications are on",
      body: "You will get instant alerts here when new inquiries arrive.",
      targetUrl: "/service",
    });

    return Response.json({ ok: true, sent: result.sent, eventId: result.eventId }, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to send test notification" },
      { status: 500, headers }
    );
  }
}
