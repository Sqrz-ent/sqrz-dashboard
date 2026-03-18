import type { Route } from "./+types/api.stripe.webhook";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { stripe, PRICE_TO_PLAN } from "~/lib/stripe.server";

export async function action({ request }: Route.ActionArgs) {
  const sig = request.headers.get("stripe-signature");

  // 1. Read raw body — must happen before any other body consumption.
  //    Stripe signature verification requires the exact raw bytes.
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

  // 3. Handle event — use service role client so RLS does not block
  //    inserts/updates. Webhook requests come from Stripe with no session.
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    switch (event.type) {
      // ── New subscription created via Checkout ──────────────────────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;

        const profileId = session.metadata?.profile_id;
        const subscriptionId = session.subscription as string;
        const customerId = session.customer as string;

        if (!profileId || !subscriptionId) {
          console.warn("[webhook] checkout.session.completed missing profileId or subscriptionId");
          break;
        }

        // Retrieve subscription to get price details
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0]?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        const { error: insertError } = await supabase.from("subscriptions").insert({
          profile_id: profileId,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: customerId,
          stripe_price_id: priceId,
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        });

        if (insertError) {
          console.error("[webhook] subscriptions insert error:", insertError.message);
        }

        if (planId) {
          const { error: updateError } = await supabase
            .from("profiles")
            .update({ plan_id: planId, stripe_customer_id: customerId })
            .eq("id", profileId);

          if (updateError) {
            console.error("[webhook] profiles plan_id update error:", updateError.message);
          }
        }

        console.log(`[webhook] checkout.session.completed — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Subscription cancelled ─────────────────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const profileId = sub.metadata?.profile_id;

        const { error: subError } = await supabase
          .from("subscriptions")
          .update({ status: "canceled" })
          .eq("stripe_subscription_id", sub.id);

        if (subError) {
          console.error("[webhook] subscription cancel update error:", subError.message);
        }

        if (profileId) {
          const { error: profileError } = await supabase
            .from("profiles")
            .update({ plan_id: 1 })
            .eq("id", profileId);

          if (profileError) {
            console.error("[webhook] profiles plan reset error:", profileError.message);
          }
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

        const { error: subError } = await supabase
          .from("subscriptions")
          .update({
            status: sub.status,
            stripe_price_id: priceId,
            current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);

        if (subError) {
          console.error("[webhook] subscription update error:", subError.message);
        }

        if (profileId && planId) {
          const { error: profileError } = await supabase
            .from("profiles")
            .update({ plan_id: planId })
            .eq("id", profileId);

          if (profileError) {
            console.error("[webhook] profiles plan update error:", profileError.message);
          }
        }

        console.log(`[webhook] subscription.updated — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Stripe Connect account updated ─────────────────────────────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account;

        if (account.charges_enabled) {
          const { error } = await supabase
            .from("profiles")
            .update({ stripe_connect_status: "active" })
            .eq("stripe_connect_id", account.id);

          if (error) {
            console.error("[webhook] connect status update error:", error.message);
          } else {
            console.log(`[webhook] account.updated — connect ${account.id} is now active`);
          }
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

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// No UI — action-only route
export default function ApiStripeWebhook() {
  return null;
}
