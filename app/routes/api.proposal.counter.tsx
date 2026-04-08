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

  // Get current proposal version
  const { data: current } = await adminClient
    .from("booking_proposals")
    .select("version, id")
    .eq("booking_id", booking_id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

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
