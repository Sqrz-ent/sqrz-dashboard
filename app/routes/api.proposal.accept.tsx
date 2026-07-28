import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const { booking_id, proposal_id, invite_token } = await request.json();

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Verify token is valid for this booking
  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("email, name, invite_token")
    .eq("booking_id", booking_id)
    .eq("invite_token", invite_token)
    .eq("role", "buyer")
    .single();

  if (!participant) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get proposal details
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("id, status, sent_by, version, booking_id, bookings(title, owner_id, status, profiles(name))")
    .eq("id", proposal_id)
    .eq("booking_id", booking_id)
    .single();

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  const bk = proposal.bookings as unknown as { title: string; owner_id: string; status: string; profiles?: { name?: string } | null };

  // ── State validation ──────────────────────────────────────────────────────
  // Idempotency: booking already confirmed/completed → repeat accept is a no-op.
  // Return the existing state; never re-run status updates.
  if (bk.status === "confirmed" || bk.status === "completed") {
    return Response.json({ confirmed: true, idempotent: true });
  }

  // Accept is only valid while the booking is awaiting a proposal decision.
  if (bk.status !== "pending") {
    return Response.json(
      { error: `Booking is '${bk.status}' — proposal can no longer be accepted` },
      { status: 409 }
    );
  }

  // The target proposal must be the ACTIVE one: latest version for this booking,
  // still 'sent', and sent by the member (a buyer cannot accept their own counter).
  const { data: latestProposal } = await adminClient
    .from("booking_proposals")
    .select("id")
    .eq("booking_id", booking_id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  if (!latestProposal || latestProposal.id !== proposal.id) {
    return Response.json(
      { error: "A newer proposal version exists — refresh and review the latest proposal" },
      { status: 409 }
    );
  }
  if (proposal.status !== "sent") {
    return Response.json(
      { error: `Proposal is '${proposal.status}' — only a sent proposal can be accepted` },
      { status: 409 }
    );
  }
  if (proposal.sent_by !== "member") {
    return Response.json(
      { error: "Only the member's proposal can be accepted" },
      { status: 409 }
    );
  }

  await adminClient
    .from("booking_proposals")
    .update({ status: "accepted" })
    .eq("id", proposal_id);

  await adminClient
    .from("bookings")
    .update({ status: "confirmed" })
    .eq("id", booking_id);

  return Response.json({ confirmed: true });
}
