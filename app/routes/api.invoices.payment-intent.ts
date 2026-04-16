import Stripe from "stripe";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

export async function action({ request }: { request: Request }) {
  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as { booking_id?: string };
  const { booking_id } = body;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const paymentIntent = await stripe.paymentIntents.create({
    amount: 150,
    currency: "usd",
    metadata: {
      type: "invoice_fee",
      profile_id: profile.id as string,
      booking_id: booking_id ?? "",
    },
    description: "SQRZ Invoice Generation Fee",
  });

  return Response.json({ client_secret: paymentIntent.client_secret });
}
