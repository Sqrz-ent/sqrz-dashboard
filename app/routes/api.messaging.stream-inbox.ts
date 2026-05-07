import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import {
  createStreamUserToken,
  ensureBookingMainChannel,
  isStreamConfigured,
  toStreamMainChannelId,
  toStreamUserIdForProfile,
} from "~/lib/messaging/stream.server";

function displayNameFromProfile(profile: Record<string, unknown> | null) {
  if (!profile) return null;
  return (
    (profile.brand_name as string | null) ||
    (profile.name as string | null) ||
    [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
    ((profile.email as string | null)?.split("@")[0] ?? null)
  );
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Stream inbox error";
  }
}

export async function loader({ request }: { request: Request }) {
  try {
    if (!isStreamConfigured()) {
      return Response.json({ error: "Stream is not configured" }, { status: 503 });
    }

    const { supabase } = createSupabaseServerClient(request);
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await getCurrentProfile(supabase, user.id);
    if (!profile?.id) {
      return Response.json({ error: "Profile not found" }, { status: 404 });
    }

    if (profile.plan_id == null || Number(profile.plan_id) <= 0) {
      return Response.json({ error: "Stream inbox is not enabled for this user" }, { status: 409 });
    }

    const admin = createSupabaseAdminClient();
    const { data: bookings } = await admin
      .from("bookings")
      .select("id")
      .eq("owner_id", profile.id as string)
      .order("created_at", { ascending: false });

    const bookingIds = (bookings ?? []).map((booking) => booking.id as string);

    for (const bookingId of bookingIds) {
      await ensureBookingMainChannel({ admin, bookingId });
    }

    return Response.json({
      apiKey: process.env.STREAM_API_KEY,
      provider: "stream",
      streamUser: {
        id: toStreamUserIdForProfile(profile.id as string),
        name: displayNameFromProfile(profile as Record<string, unknown>) ?? "SQRZ User",
      },
      token: createStreamUserToken(toStreamUserIdForProfile(profile.id as string)),
      bookingIds,
      channelIds: bookingIds.map((bookingId) => toStreamMainChannelId(bookingId)),
      debug: {
        profileId: profile.id as string,
        bookingCount: bookingIds.length,
      },
    });
  } catch (error) {
    console.error("[stream-inbox] loader failed:", error);
    return Response.json({ error: normalizeError(error) }, { status: 500 });
  }
}
