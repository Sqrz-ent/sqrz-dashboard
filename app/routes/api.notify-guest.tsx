import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function action({ request }: { request: Request }) {
  const { bookingId, guestEmail, guestName, memberName, message } =
    await request.json();

  if (!guestEmail) {
    return Response.json({ ok: false, error: "No guest email" });
  }

  await resend.emails.send({
    from: "noreply@sqrz.com",
    to: guestEmail,
    subject: `${memberName} replied to your message`,
    html: `
      <p>Hi ${guestName || "there"},</p>
      <p><strong>${memberName}</strong> replied to your message:</p>
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

  return Response.json({ ok: true });
}
