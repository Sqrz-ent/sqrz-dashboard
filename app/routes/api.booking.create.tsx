import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404, headers });

  const body = await request.json();
  const {
    client_name,
    client_email,
    title,
    service,
    date_start,
    venue,
    city,
    description,
    // Proposal fields (optional)
    include_proposal,
    rate,
    currency,
    line_items,
    proposal_message,
    requires_payment,
  } = body;

  if (!client_name || !client_email || !title) {
    return Response.json({ error: "Missing required fields" }, { status: 400, headers });
  }

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // a. Insert booking
  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .insert({
      owner_id: profile.id,
      title,
      service: service || null,
      status: include_proposal && rate ? "pending" : "requested",
      date_start: date_start || null,
      venue: venue || null,
      city: city || null,
      description: description || null,
    })
    .select("id")
    .single();

  if (bookingError || !booking) {
    console.error("[booking.create] booking insert failed:", bookingError);
    return Response.json({ error: "Failed to create booking" }, { status: 500, headers });
  }

  const bookingId = booking.id;

  // b. Generate invite token (32-char hex)
  const inviteToken: string = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // c. Insert buyer participant
  const { error: participantError } = await admin
    .from("booking_participants")
    .insert({
      booking_id: bookingId,
      email: client_email,
      name: client_name,
      role: "buyer",
      invite_token: inviteToken,
      is_admin: false,
    });

  if (participantError) {
    console.error("[booking.create] participant insert failed:", participantError);
    return Response.json({ error: "Failed to add client" }, { status: 500, headers });
  }

  // d. Insert proposal if included
  if (include_proposal && rate) {
    await admin.from("booking_proposals").insert({
      booking_id: bookingId,
      rate: parseFloat(String(rate)),
      currency: currency ?? "EUR",
      message: proposal_message || null,
      line_items: line_items?.length ? line_items : null,
      requires_payment: requires_payment ?? false,
      status: "sent",
      sent_by: "member",
      version: 1,
    });
  }

  // e. Send email to client via Resend
  const memberName = (profile.name as string | null) ?? (profile.first_name as string | null) ?? "Your booking partner";
  const accessUrl = `https://dashboard.sqrz.com/booking/${bookingId}?token=${inviteToken}`;

  const proposalLine = include_proposal && rate
    ? `<p style="margin:0 0 16px;color:#444;">You have a proposal to review — total rate: <strong>${(currency ?? "EUR").toUpperCase()} ${parseFloat(String(rate)).toLocaleString()}</strong></p>`
    : "";

  const emailHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#0a0a0a;padding:32px;text-align:center;">
      <img src="https://sqrz.com/brand/sqrz_logo.png" alt="SQRZ" style="height:32px;" />
    </div>
    <div style="padding:32px;">
      <p style="color:#666;font-size:14px;margin:0 0 8px;">Hi ${client_name},</p>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 20px;color:#0a0a0a;">
        ${memberName} has prepared a booking for you
      </h1>
      <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:0.06em;">Project</p>
        <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#0a0a0a;">${title}</p>
        ${service ? `<p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:0.06em;">Service</p><p style="margin:0 0 16px;font-size:14px;color:#0a0a0a;">${service}</p>` : ""}
        ${proposalLine}
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="${accessUrl}" style="background:#F3B130;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
          View Your Booking →
        </a>
      </div>
      <p style="color:#999;font-size:12px;text-align:center;">
        This link gives you direct access — no login needed.
      </p>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eee;text-align:center;">
      <p style="color:#ccc;font-size:11px;margin:0;">Powered by <a href="https://sqrz.com" style="color:#F3B130;text-decoration:none;">SQRZ</a></p>
    </div>
  </div>
</body>
</html>`;

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "SQRZ <bookings@sqrz.com>",
      to: client_email,
      subject: `${memberName} has prepared a booking for you`,
      html: emailHtml,
    });
  } catch (err) {
    console.error("[booking.create] email send failed:", err);
    // Non-fatal — booking still created
  }

  return Response.json({ success: true, booking_id: bookingId, invite_token: inviteToken }, { headers });
}
