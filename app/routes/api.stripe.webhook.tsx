import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { ActionFunctionArgs } from "react-router";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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
      console.log("[webhook] campaign_id:", session.metadata?.campaign_id, "| client_reference_id:", session.client_reference_id, "| amount_total:", session.amount_total);
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

      // Credit the campaign's ad budget to the shared ad-spend wallet as a
      // FEE-EXEMPT top-up: the campaign-start fee (boost = flat $25, grow = 20%)
      // was already collected inline in this same checkout, so no separate
      // management_fee_charges row is created (p_fee_exempt = true). This is the
      // "Start Campaign" funding path — the standalone /api/wallet/topup path is
      // the fee-charged one (see the wallet_topup branch below).
      //
      // Not fatal on failure: the campaign is already booked and the fee collected,
      // so we log-and-continue rather than 500 (a retry would re-send the email and
      // risk a double credit — the ledger has no per-payment idempotency key).
      const budgetAmount = Number(session.metadata.budget_amount ?? 0);
      const budgetCents = Math.round(budgetAmount * 100);
      const walletProfileId = session.metadata.profile_id;
      const campaignSource = session.metadata.source === "ios" ? "ios" : "web";
      if (walletProfileId && budgetCents > 0) {
        const { error: creditError } = await supabase.rpc("record_wallet_topup", {
          p_profile_id: walletProfileId,
          p_amount_cents: budgetCents,
          p_source: campaignSource,
          p_stripe_payment_intent_id: paymentIntent,
          p_fee_exempt: true,
        });
        if (creditError) {
          console.error("[webhook] campaign budget wallet credit failed (campaign still booked):", creditError);
        } else {
          console.log("[webhook] campaign budget credited fee-exempt to wallet:", walletProfileId, budgetCents);
        }
      }

      // Notify will@sqrz.com
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        const isGrow = campaignType === "grow";
        const feeLabel = isGrow ? "SQRZ fee (20%)" : "SQRZ campaign fee (flat $25)";
        await resend.emails.send({
          from: "SQRZ <noreply@sqrz.com>",
          to: "will@sqrz.com",
          subject: `New ${isGrow ? "Grow" : "Boost"} campaign payment — $${session.metadata.total}`,
          html: `
            <p>A new SQRZ ${isGrow ? "Grow" : "Boost"} campaign payment has been received.</p>
            <p><strong>Ad budget:</strong> $${escapeHtml(session.metadata.budget_amount)} (credited to the artist's ad-spend wallet)</p>
            <p><strong>${feeLabel}:</strong> $${escapeHtml(session.metadata.fee)}</p>
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

    // ── Grow ad-spend wallet top-up ──────────────────────────────────────────
    // Credits the wallet AND records the separate management-fee charge in ONE
    // atomic RPC (record_wallet_topup) — a top-up that credits the wallet but
    // fails to record the fee would be a revenue leak, so the two must be
    // all-or-nothing. Idempotency is already guaranteed by the insert-first
    // stripe_events guard above, so this branch runs at most once per event.
    if (session.metadata?.type === "wallet_topup") {
      const profileId = session.metadata.profile_id;
      const amountCents = Number(session.metadata.amount_cents ?? session.amount_total ?? 0);
      const source = session.metadata.source === "ios" ? "ios" : "web";
      const paymentIntent = session.payment_intent as string | null;

      console.log("[webhook] wallet top-up received — profile:", profileId, "cents:", amountCents, "source:", source);

      if (!profileId || !amountCents) {
        console.error("[webhook] wallet top-up missing profile_id/amount — skipping");
        return Response.json({ received: true });
      }

      const { error: topupError } = await supabase.rpc("record_wallet_topup", {
        p_profile_id: profileId,
        p_amount_cents: amountCents,
        p_source: source,
        p_stripe_payment_intent_id: paymentIntent,
      });

      if (topupError) {
        console.error("[webhook] record_wallet_topup failed:", topupError);
        // 500 → Stripe retries; the stripe_events row was inserted but the RPC
        // failed, so on retry the idempotency guard would (incorrectly) skip it.
        // Remove the idempotency marker so the retry re-processes cleanly.
        await supabase.from("stripe_events").delete().eq("event_id", event.id);
        return new Response("Wallet top-up failed", { status: 500 });
      }

      console.log("[webhook] wallet top-up recorded for profile:", profileId);
      return Response.json({ received: true });
    }
  }

  return Response.json({ received: true });
}
