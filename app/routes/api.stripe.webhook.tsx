import type { Route } from "./+types/api.stripe.webhook";
import Stripe from "stripe";
import { stripe, PRICE_TO_PLAN } from "~/lib/stripe.server";
import { createSupabaseServerClient } from "~/lib/supabase.server";

// Stripe requires the raw body for signature verification —
// do NOT parse as JSON before calling constructEvent.
export async function action({ request }: Route.ActionArgs) {
  const sig = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return Response.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[webhook] Signature verification failed:", msg);
    return Response.json({ error: `Webhook signature invalid: ${msg}` }, { status: 400 });
  }

  // Use a service-role client so webhook handlers can bypass RLS
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  try {
    switch (event.type) {
      // ── New subscription created via Checkout ──────────────────────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;

        const profileId = session.metadata?.profile_id;
        const subscriptionId = session.subscription as string;
        const customerId = session.customer as string;

        if (!profileId || !subscriptionId) break;

        // Retrieve subscription to get price details
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0]?.price.id ?? "";
        const planId = PRICE_TO_PLAN[priceId] ?? null;

        // Insert subscription record
        await supabase.from("subscriptions").insert({
          profile_id: profileId,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: customerId,
          stripe_price_id: priceId,
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        });

        // Update plan on profile
        if (planId) {
          await supabase
            .from("profiles")
            .update({ plan_id: planId, stripe_customer_id: customerId })
            .eq("id", profileId);
        }

        console.log(`[webhook] checkout.session.completed — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Subscription cancelled ─────────────────────────────────────────────
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const profileId = sub.metadata?.profile_id;

        await supabase
          .from("subscriptions")
          .update({ status: "canceled" })
          .eq("stripe_subscription_id", sub.id);

        // Reset to free plan (plan_id = 1)
        if (profileId) {
          await supabase
            .from("profiles")
            .update({ plan_id: 1 })
            .eq("id", profileId);
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

        await supabase
          .from("subscriptions")
          .update({
            status: sub.status,
            stripe_price_id: priceId,
            current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);

        if (profileId && planId) {
          await supabase
            .from("profiles")
            .update({ plan_id: planId })
            .eq("id", profileId);
        }

        console.log(`[webhook] subscription.updated — profile ${profileId}, plan ${planId}`);
        break;
      }

      // ── Stripe Connect account updated ─────────────────────────────────────
      case "account.updated": {
        const account = event.data.object as Stripe.Account;

        if (account.charges_enabled) {
          await supabase
            .from("profiles")
            .update({ stripe_connect_status: "active" })
            .eq("stripe_connect_id", account.id);

          console.log(`[webhook] account.updated — connect ${account.id} is now active`);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[webhook] Handler error:", msg);
    return Response.json({ error: "Handler error" }, { status: 500 });
  }

  return Response.json({ received: true }, { status: 200 });
}

// No UI — action-only route
export default function ApiStripeWebhook() {
  return null;
}
