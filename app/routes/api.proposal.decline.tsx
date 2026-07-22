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

  // ── State validation ──────────────────────────────────────────────────────
  // Decline is only valid while the booking is awaiting a proposal decision.
  // Confirmed/completed/cancelled/archived bookings must not be flipped to
  // 'cancelled' by a stale or replayed link action.
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, status")
    .eq("id", booking_id)
    .single();

  if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
  if (booking.status !== "pending") {
    return Response.json(
      { error: `Booking is '${booking.status}' — proposal can no longer be declined` },
      { status: 409 }
    );
  }

  // Get latest proposal to decline — it must still be awaiting a decision.
  const { data: latest } = await adminClient
    .from("booking_proposals")
    .select("id, status")
    .eq("booking_id", booking_id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (!latest) {
    return Response.json({ error: "No proposal to decline" }, { status: 409 });
  }
  if (latest.status !== "sent") {
    return Response.json(
      { error: `Proposal is '${latest.status}' — only a sent proposal can be declined` },
      { status: 409 }
    );
  }

  await adminClient
    .from("booking_proposals")
    .update({ status: "declined" })
    .eq("id", latest.id);

  await adminClient
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", booking_id);

  return Response.json({ success: true });
}
