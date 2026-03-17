import { redirect } from "react-router";
import type { Route } from "./+types/api.stripe.connect";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { stripe } from "~/lib/stripe.server";

export async function action({ request }: Route.ActionArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return redirect("/login", { headers: responseHeaders });

  const profile = await getCurrentProfile(supabase, session.user.id);
  if (!profile) return redirect("/login", { headers: responseHeaders });

  const publicUrl = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";
  const returnUrl = `${publicUrl}/?panel=account`;
  const refreshUrl = `${publicUrl}/api/stripe/connect`;

  let connectId = profile.stripe_connect_id as string | undefined;

  // Create a new Connect Express account if none exists
  if (!connectId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: (profile.email as string) ?? undefined,
      metadata: {
        profile_id: profile.id as string,
        slug: (profile.slug as string) ?? "",
      },
    });

    connectId = account.id;

    await supabase
      .from("profiles")
      .update({
        stripe_connect_id: connectId,
        stripe_connect_status: "pending",
      })
      .eq("id", profile.id);
  }

  // Create an account onboarding link
  const accountLink = await stripe.accountLinks.create({
    account: connectId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

  return redirect(accountLink.url, { headers: responseHeaders });
}

// No UI — action-only route
export default function ApiStripeConnect() {
  return null;
}
