import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";
import { handleBookingReferral } from "~/lib/booking-referral.server";

// ─── Referral commission handler ─────────────────────────────────────────────
// Called on first subscription payment (checkout.session.completed) and every
// renewal (invoice.payment_succeeded). Idempotent via stripe_invoice_id.
// Commission window: 18 months from first_paid_at.
// Yearly renewals pro-rated when fewer than 12 months remain in window.
async function handleReferralCommission(
  supabase: SupabaseClient,
  profileId: string,
  stripeInvoiceId: string,
  amountPaidCents: number,
  isFirstPayment: boolean,
) {
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("referred_by_code")
    .eq("id", profileId)
    .maybeSingle();

  const code = profileRow?.referred_by_code as string | null;
  // "claim" is a sentinel meaning Early Access discount but no partner referral
  if (!code || code === "claim") return;

  const { data: refCodeRow } = await supabase
    .from("referral_codes")
    .select("id, owner_id, commission_pct")
    .eq("code", code)
    .eq("is_active", true)
    .maybeSingle();

  if (!refCodeRow) return;

  // Fetch existing referral_uses row — present on recurring, absent on true first payment
  const { data: existingUse } = await supabase
    .from("referral_uses")
    .select("id, commission_ends_at, first_paid_at")
    .eq("referral_code_id", refCodeRow.id)
    .eq("referred_profile_id", profileId)
    .maybeSingle();

  if (isFirstPayment && !existingUse) {
    // First payment — create referral_uses with 18-month commission window
    const firstPaidAt = new Date();
    const commissionEndsAt = new Date(firstPaidAt);
    commissionEndsAt.setMonth(commissionEndsAt.getMonth() + 18);

    await supabase.from("referral_uses").insert({
      referral_code_id: refCodeRow.id,
      referred_profile_id: profileId,
      converted: true,
      first_paid_at: firstPaidAt.toISOString(),
      commission_ends_at: commissionEndsAt.toISOString(),
    });
    await supabase.rpc("increment_referral_use_count", { p_code: code });
    console.log("[webhook] referral_uses created for code:", code, "profile:", profileId, "window_ends:", commissionEndsAt.toISOString());

    // Simple commission for first payment (no pro-rata)
    const commissionAmount = parseFloat(((amountPaidCents / 100) * (refCodeRow.commission_pct / 100)).toFixed(2));
    const { error: earningsError } = await supabase.from("partner_earnings").insert({
      partner_id: refCodeRow.owner_id,
      commission_amount: commissionAmount,
      payout_status: "pending",
      stripe_invoice_id: stripeInvoiceId,
    });
    if (earningsError && earningsError.code !== "23505") {
      console.error("[webhook] partner_earnings insert failed:", earningsError);
    } else if (!earningsError) {
      console.log("[webhook] partner_earnings recorded — partner:", refCodeRow.owner_id, "amount:", commissionAmount);
    }
    return;
  }

  // Recurring payment — check window and apply pro-rata for yearly invoices
  if (!existingUse?.commission_ends_at) return;

  const windowEnd = new Date(existingUse.commission_ends_at);
  const now = new Date();
  if (windowEnd < now) {
    console.log("[webhook] commission window expired for profile:", profileId);
    return;
  }

  const monthsRemaining = Math.max(0,
    (windowEnd.getFullYear() - now.getFullYear()) * 12 +
    (windowEnd.getMonth() - now.getMonth())
  );

  // Yearly invoice if amount > $50 (5000 cents)
  const isYearly = amountPaidCents > 5000;
  let commissionableAmount = amountPaidCents / 100;
  if (isYearly && monthsRemaining < 12) {
    // Pro-rate: only commission the months remaining in the window
    commissionableAmount = (amountPaidCents / 100) * (monthsRemaining / 12);
  }

  const commissionAmount = parseFloat(((commissionableAmount * refCodeRow.commission_pct) / 100).toFixed(2));

  const { error: earningsError } = await supabase.from("partner_earnings").insert({
    partner_id: refCodeRow.owner_id,
    commission_amount: commissionAmount,
    payout_status: "pending",
    stripe_invoice_id: stripeInvoiceId,
  });

  if (earningsError) {
    if (earningsError.code !== "23505") {
      console.error("[webhook] partner_earnings insert failed:", earningsError);
    }
  } else {
    console.log("[webhook] partner_earnings recorded — partner:", refCodeRow.owner_id, "months_remaining:", monthsRemaining, "commissionable:", commissionableAmount, "amount:", commissionAmount);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const toISO = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toISOString() : null;

// Verbose diagnostic logging (full metadata dumps, raw emails, access tokens) is
// gated behind this flag — off by default so PII/credentials never hit prod logs.
const WEBHOOK_DEBUG = process.env.WEBHOOK_DEBUG === "true";

// Escape user-supplied / external values before interpolating them into email HTML.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function action({ request }: ActionFunctionArgs) {
  const signature = request.headers.get("stripe-signature");

  console.log("[webhook] received — signature present:", !!signature);

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

  // Idempotency: insert-first. event_id is UNIQUE, so a concurrent duplicate
  // delivery fails here with a 23505 unique violation — treat that as
  // already-processed. This is atomic, unlike a separate check-then-insert that
  // two simultaneous deliveries could both pass before either writes.
  const { error: idempotencyError } = await supabase
    .from("stripe_events")
    .insert({ event_id: event.id });

  if (idempotencyError) {
    if (idempotencyError.code === "23505") {
      console.log("[webhook] duplicate event, skipping:", event.id);
      return Response.json({ received: true });
    }
    // Unexpected insert failure — log and continue so a legitimate event still processes.
    console.error("[webhook] stripe_events insert error:", idempotencyError);
  }

  console.log("[webhook] processing event:", event.type, event.id);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    console.log("[webhook] checkout.session.completed — session.id:", session.id);
    if (WEBHOOK_DEBUG) {
      console.log("[webhook] full metadata:", JSON.stringify(session.metadata));
      console.log("[webhook] booking_type:", session.metadata?.booking_type, "| booking_id:", session.metadata?.booking_id, "| invite_token:", session.metadata?.invite_token);
      console.log("[webhook] subscription:", session.subscription, "| client_reference_id:", session.client_reference_id, "| amount_total:", session.amount_total);
    }

    // ── Private link payment (PaymentGateCta on sqrz-profiles) ───────────────
    // A payment-gated private booking link was paid. Record the use + capture the
    // payer's email as a lead. No booking is created.
    if (session.metadata?.type === "link_payment" && session.metadata?.link_id) {
      const linkId = session.metadata.link_id;
      const email = session.customer_details?.email ?? session.customer_email ?? null;
      console.log("[webhook] link_payment received — link_id:", linkId, "email:", email ? "present" : "missing");

      const { data: linkRow } = await supabase
        .from("private_booking_links")
        .select("use_count, profile_id")
        .eq("id", linkId)
        .maybeSingle();

      if (linkRow) {
        await supabase
          .from("private_booking_links")
          .update({ use_count: (linkRow.use_count ?? 0) + 1 })
          .eq("id", linkId);

        // Record the payment itself (amount/currency/intent) so it can appear in
        // the seller's payments dashboard. link_leads only captures the email.
        const { error: paymentError } = await supabase.from("link_payments").insert({
          link_id: linkId,
          profile_id: linkRow.profile_id,
          email,
          amount: (session.amount_total ?? 0) / 100,
          currency: session.currency ?? "eur",
          stripe_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
          stripe_session_id: session.id,
          stripe_mode: session.livemode ? "live" : "test",
        });
        // Duplicate session (unique constraint 23505) is fine — webhook retry.
        if (paymentError && paymentError.code !== "23505") {
          console.error("[webhook] link_payment record insert failed:", paymentError);
        }

        if (email) {
          const { error: leadError } = await supabase.from("link_leads").insert({
            link_id: linkId,
            profile_id: linkRow.profile_id,
            email,
            collected_at: new Date().toISOString(),
          });
          // Duplicate email (unique constraint 23505) is fine — ignore it.
          if (leadError && leadError.code !== "23505") {
            console.error("[webhook] link_payment lead insert failed:", leadError);
          }
        }
      } else {
        console.error("[webhook] link_payment: link not found:", linkId);
      }

      return Response.json({ received: true });
    }

    // ── Boost / Grow campaign payment (unified) ──────────────────────────────
    if (session.metadata?.campaign_id) {
      const campaignId = session.metadata.campaign_id;
      const campaignType = session.metadata.campaign_type ?? "boost";
      const paymentIntent = session.payment_intent as string | null;
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
      const totalDollars = (session.amount_total ?? 0) / 100;

      console.log("[webhook] campaign payment received — type:", campaignType, "id:", campaignId, "total:", totalDollars);

      // Both Boost and Grow land on 'booked' after payment — unified workflow
      // (paid, artist adds content next). Execution stays manual for Grow.
      const { error: campaignError } = await supabase
        .from("boost_campaigns")
        .update({
          status: "booked",
          status_updated_at: new Date().toISOString(),
          stripe_payment_id: paymentIntent,
          stripe_payment_status: "paid",
        })
        .eq("id", campaignId);

      if (campaignError) {
        console.error("[webhook] campaign update failed:", campaignError);
      } else {
        console.log("[webhook] campaign set to booked:", campaignId);
      }

      // Notify will@sqrz.com
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        const isGrow = campaignType === "grow";
        await resend.emails.send({
          from: "SQRZ <noreply@sqrz.com>",
          to: "will@sqrz.com",
          subject: `New ${isGrow ? "Grow" : "Boost"} campaign payment — $${session.metadata.total}`,
          html: `
            <p>A new SQRZ ${isGrow ? "Grow" : "Boost"} campaign payment has been received.</p>
            <p><strong>Ad budget:</strong> $${escapeHtml(session.metadata.budget_amount)}</p>
            <p><strong>${isGrow ? "Management fee (20%)" : "Activation fee"}:</strong> $${escapeHtml(session.metadata.fee)}</p>
            <p><strong>Total charged:</strong> $${escapeHtml(session.metadata.total)}</p>
            <p><strong>Customer:</strong> ${escapeHtml(customerEmail)}</p>
            <p><strong>Campaign ID:</strong> ${campaignId}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            ${isGrow ? "<p>Contact the client within 24 hours to schedule their strategy session.</p>" : "<p>Log in to the dashboard to review and activate the campaign.</p>"}
          `,
        });
        console.log("[webhook] campaign notification email sent");
      } catch (emailErr) {
        console.error("[webhook] campaign notification email failed:", emailErr);
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

    // ── Instant booking payment ──────────────────────────────────────────────
    if (session.metadata?.type === "instant_booking") {
      const meta = session.metadata;

      // Booking is created before the Stripe session (booking_id in metadata).
      // Legacy fallback: if no booking_id in metadata, create it now.
      let bookingId: string | undefined = meta.booking_id || undefined;

      if (!bookingId) {
        console.log("[webhook] instant_booking — no booking_id in metadata, creating booking (legacy path) for:", meta.to_slug);
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
        bookingId = rpcResult?.booking_id as string | undefined;
      } else {
        console.log("[webhook] instant_booking — using booking_id from metadata:", bookingId);
      }

      if (!bookingId) {
        console.error("[webhook] instant_booking: no booking_id available");
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

      const sessionStripeMode = session.livemode ? "live" : "test";

      // Booking referral commission
      try {
        const commissionBaseAmount = meta.rate ? Number(meta.rate) : (session.amount_total ?? 0) / 100;
        await handleBookingReferral({
          supabase,
          bookingId,
          bookingValue: commissionBaseAmount,
          stripeMode: sessionStripeMode,
        });
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
        base_rate: net ?? totalCharged,
        stripe_mode: sessionStripeMode,
        client_paid: true,
        client_payment_method: "stripe",
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
            html: `<p>Hi ${escapeHtml(buyer.name ?? "there")},</p><p>Payment received — your booking is confirmed.</p><p><a href="${accessUrl}">View your booking</a></p><p>— The SQRZ Team</p>`,
          });
          if (WEBHOOK_DEBUG) console.log("[webhook] instant_booking confirmation email sent to:", buyer.email);
        } catch (emailErr) {
          console.error("[webhook] instant_booking confirmation email failed:", emailErr);
        }
      }

      return Response.json({ received: true });
    }

    // ── Legacy instant booking payment ───────────────────────────────────────
    if ((session.metadata?.booking_type === "instant" || session.metadata?.booking_type === "quote_accepted") && session.metadata?.booking_id) {
      const bookingId = session.metadata.booking_id;
      const sessionStripeMode =
        session.metadata?.stripe_mode === "test" || !session.livemode ? "test" : "live";
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
        const commissionBaseAmount = session.metadata?.rate
          ? Number(session.metadata.rate)
          : (session.amount_total ?? 0) / 100;
        await handleBookingReferral({
          supabase,
          bookingId,
          bookingValue: commissionBaseAmount,
          stripeMode: sessionStripeMode,
        });
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
          client_payment_method: "stripe",
          payout_status: "pending",
          total_budget: totalCharged,
          stripe_mode: sessionStripeMode,
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
          feePct = (ownerProfile?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 0;
        }

        // secured_amount = member's rate (net); total_budget = what booker paid (net + tax + fee)
        const securedAmount = proposalRate ?? Math.round(((totalCharged - metaTaxAmount) / (1 + feePct / 100)) * 100) / 100;

        const { data: newWallet } = await supabase.from("booking_wallets").insert({
          booking_id: bookingId,
          owner_profile_id: bk?.owner_id ?? null,
          total_budget: totalCharged,
          secured_amount: securedAmount,
          base_rate: securedAmount,
          stripe_mode: sessionStripeMode,
          client_paid: true,
          client_payment_method: "stripe",
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
            html: `<p>Hi ${escapeHtml(buyer.name ?? "there")},</p><p>Payment received — your booking is confirmed.</p><p><a href="${accessUrl}">View your booking</a></p><p>— The SQRZ Team</p>`,
          });
          if (WEBHOOK_DEBUG) console.log("[webhook] confirmation email sent to:", buyer.email, "url:", accessUrl);
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
      console.error("[webhook] could not find profile for subscription customer");
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

    // Referral commission tracking
    const invoiceId = (session as any).invoice as string | null;
    if (invoiceId && session.amount_total) {
      await handleReferralCommission(supabase, profileId, invoiceId, session.amount_total, true);
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
        .update({ plan_id: null })
        .eq("id", subRow.profile_id as string);
      console.log("[webhook] plan reset to free (null) for profile:", subRow.profile_id);
    }
    console.log("[webhook] subscription deleted:", sub.id);
  }

  // Recurring subscription payment — credit partner commission each renewal
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceAny = invoice as any;

    // Only process subscription renewals (not the first payment — that's handled by checkout.session.completed)
    const billingReason = invoiceAny.billing_reason as string | null;
    if (billingReason !== "subscription_cycle" && billingReason !== "subscription_update") {
      // Skip: first-payment invoices are covered by checkout.session.completed
      return Response.json({ received: true });
    }

    const customerId = invoice.customer as string | null;
    if (!customerId || !invoice.amount_paid) {
      return Response.json({ received: true });
    }

    const { data: profileRow } = await supabase
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (!profileRow?.id) {
      console.error("[webhook] invoice.payment_succeeded — no profile for customer:", customerId);
      return Response.json({ received: true });
    }

    await handleReferralCommission(supabase, profileRow.id, invoice.id, invoice.amount_paid, false);
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const status = (account.charges_enabled && account.payouts_enabled) ? "active" : "pending";
    const connectIdField = account.livemode ? "stripe_connect_id" : "stripe_connect_id_test";
    const connectStatusField = account.livemode ? "stripe_connect_status" : "stripe_connect_status_test";
    await supabase
      .from("profiles")
      .update({
        [connectStatusField]: status,
        ...(account.livemode ? {} : { stripe_beta_test_mode: true }),
      })
      .eq(connectIdField, account.id);
    console.log("[webhook] connect account", account.id, "livemode:", account.livemode, "→", status);
  }

  return Response.json({ received: true });
}
