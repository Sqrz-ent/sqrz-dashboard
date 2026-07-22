import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const { booking_id, proposal_id, invite_token, rate, currency, message } =
    await request.json();

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Verify token
  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("id")
    .eq("booking_id", booking_id)
    .eq("invite_token", invite_token)
    .eq("role", "buyer")
    .single();

  if (!participant) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // ── State validation ──────────────────────────────────────────────────────
  // Counter is only valid while the booking is awaiting a proposal decision.
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, status")
    .eq("id", booking_id)
    .single();

  if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
  if (booking.status !== "pending") {
    return Response.json(
      { error: `Booking is '${booking.status}' — proposal can no longer be countered` },
      { status: 409 }
    );
  }

  // Get current proposal version — the proposal being countered must be the
  // latest version FOR THIS BOOKING and still awaiting a decision. This also
  // prevents the update below from touching a proposal on another booking.
  const { data: current } = await adminClient
    .from("booking_proposals")
    .select("version, id, status")
    .eq("booking_id", booking_id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (!current) {
    return Response.json({ error: "No proposal to counter" }, { status: 409 });
  }
  if (current.id !== proposal_id) {
    return Response.json(
      { error: "A newer proposal version exists — refresh and review the latest proposal" },
      { status: 409 }
    );
  }
  if (current.status !== "sent") {
    return Response.json(
      { error: `Proposal is '${current.status}' — only a sent proposal can be countered` },
      { status: 409 }
    );
  }

  // Mark current proposal as countered
  await adminClient
    .from("booking_proposals")
    .update({ status: "countered" })
    .eq("id", proposal_id);

  // Insert new proposal version from buyer
  await adminClient.from("booking_proposals").insert({
    booking_id,
    rate,
    currency,
    message,
    status: "sent",
    sent_by: "buyer",
    version: (current?.version ?? 1) + 1,
    parent_proposal_id: proposal_id,
  });

  return Response.json({ success: true });
}
