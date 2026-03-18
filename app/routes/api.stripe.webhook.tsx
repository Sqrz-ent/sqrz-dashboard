import type { Route } from "./+types/api.stripe.webhook";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { stripe, PRICE_TO_PLAN } from "~/lib/stripe.server";

// Stripe timestamps are Unix seconds (number | null | undefined).
const toISO = (ts: number | null | undefined): string | null =>
  ts ? new Date(ts * 1000).toISOString() : null;

export async function action({ request }: Route.ActionArgs) {
  const sig = request.headers.get("stripe-signature");

  // 1. Read raw body — Stripe signature verification requires exact raw bytes.
  let body: string;
  try {
    body = await request.text();
  } catch (err) {
    console.error("[webhook] Failed to read request body:", err);
    return new Response("Failed to read body", { status: 400 });
  }

  // 2. Verify signature and parse event.
  let event: Stripe.Event;
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !secret) {
      throw new Error(
        `Missing ${!sig ? "stripe-signature header" : "STRIPE_WEBHOOK_SECRET env var"}`
      );
    }
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] Signature verification failed:", msg);
    return new Response(msg, { status: 400 });
  }

  console.log(`[webhook] Received event: ${event.type} (${event.id})`);

  // 3. Handle event — service role client bypasses RLS.
  //    Any Supabase error throws so the outer catch returns 400,
  //    which tells Stripe to retry. 200 is only returned after all writes succeed.
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // ── Idempotency check — skip duplicate event deliveries ─────────────────
    const { data: existing } = await supabase
      .from("stripe_events")
      .select("id")
      .eq("event_id", event.id)
      .single();

    if (existing) {
      console.log(`[webhook] Duplicate event ${event.id} — skipping`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }

    await supabase.from("stripe_events").insert({ event_id: event.id });

    switch (event.type) {
      // ── New subscription created via Checkout ──────────────────────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        if (!session.subscription) break;

        const profileId = session.metadata?.profile_id;
        const customerId = session.customer as string;

        if (!profileId) {
          console.warn("[webhook] checkout.session.completed — missing profile_id in metadata", {
            metadata: session.metadata,
          });
          break;
        }

        // Fetch full subscription — the session object does not include
        // current_period_start / current_period_end; those live on the subscription.
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );

        if (!subscription) {
          console.error("[webhook] Could not retrieve subscription from Stripe:", session.subscription);
          return new Response("subscription not found", { status: 400 });
        }

        const item = subscription.items.data[0];
        const priceId = item?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        const periodStart = toISO((item as Record<string, unknown>)?.current_period_start as number | null ?? subscription.current_period_start);
        const periodEnd   = toISO((item as Record<string, unknown>)?.current_period_end   as number | null ?? subscription.current_period_end);

        console.log("[webhook] subscription object:", {
          id: subscription.id,
          status: subscription.status,
          item_period_start: (item as Record<string, unknown>)?.current_period_start,
          sub_period_start: subscription.current_period_start,
          resolved_start: periodStart,
          resolved_end: periodEnd,
        });

        // Check-then-insert/update to avoid duplicate rows
        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("stripe_subscription_id", subscription.id)
          .single();

        if (existingSub) {
          console.log("[webhook] Updating existing subscription row");
          const { error } = await supabase
            .from("subscriptions")
            .update({
              status: subscription.status,
              stripe_price_id: priceId,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              cancelled_at: toISO(subscription.canceled_at),
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscription.id);
          if (error) {
            console.error("[webhook] subscriptions update failed:", error.message, error.details);
            throw new Error(`subscriptions update: ${error.message}`);
          }
        } else {
          console.log("[webhook] Inserting new subscription row");
          const { error } = await supabase
            .from("subscriptions")
            .insert({
              stripe_subscription_id: subscription.id,
              profile_id: profileId,
              stripe_customer_id: subscription.customer as string,
              stripe_price_id: priceId,
              status: subscription.status,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              cancelled_at: toISO(subscription.canceled_at),
            });
          if (error) {
            console.error("[webhook] subscriptions insert failed:", error.message, error.details);
            throw new Error(`subscriptions insert: ${error.message}`);
          }
        }

        console.log("[webhook] subscriptions write succeeded");

        if (planId) {
          console.log("[webhook] Updating profiles plan_id:", planId, "customer:", customerId);
          const { error } = await supabase
            .from("profiles")
            .update({ plan_id: planId, stripe_customer_id: customerId })
            .eq("id", profileId);
          if (error) {
            console.error("[webhook] profiles update failed:", error.message, error.details);
            throw new Error(`profiles update: ${error.message}`);
          }
          console.log("[webhook] profiles update succeeded — plan_id set to", planId);
        } else {
          console.warn("[webhook] No plan mapping found for price:", priceId);
        }

        console.log(`[webhook] checkout.session.completed — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Subscription cancelled ─────────────────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const profileId = sub.metadata?.profile_id;

        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("stripe_subscription_id", sub.id)
          .single();

        if (existingSub) {
          const { error } = await supabase
            .from("subscriptions")
            .update({ status: "canceled", updated_at: new Date().toISOString() })
            .eq("stripe_subscription_id", sub.id);
          if (error) {
            console.error("[webhook] subscriptions cancel failed:", error.message, error.details);
            throw new Error(`subscriptions cancel: ${error.message}`);
          }
          console.log("[webhook] subscriptions cancel succeeded");
        } else {
          console.warn("[webhook] subscription.deleted — no matching row for", sub.id);
        }

        if (profileId) {
          const { error } = await supabase
            .from("profiles")
            .update({ plan_id: 1 })
            .eq("id", profileId);
          if (error) {
            console.error("[webhook] profiles plan reset failed:", error.message, error.details);
            throw new Error(`profiles plan reset: ${error.message}`);
          }
          console.log("[webhook] profiles plan reset to 1");
        }

        console.log(`[webhook] subscription.deleted — profile ${profileId}`);
        break;
      }

      // ── Subscription updated (renewal, plan change, etc.) ─────────────────
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const profileId = sub.metadata?.profile_id;
        const item = sub.items.data[0];
        const priceId = item?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        const periodStart = toISO((item as Record<string, unknown>)?.current_period_start as number | null ?? sub.current_period_start);
        const periodEnd   = toISO((item as Record<string, unknown>)?.current_period_end   as number | null ?? sub.current_period_end);

        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("stripe_subscription_id", sub.id)
          .single();

        if (existingSub) {
          const { error } = await supabase
            .from("subscriptions")
            .update({
              status: sub.status,
              stripe_price_id: priceId,
              current_period_start: periodStart,
              current_period_end: periodEnd,
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", sub.id);
          if (error) {
            console.error("[webhook] subscriptions update failed:", error.message, error.details);
            throw new Error(`subscriptions update: ${error.message}`);
          }
          console.log("[webhook] subscriptions update succeeded");
        } else {
          console.warn("[webhook] subscription.updated — no matching row for", sub.id);
        }

        if (profileId && planId) {
          const { error } = await supabase
            .from("profiles")
            .update({ plan_id: planId })
            .eq("id", profileId);
          if (error) {
            console.error("[webhook] profiles plan update failed:", error.message, error.details);
            throw new Error(`profiles plan update: ${error.message}`);
          }
          console.log("[webhook] profiles plan update succeeded — plan_id set to", planId);
        }

        console.log(`[webhook] subscription.updated — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Stripe Connect account updated ─────────────────────────────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account;

        if (account.charges_enabled) {
          console.log("[webhook] Attempting connect status update:", {
            stripe_connect_id: account.id,
            stripe_connect_status: "active",
          });

          const { error } = await supabase
            .from("profiles")
            .update({ stripe_connect_status: "active" })
            .eq("stripe_connect_id", account.id);

          if (error) {
            console.error("[webhook] connect status update failed:", error.message, error.details);
            throw new Error(`connect status update: ${error.message}`);
          }

          console.log(`[webhook] account.updated — connect ${account.id} is now active`);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] Handler error:", msg);
    return new Response(msg, { status: 400 });
  }

  // Only reached after all Supabase writes succeed
  console.log(`[webhook] All writes complete — returning 200 for ${event.type}`);
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// No UI — action-only route
export default function ApiStripeWebhook() {
  return null;
}
