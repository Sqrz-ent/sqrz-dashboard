import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

export async function action({ request }: { request: Request }) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const connectId = profile.stripe_connect_id as string | undefined;
  if (!connectId) {
    return redirect("/?panel=account", { headers });
  }

  const loginLink = await stripe.accounts.createLoginLink(connectId);
  return Response.json({ url: loginLink.url }, { headers });
}
