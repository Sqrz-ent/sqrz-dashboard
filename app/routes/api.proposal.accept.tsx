import Stripe from "stripe";
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

  // 2. Get proposal details including line_items
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("rate, currency, requires_payment, booking_id, line_items, bookings(title, owner_id, profiles(name))")
    .eq("id", proposal_id)
    .eq("booking_id", booking_id)
    .single();

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  const bk = proposal.bookings as unknown as { title: string; owner_id: string; profiles?: { name?: string } | null };

  // 3. Fetch member's Connect account + plan fee percentage
  const { data: ownerProfile } = await adminClient
    .from("profiles")
    .select("stripe_connect_id, plan_id, plans(booking_fee_pct)")
    .eq("id", bk.owner_id)
    .single();

  const planId: number | null = (ownerProfile?.plan_id as number | null) ?? null;
  const planFeePct: number = (ownerProfile?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 8;
  // Free users (plan_id=null) or manual payments get 0% fee
  const feePct: number = (planId === null || proposal.requires_payment === false) ? 0 : planFeePct;
  const connectId: string | null = ownerProfile?.stripe_connect_id ?? null;

  // Amount calculations (in cents)
  const rate = proposal.rate;
  const feeAmount = Math.round(rate * feePct / 100 * 100);
  const totalAmount = Math.round(rate * 100) + feeAmount;

  console.log("[accept] requires_payment:", proposal.requires_payment, "feePct:", feePct, "rate:", rate, "total:", totalAmount / 100, "connectId:", connectId);

  if (proposal.requires_payment === true) {
    // Stripe destination charge — fee stays on platform, net goes directly to member's Connect account
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: proposal.currency.toLowerCase(),
            unit_amount: totalAmount,
            product_data: {
              name: bk.title,
              description: `Booking with ${bk.profiles?.name ?? "SQRZ Member"}`,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: connectId
        ? {
            application_fee_amount: feeAmount,
            transfer_data: { destination: connectId },
          }
        : undefined,
      success_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${invite_token}&payment=success`,
      cancel_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${invite_token}`,
      metadata: {
        booking_id,
        invite_token,
        proposal_id,
        booking_type: "quote_accepted",
        owner_profile_id: bk.owner_id,
        rate: rate.toString(),
        fee_pct: feePct.toString(),
      },
      customer_email: participant.email,
    });

    // Do NOT update proposal status here — webhook sets it to 'accepted' after payment
    return Response.json({ checkout_url: session.url });
  } else {
    // No payment needed — confirm directly
    await adminClient
      .from("booking_proposals")
      .update({ status: "accepted" })
      .eq("id", proposal_id);

    await adminClient
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", booking_id);

    // Create wallet + allocations from line_items
    try {
      const ownerProfileId = bk.owner_id;

      const { data: existingWallet } = await adminClient
        .from("booking_wallets")
        .select("id")
        .eq("booking_id", booking_id)
        .maybeSingle();

      let walletId: string | null = existingWallet?.id ?? null;

      if (!walletId) {
        const { data: newWallet } = await adminClient
          .from("booking_wallets")
          .insert({
            booking_id,
            owner_profile_id: ownerProfileId,
            total_budget: proposal.rate ?? 0,
            secured_amount: proposal.rate ?? 0,
            currency: proposal.currency ?? "EUR",
            sqrz_fee_pct: feePct,
            status: "open",
            client_paid: false,
            payout_status: "pending",
          })
          .select("id")
          .single();
        walletId = newWallet?.id ?? null;
      }

      const lineItems = proposal.line_items as Array<{ label: string; type: string; amount: number }> | null;
      if (walletId && lineItems?.length) {
        await adminClient.from("wallet_allocations").insert(
          lineItems.map((item) => ({
            wallet_id: walletId,
            allocation_type: item.type,
            label: item.label,
            role: item.label,
            amount: item.amount,
            currency: proposal.currency ?? "EUR",
            status: "pending",
          }))
        );
      }
    } catch (err) {
      console.error("[accept] wallet/allocation creation failed:", err);
    }

    return Response.json({ confirmed: true });
  }
}
