import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { resolveMessagingProviderForBooking } from "~/lib/messaging/provider-resolver.server";
import {
  createStreamUserToken,
  ensureBookingMainChannel,
  isStreamConfigured,
  resolveStreamIdentityForParticipant,
  toStreamMainChannelId,
  toStreamUserIdForProfile,
} from "~/lib/messaging/stream.server";

function displayNameFromProfile(profile: Record<string, unknown> | null) {
  if (!profile) return null;
  return (
    (profile.brand_name as string | null) ||
    (profile.name as string | null) ||
    ((profile.email as string | null)?.split("@")[0] ?? null)
  );
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Stream error";
  }
}

export async function loader({ request }: { request: Request }) {
  try {
    if (!isStreamConfigured()) {
      return Response.json({ error: "Stream is not configured" }, { status: 503 });
    }

    const url = new URL(request.url);
    const bookingId = url.searchParams.get("bookingId");
    const inviteToken = url.searchParams.get("token");

    // No bookingId — return a user-level token only (used by Office for client-level subscriptions).
    if (!bookingId) {
      const { supabase } = createSupabaseServerClient(request);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const profile = await getCurrentProfile(supabase, user.id);
      if (!profile?.id) return Response.json({ error: "Profile not found" }, { status: 404 });

      const streamUserId = toStreamUserIdForProfile(profile.id as string);
      return Response.json({
        apiKey: process.env.STREAM_API_KEY,
        streamUser: {
          id: streamUserId,
          name: displayNameFromProfile(profile as Record<string, unknown>) ?? "SQRZ User",
        },
        token: createStreamUserToken(streamUserId),
      });
    }

    const admin = createSupabaseAdminClient();
    const provider = await resolveMessagingProviderForBooking({ admin, bookingId });

    if (provider !== "stream") {
      return Response.json({ error: "Stream is not enabled for this booking" }, { status: 409 });
    }

    if (inviteToken) {
      const { data: participant } = await admin
        .from("booking_participants")
        .select("id, booking_id, email, name, role, user_id")
        .eq("booking_id", bookingId)
        .eq("invite_token", inviteToken)
        .maybeSingle();

      if (!participant) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const streamIdentity = await resolveStreamIdentityForParticipant({
        admin,
        participantId: participant.id as string,
        linkedUserId: (participant.user_id as string | null) ?? null,
      });

      await ensureBookingMainChannel({ admin, bookingId });

      return Response.json({
        apiKey: process.env.STREAM_API_KEY,
        provider: "stream",
        bookingId,
        channelId: toStreamMainChannelId(bookingId),
        streamUser: {
          id: streamIdentity.streamUserId,
          name:
            (participant.name as string | null) ||
            ((participant.email as string | null)?.split("@")[0] ?? "Guest"),
        },
        token: createStreamUserToken(streamIdentity.streamUserId),
      });
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

    const [{ data: booking }, { data: participantByUserId }, { data: participantByEmail }] = await Promise.all([
      admin
        .from("bookings")
        .select("id, owner_id")
        .eq("id", bookingId)
        .maybeSingle(),
      admin
        .from("booking_participants")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("user_id", user.id)
        .limit(1),
      profile.email
        ? admin
            .from("booking_participants")
            .select("id")
            .eq("booking_id", bookingId)
            .eq("email", profile.email as string)
            .limit(1)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

    const isOwner = booking?.owner_id === profile.id;
    const isParticipant =
      !!participantByUserId && participantByUserId.length > 0 ||
      !!participantByEmail && participantByEmail.length > 0;

    if (!isOwner && !isParticipant) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    await ensureBookingMainChannel({ admin, bookingId });

    return Response.json({
      apiKey: process.env.STREAM_API_KEY,
      provider: "stream",
      bookingId,
      channelId: toStreamMainChannelId(bookingId),
      streamUser: {
        id: toStreamUserIdForProfile(profile.id as string),
        name: displayNameFromProfile(profile as Record<string, unknown>) ?? "SQRZ User",
      },
      token: createStreamUserToken(toStreamUserIdForProfile(profile.id as string)),
    });
  } catch (error) {
    console.error("[stream-token] loader failed:", error);
    return Response.json({ error: normalizeError(error) }, { status: 500 });
  }
}
