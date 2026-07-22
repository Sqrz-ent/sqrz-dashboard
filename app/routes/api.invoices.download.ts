import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Return a fresh 60-minute signed URL for an uploaded invoice PDF, but only to a party of
// the booking. Two ways to be a party:
//   • authenticated: the booking owner, or a booking_participants row linked to auth.uid()
//   • token buyer (no session): a booking_token (invite_token) matching a participant row
// Web owners use cookie session; native callers a Bearer token; buyers pass booking_token.
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

  const body = (await request.json().catch(() => ({}))) as {
    invoice_id?: string;
    booking_token?: string | null;
  };
  const invoice_id = body.invoice_id;
  const booking_token = body.booking_token ?? null;
  if (!invoice_id) return Response.json({ error: "Missing invoice_id" }, { status: 400 });

  const admin = createSupabaseAdminClient();

  const { data: invoice } = await admin
    .from("invoices")
    .select("id, booking_id, file_url")
    .eq("id", invoice_id)
    .maybeSingle();
  if (!invoice) return Response.json({ error: "Invoice not found" }, { status: 404 });

  const bookingId = invoice.booking_id as string;

  // Verify the caller is a party to the booking.
  let authorized = false;

  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);
    const { data: booking } = await admin
      .from("bookings")
      .select("owner_id")
      .eq("id", bookingId)
      .maybeSingle();
    if (profile && booking && booking.owner_id === profile.id) {
      authorized = true;
    } else {
      const { data: participant } = await admin
        .from("booking_participants")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
      authorized = !!participant;
    }
  }

  if (!authorized && booking_token) {
    const { data: tokenParticipant } = await admin
      .from("booking_participants")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("invite_token", booking_token)
      .limit(1)
      .maybeSingle();
    authorized = !!tokenParticipant;
  }

  if (!authorized) return Response.json({ error: "Not authorized for this booking" }, { status: 403 });

  const { data: signed, error: signedError } = await admin.storage
    .from("invoices")
    .createSignedUrl(invoice.file_url as string, 60 * 60); // 60 minutes
  if (signedError || !signed?.signedUrl) {
    console.error("[invoices/download] signed URL error:", signedError);
    return Response.json({ error: "Failed to generate download link" }, { status: 500 });
  }

  return Response.json({ signed_url: signed.signedUrl });
}
