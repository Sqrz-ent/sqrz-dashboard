import { sendNotificationEvent } from "~/lib/push.server";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

export async function action({ request }: { request: Request }) {
  const { bookingId, buyerEmail, message } = await request.json();

  if (!bookingId) return Response.json({ ok: false, error: "Missing bookingId" });

  const admin = createSupabaseAdminClient();

  // Fetch booking + owner profile in two steps to avoid FK hint ambiguity
  const { data: booking } = await admin
    .from("bookings")
    .select("title, owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking?.owner_id) return Response.json({ ok: false });

  const { data: owner } = await admin
    .from("profiles")
    .select("email, name, brand_name, first_name, last_name")
    .eq("id", booking.owner_id)
    .maybeSingle();

  if (!owner?.email) return Response.json({ ok: false });

  const senderLabel = buyerEmail || "Your client";
  const messagePreview = typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 160) : "";

  try {
    await sendNotificationEvent({
      profileId: booking.owner_id as string,
      recipientProfileId: booking.owner_id as string,
      actorProfileId: null,
      type: "booking_message",
      sourceId: bookingId,
      title: `New booking message from ${senderLabel}`,
      body: messagePreview || `New message about ${booking.title ?? "your booking"}`,
      targetUrl: `/booking/${bookingId}`,
    });
  } catch {
    // Non-fatal — chat delivery already succeeded and push may not be available.
  }

  return Response.json({ ok: true });
}
