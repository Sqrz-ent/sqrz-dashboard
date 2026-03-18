import { redirect } from "react-router";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

export async function action({ request }: { request: Request }) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers: responseHeaders });

  const connectId = profile.stripe_connect_id as string | undefined;
  if (!connectId) {
    return redirect("/?panel=account", { headers: responseHeaders });
  }

  const loginLink = await stripe.accounts.createLoginLink(connectId);
  return redirect(loginLink.url, { headers: responseHeaders });
}
