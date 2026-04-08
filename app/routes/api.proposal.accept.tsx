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

  // 2. Get proposal details
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("*, bookings(title, owner_id, profiles(name))")
    .eq("id", proposal_id)
    .eq("booking_id", booking_id)
    .single();

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  const requiresPayment = proposal.payment_method === "stripe";

  if (requiresPayment) {
    // 3a. Stripe path — create checkout, mark proposal accepted, webhook confirms booking
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: proposal.currency.toLowerCase(),
            unit_amount: Math.round(proposal.rate * 100),
            product_data: {
              name: proposal.bookings.title,
              description: `Booking with ${proposal.bookings.profiles?.name ?? "SQRZ Member"}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${invite_token}&payment=success`,
      cancel_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${invite_token}`,
      metadata: {
        booking_id,
        invite_token,
        proposal_id,
        booking_type: "quote_accepted",
      },
      customer_email: participant.email,
    });

    // Mark proposal accepted optimistically — booking status stays 'pending' until webhook fires
    await adminClient
      .from("booking_proposals")
      .update({ status: "accepted" })
      .eq("id", proposal_id);

    return Response.json({ checkout_url: session.url });
  } else {
    // 3b. No payment needed — confirm directly, no Stripe involved
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
}
