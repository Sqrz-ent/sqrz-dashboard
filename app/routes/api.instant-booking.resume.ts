import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const formData = await request.formData();
  const booking_id = formData.get("booking_id") as string | null;
  const token = formData.get("token") as string | null;

  if (!booking_id || !token) {
    return Response.json({ error: "Missing booking_id or token" }, { status: 400 });
  }

  // 1. Verify token matches a buyer participant for this booking
  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("id, name, email")
    .eq("booking_id", booking_id)
    .eq("invite_token", token)
    .eq("role", "buyer")
    .single();

  if (!participant) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Fetch the booking + owner profile + service details
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, service, owner_id, status")
    .eq("id", booking_id)
    .single();

  if (!booking || booking.status !== "pending_payment") {
    return Response.json({ error: "Booking not found or not in pending_payment state" }, { status: 404 });
  }

  const { data: ownerProfile } = await adminClient
    .from("profiles")
    .select("plan_id, stripe_connect_id, slug")
    .eq("id", booking.owner_id)
    .single();

  if (!ownerProfile) {
    return Response.json({ error: "Owner profile not found" }, { status: 404 });
  }

  const { data: service } = await adminClient
    .from("profile_services")
    .select("instant_price, instant_currency, instant_tax_rate, title")
    .eq("profile_id", booking.owner_id)
    .eq("title", booking.service)
    .single();

  if (!service || service.instant_price == null) {
    return Response.json({ error: "Service not found or not an instant service" }, { status: 404 });
  }

  // 3. Recalculate total
  const planId: number | null = (ownerProfile.plan_id as number | null) ?? null;
  const sqrzFeeRate = planId === 5 ? 0.03 : planId === 1 ? 0.05 : 0.00;
  const net = Number(service.instant_price);
  const taxRate = (Number(service.instant_tax_rate ?? 0)) / 100;
  const tax = net * taxRate;
  const sqrzFee = net * sqrzFeeRate;
  const total = net + tax + sqrzFee;
  const unit_amount = Math.round(total * 100);
  const application_fee_amount = Math.round(sqrzFee * 100);

  const currency = ((service.instant_currency as string | null) || "EUR").toLowerCase();
  const connectId: string | null = (ownerProfile.stripe_connect_id as string | null) ?? null;
  const slug: string = (ownerProfile.slug as string) ?? "";

  // 4. Create new Stripe Checkout Session
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const metadata: Record<string, string> = {
    booking_id,
    booking_type: "instant",
    owner_profile_id: booking.owner_id,
    rate: net.toString(),
    fee_pct: (sqrzFeeRate * 100).toString(),
    tax_pct: (taxRate * 100).toString(),
    tax_amount: tax.toFixed(2),
    invite_token: token,
  };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: participant.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount,
          product_data: {
            name: service.title ?? "Booking",
            description: `Instant booking with ${slug}`,
          },
        },
      },
    ],
    payment_intent_data: connectId
      ? { application_fee_amount, transfer_data: { destination: connectId } }
      : undefined,
    metadata,
    success_url: `https://${slug}.sqrz.com?payment=success`,
    cancel_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${token}`,
  });

  // 5. Update booking with new payment intent + refreshed expiry
  const newPaymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  await adminClient
    .from("bookings")
    .update({
      payment_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      ...(newPaymentIntentId ? { stripe_payment_intent_id: newPaymentIntentId } : {}),
    })
    .eq("id", booking_id);

  return Response.redirect(session.url!, 303);
}
