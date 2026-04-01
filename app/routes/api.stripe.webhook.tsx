import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const PRICE_TO_PLAN: Record<string, number> = {
  [process.env.STRIPE_BASIC_PRICE_ID_MONTHLY!]: 1,
  [process.env.STRIPE_BASIC_PRICE_ID_YEARLY!]: 1,
  [process.env.STRIPE_GROW_PRICE_ID_MONTHLY!]: 2,
  [process.env.STRIPE_GROW_PRICE_ID_YEARLY!]: 2,
  [process.env.STRIPE_EARLY_ACCESS_PRICE_ID!]: 4,
};

const toISO = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toISOString() : null;

export async function action({ request }: { request: Request }) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig!,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("[webhook] signature error:", err.message);
    return new Response(err.message, { status: 400 });
  }

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

    // ── Boost ad budget payment ──────────────────────────────────────────────
    const BOOST_PAYMENT_LINK_IDS = [
      "test_5kQ28q1Bt1ds8J01QU57W00",
      "test_eVq14m6VN3lA9N4dzC57W04",
      "test_bJeaEWgwn2hwe3k0MQ57W02",
      "test_7sY9AScg7f4i8J0cvy57W03",
    ];

    const isBoostPayment =
      session.payment_link &&
      BOOST_PAYMENT_LINK_IDS.some((id) => (session.payment_link as string).includes(id));

    if (isBoostPayment) {
      const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
      const amountEur = (session.amount_total ?? 0) / 100;

      console.log("[webhook] boost payment received:", customerEmail, amountEur);

      // Find profile by email
      let profileId: string | null = null;
      if (customerEmail) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("email", customerEmail)
          .maybeSingle();
        profileId = profile?.id ?? null;
      }

      // Update campaign status to active
      if (profileId) {
        const { error: campaignError } = await supabase
          .from("boost_campaigns")
          .update({ status: "active" })
          .eq("profile_id", profileId)
          .eq("status", "pending");
        if (campaignError) {
          console.error("[webhook] boost campaign update failed:", campaignError);
        } else {
          console.log("[webhook] boost campaign activated for profile:", profileId);
        }
      }

      // Notify will@sqrz.com via Resend
      try {
        const { Resend } = await import("resend");
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "noreply@sqrz.com",
          to: "will@sqrz.com",
          subject: `New Boost payment — ${amountEur}€`,
          html: `
            <p>A new Boost ad budget payment has been received.</p>
            <p><strong>Amount:</strong> €${amountEur}</p>
            <p><strong>Customer:</strong> ${customerEmail}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p>Log in to the dashboard to review and activate the campaign.</p>
          `,
        });
        console.log("[webhook] boost notification email sent");
      } catch (emailErr) {
        console.error("[webhook] boost notification email failed:", emailErr);
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
    const planId = PRICE_TO_PLAN[priceId] ?? 1;

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

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const item = subscription.items.data[0];

    await supabase.rpc("upsert_subscription", {
      p_stripe_subscription_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_stripe_price_id: item.price.id,
      p_status: "cancelled",
      p_profile_id: null,
      p_current_period_start: toISO(item.current_period_start),
      p_current_period_end: toISO(item.current_period_end),
    });

    // Reset plan to Basic
    await supabase
      .from("profiles")
      .update({ plan_id: 1 })
      .eq("stripe_customer_id", subscription.customer as string);
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const item = subscription.items.data[0];

    await supabase.rpc("upsert_subscription", {
      p_stripe_subscription_id: subscription.id,
      p_stripe_customer_id: subscription.customer as string,
      p_stripe_price_id: item.price.id,
      p_status: subscription.status,
      p_profile_id: null,
      p_current_period_start: toISO(item.current_period_start),
      p_current_period_end: toISO(item.current_period_end),
    });
  }

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const status = account.charges_enabled ? "active" : "pending";
    await supabase
      .from("profiles")
      .update({ stripe_connect_status: status })
      .eq("stripe_connect_id", account.id);
    console.log("[webhook] connect account", account.id, "→", status);
  }

  return Response.json({ received: true });
}
