import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export async function action({ request }: { request: Request }) {
  const { booking_id } = await request.json();

  if (!booking_id) {
    return Response.json({ error: "booking_id required" }, { status: 400 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get wallet + owner profile + connect ID
  const { data: wallet } = await adminClient
    .from("booking_wallets")
    .select("id, total_budget, secured_amount, currency, payout_status, client_paid, sqrz_fee_pct, profiles!owner_profile_id(stripe_connect_id, plan_id, plans(booking_fee_pct))")
    .eq("booking_id", booking_id)
    .maybeSingle();

  if (!wallet) return Response.json({ error: "Wallet not found" }, { status: 404 });
  if (wallet.payout_status === "released")
    return Response.json({ error: "Already paid out" }, { status: 400 });
  if (!wallet.client_paid)
    return Response.json({ error: "Client has not paid yet" }, { status: 400 });

  type WalletProfile = { stripe_connect_id?: string | null; plan_id?: number | null; plans?: { booking_fee_pct?: number } | null };
  const profile = wallet.profiles as WalletProfile | null;

  const connectId = profile?.stripe_connect_id;
  // Member receives exactly their rate (secured_amount). SQRZ keeps the difference.
  const netAmount = Math.round((wallet.secured_amount ?? wallet.total_budget ?? 0) * 100) / 100;

  if (!connectId) return Response.json({ error: "No Connect account" }, { status: 400 });

  // Create Stripe transfer (test mode)
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);

  const transfer = await stripe.transfers.create({
    amount: Math.round(netAmount * 100),
    currency: (wallet.currency ?? "eur").toLowerCase(),
    destination: connectId,
    transfer_group: booking_id,
    metadata: { booking_id, wallet_id: String(wallet.id) },
  });

  // Update wallet
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
