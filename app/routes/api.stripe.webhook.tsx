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
    // Stripe sets this authoritatively per-event — more reliable than trusting
    // anything we'd have to round-trip through checkout session metadata. Every
    // wallet_ledger_entries / management_fee_charges row this webhook creates
    // gets tagged with it, so test data (currently: every iOS transaction, see
    // api/wallet/topup.tsx + api/campaigns/reactivate.tsx) is never ambiguous.
    const stripeMode: "live" | "test" = event.livemode ? "live" : "test";

    console.log("[webhook] checkout.session.completed — session.id:", session.id, "mode:", stripeMode);
    if (WEBHOOK_DEBUG) {
      console.log("[webhook] full metadata:", JSON.stringify(session.metadata));
      console.log("[webhook] campaign_id:", session.metadata?.campaign_id, "| client_reference_id:", session.client_reference_id, "| amount_total:", session.amount_total);
    }

    // ── Campaign setup fee ($25) / reactivation fee ($10) ────────────────────
    // Allocation-fee model (2026-08-01): a campaign_id session no longer bundles
    // any ad budget. Two flat, budget-free charges land here, told apart by
    // metadata.type. Neither credits the wallet or allocates — funding happens
    // separately via wallet → allocation (where the commission now lives).
    if (session.metadata?.campaign_id) {
      const campaignId = session.metadata.campaign_id;
      const campaignType = session.metadata.type; // 'campaign_setup' | 'reactivation'
      const paymentIntent = session.payment_intent as string | null;
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;

      console.log("[webhook] campaign charge received — id:", campaignId, "type:", campaignType);

      if (campaignType === "reactivation") {
        // Unified reactivation ($10): works regardless of WHY the campaign was
        // inactive (completed-and-archived, or exhausted budget).
        //   1. Reset boost_campaigns.status → 'pending' (moves it out of the
        //      Archived lane; pending lands it in No Action Needed on iOS).
        //      Also record the payment on the row, same as the setup branch.
        //   2. If the campaign's budget was 'exhausted', flip it back to 'active'
        //      so pill allocation is allowed against it again — guarded on
        //      status='exhausted' so it's a no-op when it doesn't apply.
        // Both writes are idempotent, so a duplicate webhook delivery is safe.
        const { error: campaignError } = await supabase
          .from("boost_campaigns")
          .update({
            status: "pending",
            status_updated_at: new Date().toISOString(),
            stripe_payment_id: paymentIntent,
            stripe_payment_status: "paid",
            stripe_mode: stripeMode,
          })
          .eq("id", campaignId);
        if (campaignError) console.error("[webhook] reactivation status reset failed:", campaignError);
        else console.log("[webhook] campaign reactivated → pending:", campaignId);

        const { error: reErr } = await supabase
          .from("campaign_budgets")
          .update({ status: "active", updated_at: new Date().toISOString() })
          .eq("campaign_id", campaignId)
          .eq("status", "exhausted");
        if (reErr) console.error("[webhook] budget exhausted→active flip failed:", reErr);
      } else {
        // Setup fee → mark the campaign booked (artist adds content next) and
        // create its zero-budget, active campaign_budgets row so allocation has a
        // target. ignoreDuplicates makes the budget insert idempotent.
        //
        // DEPRECATED PATH (2026-08-08): the $25 setup fee and its
        // api/campaigns/checkout.tsx route were removed — campaign creation
        // now sets status: "booked" directly, client-side, with no payment
        // involved (see sqrz-ios's BoostView.swift). This branch can no
        // longer be reached by anything the app initiates going forward, but
        // is deliberately left in place rather than deleted: it's what
        // finalizes any checkout session that was already open in a user's
        // Safari tab at deploy time (a real, if narrow, race), and Stripe
        // could in principle still redeliver a historical event for one.
        // Harmless to leave — it only ever fires on a genuine
        // checkout.session.completed with metadata.type === "campaign_setup",
        // which nothing can produce anymore.
        const { error: campaignError } = await supabase
          .from("boost_campaigns")
          .update({
            status: "booked",
            status_updated_at: new Date().toISOString(),
            stripe_payment_id: paymentIntent,
            stripe_payment_status: "paid",
            stripe_mode: stripeMode,
          })
          .eq("id", campaignId);
        if (campaignError) console.error("[webhook] campaign update failed:", campaignError);
        else console.log("[webhook] campaign set to booked:", campaignId);

        const { error: budgetError } = await supabase
          .from("campaign_budgets")
          .upsert({ campaign_id: campaignId }, { onConflict: "campaign_id", ignoreDuplicates: true });
        if (budgetError) console.error("[webhook] campaign_budgets create failed:", budgetError);
      }

      // Notify will@sqrz.com
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        const label = campaignType === "reactivation" ? "reactivation" : "setup";
        await resend.emails.send({
          from: "SQRZ <noreply@sqrz.com>",
          to: "will@sqrz.com",
          subject: `SQRZ campaign ${label} fee — $${session.metadata.fee}`,
          html: `
            <p>A SQRZ Boost campaign ${escapeHtml(label)} fee has been paid.</p>
            <p><strong>Fee:</strong> $${escapeHtml(session.metadata.fee)}</p>
            <p><strong>Customer:</strong> ${escapeHtml(customerEmail)}</p>
            <p><strong>Campaign ID:</strong> ${campaignId}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
          `,
        });
        console.log("[webhook] campaign notification email sent");
      } catch (emailErr) {
        console.error("[webhook] campaign notification email failed:", emailErr);
      }

      return Response.json({ received: true });
    }

    // ── Standalone ad-spend wallet top-up ────────────────────────────────────
    // Credits the wallet with the BASE top-up amount. Fee-at-topup (2026-08-03,
    // superseding the 2026-08-01 allocation-fee pivot): record_wallet_topup both
    // credits the wallet AND records a flat 15% management_fee_charges row,
    // linked to this same topup ledger entry — allocate_campaign_budget no
    // longer charges anything. Idempotent on stripe_payment_intent_id (ON
    // CONFLICT DO NOTHING): a duplicate delivery is a safe no-op (returns null,
    // no error, no fee row either) on top of the insert-first stripe_events
    // guard above.
    //
    // Credit metadata.amount_cents (the BASE), NEVER amount_total — the charge
    // total now also includes the SQRZ Fee line, which must not land in the
    // wallet.
    if (session.metadata?.type === "wallet_topup") {
      const profileId = session.metadata.profile_id;
      const amountCents = Number(session.metadata.amount_cents ?? 0);
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
        p_stripe_mode: stripeMode,
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
