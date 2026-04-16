import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const { booking_id, invite_token } = await request.json();

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("id")
    .eq("booking_id", booking_id)
    .eq("invite_token", invite_token)
    .eq("role", "buyer")
    .single();

  if (!participant) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Get latest proposal ID to decline
  const { data: latest } = await adminClient
    .from("booking_proposals")
    .select("id")
    .eq("booking_id", booking_id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (latest) {
    await adminClient
      .from("booking_proposals")
      .update({ status: "declined" })
      .eq("id", latest.id);
  }

  await adminClient
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", booking_id);

  return Response.json({ success: true });
}
