import { Resend } from "resend";
import { createSupabaseAdminClient } from "~/lib/supabase.server";

const resend = new Resend(process.env.RESEND_API_KEY);

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

  const ownerName =
    owner.brand_name ||
    owner.name ||
    [owner.first_name, owner.last_name].filter(Boolean).join(" ") ||
    "there";

  const senderLabel = buyerEmail || "Your client";

  try {
    await resend.emails.send({
      from: "SQRZ <bookings@sqrz.com>",
      to: owner.email,
      subject: `New message from ${senderLabel}`,
      html: `
        <p>Hi ${ownerName},</p>
        <p><strong>${senderLabel}</strong> sent you a message about <strong>${booking.title ?? "your booking"}</strong>:</p>
        <blockquote style="border-left: 3px solid #F3B130; padding-left: 12px; color: #555;">
          "${message}"
        </blockquote>
        <p>
          <a href="https://dashboard.sqrz.com/booking/${bookingId}"
             style="background: #F3B130; color: #000; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold;">
            View conversation →
          </a>
        </p>
        <p style="color: #999; font-size: 12px;">Powered by SQRZ</p>
      `,
    });
  } catch {
    // Non-fatal — message was already sent
  }

  return Response.json({ ok: true });
}
