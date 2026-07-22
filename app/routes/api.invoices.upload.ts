import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { canManageBookingBilling } from "~/lib/delegate.server";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

// Upload a talent/provider-supplied PDF invoice for a confirmed booking and email the
// buyer that it's ready. No generation, no e-invoicing — just a stored PDF + notification.
// Gated to the booking owner (or an active billing delegate). Web callers authenticate via
// cookie session; native (sqrz-ios) callers send a Bearer token.
export async function action({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let supabase;
  let user;
  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
  } else {
    ({ supabase } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
  }
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const viewerProfile = await getCurrentProfile(supabase, user.id);
  if (!viewerProfile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();

  const formData = await request.formData();
  const booking_id = (formData.get("booking_id") as string) || null;
  const file = formData.get("file") as File | null;

  if (!booking_id) return Response.json({ error: "Missing booking_id" }, { status: 400 });
  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });
  if (file.type !== "application/pdf") {
    return Response.json({ error: "Only PDF files are allowed" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File exceeds 10 MB limit" }, { status: 400 });
  }

  const { data: booking } = await admin
    .from("bookings")
    .select("id, title, owner_id, status")
    .eq("id", booking_id)
    .maybeSingle();
  if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });

  const ownerProfileId = booking.owner_id as string;

  // Gate: owner or active delegate, and only on a confirmed/completed booking.
  const allowed = await canManageBookingBilling(admin, viewerProfile.id as string, ownerProfileId);
  if (!allowed) return Response.json({ error: "Not authorized for this booking" }, { status: 403 });
  if (!["confirmed", "completed"].includes(booking.status as string)) {
    return Response.json({ error: "Invoice can only be uploaded on a confirmed booking" }, { status: 400 });
  }

  // Store under {booking_id}/{filename}. Sanitize the filename to a safe storage key.
  const safeName = (file.name || "invoice.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${booking_id}/${safeName}`;
  const fileBuffer = await file.arrayBuffer();

  const { error: uploadError } = await admin.storage
    .from("invoices")
    .upload(storagePath, fileBuffer, { contentType: "application/pdf", upsert: true });
  if (uploadError) {
    console.error("[invoices/upload] storage error:", uploadError);
    return Response.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: invoice, error: insertError } = await admin
    .from("invoices")
    .insert({
      booking_id,
      uploaded_by: ownerProfileId,
      file_url: storagePath,
      file_name: file.name || safeName,
      file_size_bytes: file.size,
    })
    .select("id, file_name, file_size_bytes, uploaded_at, uploaded_by")
    .single();
  if (insertError || !invoice) {
    console.error("[invoices/upload] insert error:", insertError);
    return Response.json({ error: insertError?.message ?? "Failed to save invoice" }, { status: 500 });
  }

  // Notify the buyer that the invoice is ready — same Resend mechanism used elsewhere.
  try {
    const [{ data: buyer }, { data: owner }] = await Promise.all([
      admin
        .from("booking_participants")
        .select("email, invite_token")
        .eq("booking_id", booking_id)
        .eq("role", "buyer")
        .maybeSingle(),
      admin
        .from("profiles")
        .select("brand_name, name, company_name")
        .eq("id", ownerProfileId)
        .maybeSingle(),
    ]);

    const buyerEmail = buyer?.email as string | null;
    if (buyerEmail) {
      const talentName =
        (owner?.brand_name as string | null) ||
        (owner?.company_name as string | null) ||
        (owner?.name as string | null) ||
        "The talent";
      const bookingTitle = (booking.title as string | null) || "your booking";
      const bookingUrl = buyer?.invite_token
        ? `https://dashboard.sqrz.com/booking/${booking_id}?token=${buyer.invite_token}`
        : `https://dashboard.sqrz.com/booking/${booking_id}`;

      const html = `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f5f0eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;margin-top:24px;">
    <div style="padding:32px;">
      <h1 style="font-size:20px;font-weight:700;color:#0a0a0a;margin:0 0 8px;">Invoice uploaded</h1>
      <p style="color:#444;font-size:15px;line-height:1.5;margin:0 0 24px;">
        ${talentName} has uploaded an invoice for the booking <strong>${bookingTitle}</strong>.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${bookingUrl}" style="background:#F3B130;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
          View Booking →
        </a>
      </div>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eee;text-align:center;">
      <p style="color:#ccc;font-size:11px;margin:0;">Powered by <a href="https://sqrz.com" style="color:#F3B130;text-decoration:none;">SQRZ</a></p>
    </div>
  </div>
</body>
</html>`;

      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: buyerEmail,
        subject: `Invoice uploaded for ${bookingTitle}`,
        html,
      });
    }
  } catch (err) {
    console.error("[invoices/upload] email send failed:", err);
  }

  return Response.json({ ok: true, invoice });
}
