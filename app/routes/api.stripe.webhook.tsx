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

    // ── Boost campaign payment ───────────────────────────────────────────────
    if (session.metadata?.campaign_id) {
      const campaignId = session.metadata.campaign_id;
      const paymentIntent = session.payment_intent as string | null;
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
      const totalDollars = (session.amount_total ?? 0) / 100;

      console.log("[webhook] campaign payment received — id:", campaignId, "total:", totalDollars);

      // Paid → 'booked' (artist adds content next).
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

      // Fund the campaign: fee-exempt wallet credit of the budget + immediate
      // allocation of that same amount into the campaign, in ONE atomic RPC
      // (record_campaign_start_funding). Net wallet effect is zero (the flat $25
      // fee was collected inline in this checkout, so no management-fee row).
      // Idempotent by payment_intent: a duplicate webhook returns null and skips
      // safely — the original transaction already funded + allocated. A genuine
      // error is logged, not retried (the campaign is booked and email would
      // re-send on retry; a missed credit is a rare manual fix).
      const budgetAmount = Number(session.metadata.budget_amount ?? 0);
      const budgetCents = Math.round(budgetAmount * 100);
      const walletProfileId = session.metadata.profile_id;
      const campaignSource = session.metadata.source === "ios" ? "ios" : "web";
      if (walletProfileId && budgetCents > 0) {
        const { error: fundError } = await supabase.rpc("record_campaign_start_funding", {
          p_profile_id: walletProfileId,
          p_campaign_id: campaignId,
          p_amount_cents: budgetCents,
          p_source: campaignSource,
          p_stripe_payment_intent_id: paymentIntent,
        });
        if (fundError) {
          console.error("[webhook] campaign start funding failed (campaign still booked):", fundError);
        } else {
          console.log("[webhook] campaign funded + allocated:", campaignId, budgetCents);
        }
      }

      // Notify will@sqrz.com
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "SQRZ <noreply@sqrz.com>",
          to: "will@sqrz.com",
          subject: `New Boost campaign payment — $${session.metadata.total}`,
          html: `
            <p>A new SQRZ Boost campaign payment has been received.</p>
            <p><strong>Ad budget:</strong> $${escapeHtml(session.metadata.budget_amount)} (credited + allocated to the artist's ad-spend wallet)</p>
            <p><strong>SQRZ campaign fee (flat $25):</strong> $${escapeHtml(session.metadata.fee)}</p>
            <p><strong>Total charged:</strong> $${escapeHtml(session.metadata.total)}</p>
            <p><strong>Customer:</strong> ${escapeHtml(customerEmail)}</p>
            <p><strong>Campaign ID:</strong> ${campaignId}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p>Log in to the dashboard to review and activate the campaign.</p>
          `,
        });
        console.log("[webhook] campaign notification email sent");
      } catch (emailErr) {
        console.error("[webhook] campaign notification email failed:", emailErr);
      }

      return Response.json({ received: true });
    }

    // ── Standalone ad-spend wallet top-up ────────────────────────────────────
    // Credits the wallet AND records the separate 15% management-fee charge in ONE
    // atomic RPC (record_wallet_topup) — a top-up that credits the wallet but fails
    // to record the fee would be a revenue leak, so the two must be all-or-nothing.
    // The RPC is idempotent on stripe_payment_intent_id (ON CONFLICT DO NOTHING): a
    // duplicate delivery is a safe no-op (returns null, no error) on top of the
    // insert-first stripe_events guard above.
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
        // A duplicate PI does NOT reach here (ON CONFLICT makes it a null-returning
        // no-op), so this is a genuine failure. 500 → Stripe retries; drop the
        // idempotency marker so the retry re-processes (the RPC's PI idempotency
        // still prevents any double credit on that retry).
        console.error("[webhook] record_wallet_topup failed:", topupError);
        await supabase.from("stripe_events").delete().eq("event_id", event.id);
        return new Response("Wallet top-up failed", { status: 500 });
      }

      console.log("[webhook] wallet top-up recorded for profile:", profileId);
      return Response.json({ received: true });
    }
  }

  return Response.json({ received: true });
}
