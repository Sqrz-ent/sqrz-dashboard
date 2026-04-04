import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const customerId = profile.stripe_customer_id as string | undefined;
  if (!customerId) {
    return Response.json({ error: "No billing account found" }, { headers });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com"}/payments`,
  });

  return Response.json({ url: session.url }, { headers });
}
