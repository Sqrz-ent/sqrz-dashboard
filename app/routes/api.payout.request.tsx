import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const { booking_id } = await request.json();

  if (!booking_id) {
    return Response.json({ error: "booking_id required" }, { status: 400 });
  }

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Get wallet
  const { data: wallet } = await admin
    .from("booking_wallets")
    .select("id, total_budget, currency, payout_status, client_paid, owner_profile_id")
    .eq("booking_id", booking_id)
    .maybeSingle();

  if (!wallet) {
    return Response.json({ error: "Wallet not found" }, { status: 404 });
  }

  if (!wallet.client_paid) {
    return Response.json({ error: "Client has not paid yet" }, { status: 400 });
  }

  if (wallet.payout_status === "released") {
    return Response.json({ error: "Payout already released" }, { status: 400 });
  }

  // 2. Get member's stripe_connect_id
  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_connect_id, stripe_connect_status")
    .eq("id", wallet.owner_profile_id)
    .maybeSingle();

  if (!profile?.stripe_connect_id) {
    return Response.json({ error: "No Stripe Connect account found" }, { status: 400 });
  }

  // 3. Calculate net amount (total_budget minus 10% SQRZ fee)
  const total = wallet.total_budget ?? 0;
  const netAmount = Math.round(total * 0.9 * 100) / 100;
  const currency = (wallet.currency ?? "EUR").toLowerCase();

  // 4. Create Stripe Transfer (test mode)
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);
  const transfer = await stripe.transfers.create({
    amount: Math.round(netAmount * 100),
    currency,
    destination: profile.stripe_connect_id,
    transfer_group: booking_id,
    metadata: {
      booking_id,
      wallet_id: wallet.id,
    },
  });

  // 5. Update wallet: payout_status='released'
  await admin
    .from("booking_wallets")
    .update({
      payout_status: "released",
      released_amount: netAmount,
      payout_completed_at: new Date().toISOString(),
    })
    .eq("id", wallet.id);

  return Response.json({ success: true, transfer_id: transfer.id });
}
