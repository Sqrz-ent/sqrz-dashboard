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

        const priceId = subscription.items.data[0]?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        console.log("[webhook] subscription object:", {
          id: subscription.id,
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
        });

        const subPayload = {
          profile_id: profileId,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: subscription.customer as string,
          stripe_price_id: priceId,
          status: subscription.status,
          current_period_start: toISO(subscription.current_period_start),
          current_period_end: toISO(subscription.current_period_end),
          cancelled_at: toISO(subscription.canceled_at),
          updated_at: new Date().toISOString(),
        };

        console.log("[webhook] Attempting Supabase write:", {
          profile_id: profileId,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
        });

        const { error: insertError } = await supabase
          .from("subscriptions")
          .upsert(subPayload, { onConflict: "stripe_subscription_id" });

        if (insertError) {
          console.error("[webhook] subscriptions upsert failed:", insertError.message, insertError.details);
          throw new Error(`subscriptions upsert: ${insertError.message}`);
        }

        console.log("[webhook] subscriptions upsert succeeded");

        if (planId) {
          const profilePayload = { plan_id: planId, stripe_customer_id: customerId };
          console.log("[webhook] Attempting profiles update:", { profile_id: profileId, ...profilePayload });

          const { error: updateError } = await supabase
            .from("profiles")
            .update(profilePayload)
            .eq("id", profileId);

          if (updateError) {
            console.error("[webhook] profiles update failed:", updateError.message, updateError.details);
            throw new Error(`profiles update: ${updateError.message}`);
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

        console.log("[webhook] Attempting subscriptions cancel update:", {
          stripe_subscription_id: sub.id,
          status: "canceled",
        });

        const { error: subError } = await supabase
          .from("subscriptions")
          .update({ status: "canceled" })
          .eq("stripe_subscription_id", sub.id);

        if (subError) {
          console.error("[webhook] subscriptions cancel failed:", subError.message, subError.details);
          throw new Error(`subscriptions cancel: ${subError.message}`);
        }

        console.log("[webhook] subscriptions cancel succeeded");

        if (profileId) {
          console.log("[webhook] Attempting profiles plan reset:", { profile_id: profileId, plan_id: 1 });

          const { error: profileError } = await supabase
            .from("profiles")
            .update({ plan_id: 1 })
            .eq("id", profileId);

          if (profileError) {
            console.error("[webhook] profiles plan reset failed:", profileError.message, profileError.details);
            throw new Error(`profiles plan reset: ${profileError.message}`);
          }

          console.log("[webhook] profiles plan reset succeeded");
        }

        console.log(`[webhook] subscription.deleted — profile ${profileId}`);
        break;
      }

      // ── Subscription updated (renewal, plan change, etc.) ─────────────────
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const profileId = sub.metadata?.profile_id;
        const priceId = sub.items.data[0]?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        const subPayload = {
          status: sub.status,
          stripe_price_id: priceId,
          current_period_start: toISO(sub.current_period_start),
          current_period_end: toISO(sub.current_period_end),
        };

        console.log("[webhook] Attempting subscriptions update:", {
          stripe_subscription_id: sub.id,
          status: sub.status,
        });

        const { error: subError } = await supabase
          .from("subscriptions")
          .update(subPayload)
          .eq("stripe_subscription_id", sub.id);

        if (subError) {
          console.error("[webhook] subscriptions update failed:", subError.message, subError.details);
          throw new Error(`subscriptions update: ${subError.message}`);
        }

        console.log("[webhook] subscriptions update succeeded");

        if (profileId && planId) {
          console.log("[webhook] Attempting profiles plan update:", { profile_id: profileId, plan_id: planId });

          const { error: profileError } = await supabase
            .from("profiles")
            .update({ plan_id: planId })
            .eq("id", profileId);

          if (profileError) {
            console.error("[webhook] profiles plan update failed:", profileError.message, profileError.details);
            throw new Error(`profiles plan update: ${profileError.message}`);
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
