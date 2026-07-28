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
            <p><strong>SQRZ fee (20%):</strong> $${escapeHtml(session.metadata.fee)}</p>
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
  }

  return Response.json({ received: true });
}
