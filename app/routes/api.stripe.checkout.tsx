import { redirect } from "react-router";
import type { Route } from "./+types/api.stripe.checkout";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe, getOrCreateStripeCustomer } from "~/lib/stripe.server";

export async function action({ request }: Route.ActionArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return redirect("/login", { headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, session.user.id);
  if (!profile) return redirect("/login", { headers: responseHeaders });

  const formData = await request.formData();
  const priceId = formData.get("price_id") as string;

  if (!priceId) {
    return Response.json({ error: "Missing price_id" }, { status: 400 });
  }

  const customerId = await getOrCreateStripeCustomer(supabase, profile);
  const publicUrl = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${publicUrl}/?upgraded=true`,
    cancel_url: `${publicUrl}/`,
    metadata: {
      profile_id: profile.id as string,
    },
    subscription_data: {
      metadata: {
        profile_id: profile.id as string,
      },
    },
  });

  if (!checkoutSession.url) {
    return Response.json({ error: "Failed to create checkout session" }, { status: 500 });
  }

  return redirect(checkoutSession.url, { headers: responseHeaders });
}

// No UI — action-only route
export default function ApiStripeCheckout() {
  return null;
}
