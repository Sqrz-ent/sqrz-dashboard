import { Resend } from "resend";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function action({ request }: { request: Request }) {
  const { bookingId } = await request.json();
  if (!bookingId) return Response.json({ ok: false, error: "Missing bookingId" });

  const admin = createSupabaseAdminClient();

  // Fetch booking — check idempotency guard and get owner
  const { data: booking } = await admin
    .from("bookings")
    .select("first_reply_sent_at, owner_id, title")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return Response.json({ ok: false });
  if (booking.first_reply_sent_at) return Response.json({ ok: true }); // already sent

  // Get buyer participant email + invite_token
  const { data: buyer } = await admin
    .from("booking_participants")
    .select("email, name, invite_token")
    .eq("booking_id", bookingId)
    .eq("role", "buyer")
    .maybeSingle();

  if (!buyer?.email) return Response.json({ ok: false });

  // Get seller name from owner profile
  const { data: owner } = await admin
    .from("profiles")
    .select("name, brand_name, first_name, last_name")
    .eq("id", booking.owner_id)
    .maybeSingle();

  const sellerName =
    owner?.brand_name ||
    owner?.name ||
    [owner?.first_name, owner?.last_name].filter(Boolean).join(" ") ||
    "Your host";

  const bookingLink = buyer.invite_token
    ? `https://dashboard.sqrz.com/booking/${bookingId}?token=${buyer.invite_token}`
    : `https://dashboard.sqrz.com/booking/${bookingId}`;

  try {
    await resend.emails.send({
      from: "SQRZ <bookings@sqrz.com>",
      to: buyer.email,
      subject: `${sellerName} replied to your booking request`,
      html: `
        <p>Hi ${buyer.name || "there"},</p>
        <p><strong>${sellerName}</strong> has replied to your booking request${booking.title ? ` for <strong>${booking.title}</strong>` : ""}.</p>
        <p>
          <a href="${bookingLink}"
             style="background: #F3B130; color: #000; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">
            View conversation →
          </a>
        </p>
        <p style="color: #999; font-size: 12px;">Powered by SQRZ</p>
      `,
    });
  } catch {
    // Non-fatal — mark as sent anyway to prevent re-sends on failure
  }

  // Mark first reply as sent (outside try/catch — always stamp it)
  await admin
    .from("bookings")
    .update({ first_reply_sent_at: new Date().toISOString() })
    .eq("id", bookingId);

  return Response.json({ ok: true });
}
