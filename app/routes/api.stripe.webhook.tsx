import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const toISO = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toISOString() : null;

export async function action({ request }: ActionFunctionArgs) {
  const signature = request.headers.get("stripe-signature");

  console.log("[webhook] received — signature present:", !!signature);
  console.log("[webhook] STRIPE_WEBHOOK_SECRET present:", !!process.env.STRIPE_WEBHOOK_SECRET);
  console.log("[webhook] STRIPE_WEBHOOK_SECRET prefix:", process.env.STRIPE_WEBHOOK_SECRET?.slice(0, 12));

  if (!signature) {
    console.error("[webhook] missing stripe-signature header");
    return new Response("No signature", { status: 400 });
  }

  // Read raw body as text — Stripe HMAC verification requires exact bytes
  const rawBody = await request.text();
  console.log("[webhook] raw body length:", rawBody.length);

  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET_TEST;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, liveSecret!);
    console.log("[webhook] verified with LIVE secret");
  } catch {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, testSecret!);
      console.log("[webhook] verified with TEST secret");
    } catch (err: any) {
      console.error("[webhook] signature verification failed with both secrets:", err.message);
      return new Response(`Webhook signature failed: ${err.message}`, { status: 400 });
    }
  }

  console.log("[webhook] signature verified OK — event.type:", event.type, "event.id:", event.id);

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Idempotency check
  const { data: alreadyProcessed } = await supabase
    .from("stripe_events")
    .select("id")
    .eq("event_id", event.id)
    .maybeSingle();

  if (alreadyProcessed) {
    console.log("[webhook] duplicate event, skipping:", event.id);
    return Response.json({ received: true });
  }

  await supabase
    .from("stripe_events")
    .insert({ event_id: event.id });

  console.log("[webhook] processing event:", event.type, event.id);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    console.log("[webhook] checkout.session.completed — session.id:", session.id);
    console.log("[webhook] full metadata:", JSON.stringify(session.metadata));
    console.log("[webhook] booking_type:", session.metadata?.booking_type, "| booking_id:", session.metadata?.booking_id, "| invite_token:", session.metadata?.invite_token);
    console.log("[webhook] subscription:", session.subscription, "| client_reference_id:", session.client_reference_id, "| amount_total:", session.amount_total);

    // ── Boost ad budget payment ──────────────────────────────────────────────
    const BOOST_AMOUNTS = [50, 100, 150, 300];
    const amountDollars = (session.amount_total ?? 0) / 100;
    const isBoostPayment =
      session.client_reference_id &&
      BOOST_AMOUNTS.includes(amountDollars);

    if (isBoostPayment) {
      const campaignId = session.client_reference_id as string;
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;

      console.log("[webhook] boost payment received:", customerEmail, amountDollars, "campaign:", campaignId);

      // Update the specific campaign to live
      const { error: campaignError } = await supabase
        .from("boost_campaigns")
        .update({ status: "live" })
        .eq("id", campaignId);
      if (campaignError) {
        console.error("[webhook] boost campaign update failed:", campaignError);
      } else {
        console.log("[webhook] boost campaign set to live:", campaignId);
      }

      // Notify will@sqrz.com via Resend
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "noreply@sqrz.com",
          to: "will@sqrz.com",
          subject: `New Boost payment — ${amountDollars}€`,
          html: `
            <p>A new Boost ad budget payment has been received.</p>
            <p><strong>Amount:</strong> €${amountDollars}</p>
            <p><strong>Customer:</strong> ${customerEmail}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Campaign ID:</strong> ${campaignId}</p>
            <p>Log in to the dashboard to review and activate the campaign.</p>
          `,
        });
        console.log("[webhook] boost notification email sent");
      } catch (emailErr) {
        console.error("[webhook] boost notification email failed:", emailErr);
      }

      return Response.json({ received: true });
    }

    // ── Grow campaign payment ────────────────────────────────────────────────
    if (session.metadata?.type === "grow_campaign" && session.metadata?.profile_id) {
      const profileId = session.metadata.profile_id;
      const paymentIntent = session.payment_intent as string | null;

      console.log("[webhook] grow campaign payment received — profile:", profileId, "pi:", paymentIntent);

      const { error: growError } = await supabase
        .from("boost_campaigns")
        .update({
          status: "preparing",
          stripe_payment_id: paymentIntent,
        })
        .eq("profile_id", profileId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);

      if (growError) {
        console.error("[webhook] grow campaign update failed:", growError);
      } else {
        console.log("[webhook] grow campaign set to preparing — profile:", profileId);
      }

      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "SQRZ <noreply@sqrz.com>",
          to: "will@sqrz.com",
          subject: `New Grow campaign payment — $${session.metadata.total}`,
          html: `
            <p>A new SQRZ Grow campaign payment has been received.</p>
            <p><strong>Budget:</strong> $${session.metadata.budget}</p>
            <p><strong>Management fee:</strong> $${session.metadata.fee}</p>
            <p><strong>Total charged:</strong> $${session.metadata.total}</p>
            <p><strong>Profile ID:</strong> ${profileId}</p>
            <p><strong>Payment Intent:</strong> ${paymentIntent}</p>
            <p>Contact the client within 24 hours to schedule their strategy session.</p>
          `,
        });
        console.log("[webhook] grow campaign notification email sent");
      } catch (emailErr) {
        console.error("[webhook] grow campaign notification email failed:", emailErr);
      }

      return Response.json({ received: true });
    }

    // ── Instant booking payment ──────────────────────────────────────────────
    if ((session.metadata?.booking_type === "instant" || session.metadata?.booking_type === "quote_accepted") && session.metadata?.booking_id) {
      const bookingId = session.metadata.booking_id;
      console.log("[webhook] instant booking payment received:", bookingId);

      await supabase
        .from("bookings")
        .update({ status: "confirmed" })
        .eq("id", bookingId);

      // Create or update wallet with client_paid flag
      const { data: existingWallet } = await supabase
        .from("booking_wallets")
        .select("id")
        .eq("booking_id", bookingId)
        .maybeSingle();

      if (existingWallet) {
        await supabase
          .from("booking_wallets")
          .update({ client_paid: true, payout_status: "pending" })
          .eq("id", existingWallet.id);
      } else {
        const { data: bk } = await supabase
          .from("bookings")
          .select("owner_id")
          .eq("id", bookingId)
          .maybeSingle();

        await supabase.from("booking_wallets").insert({
          booking_id: bookingId,
          owner_profile_id: bk?.owner_id ?? null,
          total_budget: (session.amount_total ?? 0) / 100,
          client_paid: true,
          payout_status: "pending",
        });
      }

      // Update proposal status to accepted (quote_accepted path)
      if (session.metadata?.proposal_id) {
        await supabase
          .from("booking_proposals")
          .update({ status: "accepted" })
          .eq("id", session.metadata.proposal_id);
        console.log("[webhook] proposal marked accepted:", session.metadata.proposal_id);
      }

      // Look up buyer to send confirmation email
      const { data: buyer } = await supabase
        .from("booking_participants")
        .select("email, invite_token, name")
        .eq("booking_id", bookingId)
        .eq("role", "buyer")
        .maybeSingle();

      if (buyer?.email) {
        const accessUrl = `https://dashboard.sqrz.com/booking/${bookingId}?token=${buyer.invite_token ?? ""}`;
        try {
          const { Resend } = await import("resend");
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: "SQRZ <noreply@sqrz.com>",
            to: buyer.email,
            subject: "Your booking is confirmed",
            html: `<p>Hi ${buyer.name ?? "there"},</p><p>Payment received — your booking is confirmed.</p><p><a href="${accessUrl}">View your booking</a></p><p>— The SQRZ Team</p>`,
          });
          console.log("[webhook] confirmation email sent to:", buyer.email, "url:", accessUrl);
        } catch (emailErr) {
          console.error("[webhook] confirmation email failed:", emailErr);
        }
      } else {
        console.warn("[webhook] no buyer found for booking:", bookingId);
      }

      return Response.json({ received: true });
    }

    // ── Subscription payment ─────────────────────────────────────────────────
    if (!session.subscription || !session.customer) {
      console.error("[webhook] missing subscription or customer");
      return Response.json({ received: true });
    }

    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    const item = subscription.items.data[0];
    const priceId = item.price.id;

    const { data: plan } = await supabase
      .from("plans")
      .select("id")
      .or(`stripe_price_monthly.eq.${priceId},stripe_price_yearly.eq.${priceId}`)
      .maybeSingle();

    const planId = plan?.id ?? 1;

    // Find profile by stripe_customer_id or email
    const customerEmail = session.customer_details?.email;
    let profileId: string | null = null;

    if (customerEmail) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", customerEmail)
        .maybeSingle();
      profileId = profile?.id ?? null;
    }

    if (!profileId) {
      console.error("[webhook] could not find profile for email:", customerEmail);
      return Response.json({ received: true });
    }

    console.log("[webhook] writing subscription for profile:", profileId);

    const { error: rpcError } = await supabase.rpc("upsert_subscription", {
      p_stripe_subscription_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_stripe_price_id: priceId,
      p_status: subscription.status,
      p_profile_id: profileId,
      p_current_period_start: toISO(item.current_period_start),
      p_current_period_end: toISO(item.current_period_end),
    });

    if (rpcError) {
      console.error("[webhook] RPC failed:", rpcError);
    } else {
      console.log("[webhook] subscription upserted successfully");
    }

    // Update plan_id on profile
    const { error: planError } = await supabase
      .from("profiles")
      .update({
        plan_id: planId,
        stripe_customer_id: subscription.customer as string,
      })
      .eq("id", profileId);

    if (planError) {
      console.error("[webhook] plan update failed:", planError);
    } else {
      console.log("[webhook] plan updated to:", planId);
    }

    // Referral tracking — record conversion and increment use_count
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("referred_by_code")
      .eq("id", profileId)
      .maybeSingle();

    if (profileRow?.referred_by_code) {
      const code = profileRow.referred_by_code as string;
      const { data: refCodeRow } = await supabase
        .from("referral_codes")
        .select("id")
        .eq("code", code)
        .maybeSingle();

      if (refCodeRow) {
        await supabase.from("referral_uses").insert({
          referral_code_id: refCodeRow.id,
          referred_profile_id: profileId,
          converted: true,
        });
        await supabase.rpc("increment_referral_use_count", { p_code: code });
        console.log("[webhook] referral tracked for code:", code);
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const item = subscription.items.data[0];

    await supabase.rpc("upsert_subscription", {
      p_stripe_subscription_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_stripe_price_id: item.price.id,
      p_status: "cancelled",
      p_profile_id: null,
      p_current_period_start: toISO(item.current_period_start),
      p_current_period_end: toISO(item.current_period_end),
    });

    // Reset plan to Creator
    await supabase
      .from("profiles")
      .update({ plan_id: 1 })
      .eq("stripe_customer_id", subscription.customer as string);
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const item = subscription.items.data[0];

    await supabase.rpc("upsert_subscription", {
      p_stripe_subscription_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_stripe_price_id: item.price.id,
      p_status: subscription.status,
      p_profile_id: null,
      p_current_period_start: toISO(item.current_period_start),
      p_current_period_end: toISO(item.current_period_end),
    });
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const status = (account.charges_enabled && account.payouts_enabled) ? "active" : "pending";
    await supabase
      .from("profiles")
      .update({ stripe_connect_status: status })
      .eq("stripe_connect_id", account.id);
    console.log("[webhook] connect account", account.id, "→", status);
  }

  return Response.json({ received: true });
}
