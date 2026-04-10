import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  const { booking_id } = await request.json();
  const adminClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: wallet } = await adminClient
    .from("booking_wallets")
    .select(`*, profiles!owner_profile_id(stripe_connect_id, plan_id, plans(booking_fee_pct))`)
    .eq("booking_id", booking_id)
    .single();

  if (!wallet) return Response.json({ error: "Wallet not found" }, { status: 404 });
  if (!wallet.client_paid) return Response.json({ error: "Not paid yet" }, { status: 400 });
  if (wallet.payout_status === "released") return Response.json({ error: "Already paid out" }, { status: 400 });

  const connectId = wallet.profiles?.stripe_connect_id;
  if (!connectId) return Response.json({ error: "No Connect account" }, { status: 400 });

  const netAmount = Number(wallet.secured_amount) || Number(wallet.total_budget) * 0.9;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);

  const transfer = await stripe.transfers.create({
    amount: Math.round(netAmount * 100),
    currency: wallet.currency ?? "eur",
    destination: connectId,
    transfer_group: booking_id,
    metadata: { booking_id, wallet_id: String(wallet.id) },
  });

  await adminClient
    .from("booking_wallets")
    .update({
      payout_status: "released",
      released_amount: netAmount,
      payout_completed_at: new Date().toISOString(),
    })
    .eq("id", wallet.id);

  return Response.json({ success: true, transfer_id: transfer.id });
}
