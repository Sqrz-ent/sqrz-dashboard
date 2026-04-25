import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";
import { handleBookingReferral } from "~/lib/booking-referral.server";

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

    // ── Allocation payment (income line item paid individually) ──────────────
    if (session.metadata?.booking_type === "allocation_payment" && session.metadata?.wallet_allocation_id) {
      const allocationId = session.metadata.wallet_allocation_id;
      console.log("[webhook] allocation payment received:", allocationId);
      await supabase
        .from("wallet_allocations")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", allocationId);
      return Response.json({ received: true });
    }

    // ── New instant booking (booking created post-payment) ───────────────────
    if (session.metadata?.type === "instant_booking") {
      const meta = session.metadata;
      console.log("[webhook] instant_booking payment received — creating booking for:", meta.to_slug);

      const { data: rpcData, error: rpcError } = await supabase.rpc("create_booking_request", {
        p_to_slug: meta.to_slug ?? "",
        p_from_name: meta.from_name ?? "",
        p_from_email: meta.from_email ?? "",
        p_service: meta.service || null,
        p_message: meta.message || null,
        p_event_date: meta.event_date || null,
        p_event_location: meta.event_location || null,
        p_title: meta.title || null,
        p_booking_ref_code: meta.booking_ref_code || null,
      });

      if (rpcError) {
        console.error("[webhook] instant_booking RPC error:", rpcError);
        return Response.json({ received: true });
      }

      const rpcResult = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      const bookingId = rpcResult?.booking_id as string | undefined;

      if (!bookingId) {
        console.error("[webhook] instant_booking: no booking_id from RPC");
        return Response.json({ received: true });
      }

      const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;

      await supabase
        .from("bookings")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
        })
        .eq("id", bookingId);

      console.log("[webhook] instant_booking confirmed:", bookingId);

      // Booking referral commission
      try {
        const totalCharged = (session.amount_total ?? 0) / 100;
        await handleBookingReferral({ supabase, bookingId, bookingValue: totalCharged });
      } catch (refErr) {
        console.error("[webhook] instant_booking referral commission failed:", refErr);
      }

      // Create wallet
      const totalCharged = (session.amount_total ?? 0) / 100;
      const metaTaxPct    = meta.tax_pct    ? Number(meta.tax_pct)    : 0;
      const metaTaxAmount = meta.tax_amount ? Number(meta.tax_amount) : 0;
      const net = meta.rate ? Number(meta.rate) : null;
      const feePct = meta.fee_pct ? Number(meta.fee_pct) : 0;

      const { data: bk } = await supabase
        .from("bookings")
        .select("owner_id")
        .eq("id", bookingId)
        .maybeSingle();

      await supabase.from("booking_wallets").insert({
        booking_id: bookingId,
        owner_profile_id: bk?.owner_id ?? null,
        total_budget: totalCharged,
        secured_amount: net ?? totalCharged,
        client_paid: true,
        payout_status: "pending",
        sqrz_fee_pct: feePct,
        tax_pct: metaTaxPct,
        tax_amount: metaTaxAmount,
      });

      // Confirmation email to buyer
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
          console.log("[webhook] instant_booking confirmation email sent to:", buyer.email);
        } catch (emailErr) {
          console.error("[webhook] instant_booking confirmation email failed:", emailErr);
        }
      }

      return Response.json({ received: true });
    }

    // ── Legacy instant booking payment ───────────────────────────────────────
    if ((session.metadata?.booking_type === "instant" || session.metadata?.booking_type === "quote_accepted") && session.metadata?.booking_id) {
      const bookingId = session.metadata.booking_id;
      console.log("[webhook] legacy instant/quote booking payment received:", bookingId);

      await supabase
        .from("bookings")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          payment_expires_at: null,
        })
        .eq("id", bookingId);

      // Booking referral commission
      try {
        const totalCharged = (session.amount_total ?? 0) / 100;
        await handleBookingReferral({ supabase, bookingId, bookingValue: totalCharged });
      } catch (refErr) {
        console.error("[webhook] legacy booking referral commission failed:", refErr);
      }

      // Create or update wallet with client_paid flag
      const { data: existingWallet } = await supabase
        .from("booking_wallets")
        .select("id")
        .eq("booking_id", bookingId)
        .maybeSingle();

      let walletId: string | null = existingWallet?.id ?? null;

      const totalCharged = (session.amount_total ?? 0) / 100;

      // For quote_accepted: rate is stored in metadata (member's take-home)
      // For instant: rate is the full instant_price (no separate fee stored yet)
      let proposalRate: number | null = null;
      if (session.metadata?.rate) {
        proposalRate = Number(session.metadata.rate);
      } else if (session.metadata?.proposal_id) {
        const { data: pData } = await supabase
          .from("booking_proposals")
          .select("rate")
          .eq("id", session.metadata.proposal_id)
          .maybeSingle();
        proposalRate = pData?.rate ?? null;
      }

      const metaTaxPct    = session.metadata?.tax_pct    ? Number(session.metadata.tax_pct)    : 0;
      const metaTaxAmount = session.metadata?.tax_amount ? Number(session.metadata.tax_amount) : 0;

      if (existingWallet) {
        // Update existing wallet: mark paid + set secured_amount if not already set
        const updateData: Record<string, unknown> = {
          client_paid: true,
          payout_status: "pending",
          total_budget: totalCharged,
          tax_pct: metaTaxPct,
          tax_amount: metaTaxAmount,
        };
        if (proposalRate != null) updateData.secured_amount = proposalRate;
        await supabase
          .from("booking_wallets")
          .update(updateData)
          .eq("id", existingWallet.id);
      } else {
        const { data: bk } = await supabase
          .from("bookings")
          .select("owner_id")
          .eq("id", bookingId)
          .maybeSingle();

        // Use fee_pct from metadata if available (set by api.proposal.accept); else fetch from plan
        let feePct = session.metadata?.fee_pct ? Number(session.metadata.fee_pct) : 8;
        if (!session.metadata?.fee_pct && bk?.owner_id) {
          const { data: ownerProfile } = await supabase
            .from("profiles")
            .select("plan_id, plans(booking_fee_pct)")
            .eq("id", bk.owner_id)
            .maybeSingle();
          feePct = (ownerProfile?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 8;
        }

        // secured_amount = member's rate (net); total_budget = what booker paid (net + tax + fee)
        const securedAmount = proposalRate ?? Math.round(((totalCharged - metaTaxAmount) / (1 + feePct / 100)) * 100) / 100;

        const { data: newWallet } = await supabase.from("booking_wallets").insert({
          booking_id: bookingId,
          owner_profile_id: bk?.owner_id ?? null,
          total_budget: totalCharged,
          secured_amount: securedAmount,
          client_paid: true,
          payout_status: "pending",
          sqrz_fee_pct: feePct,
          tax_pct: metaTaxPct,
          tax_amount: metaTaxAmount,
        }).select("id").single();

        walletId = newWallet?.id ?? null;
      }

      // Update proposal status to accepted (quote_accepted path) and create allocations
      if (session.metadata?.proposal_id) {
        await supabase
          .from("booking_proposals")
          .update({ status: "accepted" })
          .eq("id", session.metadata.proposal_id);
        console.log("[webhook] proposal marked accepted:", session.metadata.proposal_id);

        // Create wallet allocations from proposal line_items
        if (walletId) {
          const { data: proposalData } = await supabase
            .from("booking_proposals")
            .select("line_items, currency")
            .eq("id", session.metadata.proposal_id)
            .maybeSingle();

          const lineItems = proposalData?.line_items as Array<{ label: string; type: string; amount: number }> | null;
          if (lineItems?.length) {
            // Only insert if no allocations yet for this wallet
            const { count } = await supabase
              .from("wallet_allocations")
              .select("id", { count: "exact", head: true })
              .eq("wallet_id", walletId);

            if (!count || count === 0) {
              await supabase.from("wallet_allocations").insert(
                lineItems.map((item) => ({
                  wallet_id: walletId,
                  allocation_type: item.type,
                  label: item.label,
                  role: item.label,
                  amount: item.amount,
                  currency: proposalData?.currency ?? "EUR",
                  status: "pending",
                }))
              );
              console.log("[webhook] created", lineItems.length, "allocations for wallet:", walletId);
            }
          }
        }
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

  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const subAny = sub as any;
    await supabase
      .from("subscriptions")
      .update({
        status: sub.status,
        current_period_end: toISO(subAny.current_period_end),
        cancelled_at: toISO(subAny.canceled_at),
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", sub.id);
    console.log("[webhook] subscription updated:", sub.id, "status:", sub.status, "canceled_at:", subAny.canceled_at);
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const subAny = sub as any;
    const { data: subRow } = await supabase
      .from("subscriptions")
      .update({
        status: sub.status,
        current_period_end: toISO(subAny.current_period_end),
        cancelled_at: toISO(subAny.canceled_at),
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", sub.id)
      .select("profile_id")
      .maybeSingle();

    if (subRow?.profile_id) {
      await supabase
        .from("profiles")
        .update({ plan_id: 1 })
        .eq("id", subRow.profile_id as string);
      console.log("[webhook] plan reset to Creator for profile:", subRow.profile_id);
    }
    console.log("[webhook] subscription deleted:", sub.id);
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
