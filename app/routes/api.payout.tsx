import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  const { booking_id } = await request.json();
  const adminClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: wallet } = await adminClient
    .from("booking_wallets")
    .select("id, total_budget, secured_amount, currency, payout_status, client_paid, sqrz_fee_pct")
    .eq("booking_id", booking_id)
    .single();

  if (!wallet) return Response.json({ error: "Wallet not found" }, { status: 404 });
  if (!wallet.client_paid) return Response.json({ error: "Not paid yet" }, { status: 400 });
  if (wallet.payout_status === "released") return Response.json({ error: "Already released" }, { status: 400 });

  // With destination charges, funds are already in the member's Connect account.
  // We just record the released amount and mark as released.
  const netAmount = Number(wallet.secured_amount) || Number(wallet.total_budget);

  await adminClient
    .from("booking_wallets")
    .update({
      payout_status: "released",
      released_amount: netAmount,
      payout_completed_at: new Date().toISOString(),
    })
    .eq("id", wallet.id);

  return Response.json({ success: true });
}
