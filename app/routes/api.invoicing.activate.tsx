import Stripe from "stripe";
import { redirect } from "react-router";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const E_INVOICE_ACTIVATION_AMOUNT = 2500;
const E_INVOICE_ACTIVATION_CURRENCY = "usd";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const hasPaidPlan = !!profile.plan_id && Number(profile.plan_id) > 0;
  const hasOneTimeUnlock = !!(profile.e_invoice_unlocked_at as string | null);
  if (hasPaidPlan || hasOneTimeUnlock) {
    return redirect("/service?einvoice=unlocked", { headers });
  }

  const origin = new URL(request.url).origin;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}/api/invoicing/activate?checkout_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/service?einvoice=cancelled`,
    client_reference_id: profile.id as string,
    customer_email: user.email ?? undefined,
    metadata: {
      type: "e_invoice_activation",
      profile_id: profile.id as string,
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: E_INVOICE_ACTIVATION_CURRENCY,
          unit_amount: E_INVOICE_ACTIVATION_AMOUNT,
          product_data: {
            name: "SQRZ E-invoice Activation",
            description: "One-time activation for structured e-invoices on the free plan",
          },
        },
      },
    ],
  });

  if (!session.url) {
    return Response.json({ error: "Could not start activation checkout" }, { status: 500, headers });
  }

  return redirect(session.url, { headers });
}

export async function loader({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const sessionId = new URL(request.url).searchParams.get("checkout_session_id");
  if (!sessionId) {
    return redirect("/service", { headers });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const sessionProfileId = session.metadata?.profile_id ?? session.client_reference_id ?? null;

  if (session.payment_status !== "paid" || session.metadata?.type !== "e_invoice_activation" || sessionProfileId !== profile.id) {
    return redirect("/service?einvoice=cancelled", { headers });
  }

  const adminClient = createSupabaseAdminClient();
  await adminClient
    .from("profiles")
    .update({
      e_invoice_unlocked_at: new Date().toISOString(),
      e_invoice_unlock_source: "one_time",
      e_invoice_enabled: true,
    })
    .eq("id", profile.id as string);

  return redirect("/service?einvoice=unlocked", { headers });
}
