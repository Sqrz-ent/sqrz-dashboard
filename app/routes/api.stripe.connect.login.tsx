import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getStripeClient, resolveStripeMode } from "~/lib/stripe-mode.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const url = new URL(request.url);
  const formData = await request.formData();
  const mode = resolveStripeMode(
    (formData.get("mode") as string | null) ?? url.searchParams.get("mode"),
    Boolean(profile.is_beta)
  );
  const stripe = getStripeClient(mode);
  if (!stripe) {
    return Response.json({ error: `Stripe ${mode} mode is not configured.` }, { status: 500, headers });
  }

  const connectId =
    mode === "test"
      ? (profile.stripe_connect_id_test as string | undefined)
      : (profile.stripe_connect_id as string | undefined);
  if (!connectId) {
    return redirect("/?panel=account", { headers });
  }

  const loginLink = await stripe.accounts.createLoginLink(connectId);
  return Response.json({ url: loginLink.url }, { headers });
}
