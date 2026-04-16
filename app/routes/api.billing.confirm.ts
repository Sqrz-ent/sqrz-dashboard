import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const {
    booking_id,
    invite_token,
    billing_company,
    billing_address,
    billing_city,
    billing_country,
    billing_vat_id,
  } = await request.json();

  if (!booking_id || !invite_token) {
    return Response.json({ error: "Missing booking_id or invite_token" }, { status: 400 });
  }

  // Verify token is valid for this booking
  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("id")
    .eq("booking_id", booking_id)
    .eq("invite_token", invite_token)
    .eq("role", "buyer")
    .single();

  if (!participant) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await adminClient
    .from("booking_participants")
    .update({
      billing_company: billing_company || null,
      billing_address: billing_address || null,
      billing_city: billing_city || null,
      billing_country: billing_country || null,
      billing_vat_id: billing_vat_id || null,
      billing_confirmed: true,
    })
    .eq("id", participant.id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
