import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { createSupabaseServerClient } from "~/lib/supabase.server";

/**
 * Handles the redirect back from Supabase after a magic link click.
 * Exchanges the one-time code for a session cookie, then ensures
 * the profile row has the slug the user chose at signup.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("exchangeCodeForSession error:", error.message);
      return redirect("/join", { headers: responseHeaders });
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Check if the profile row (created by handle_new_user trigger) already has a slug
    const { data: profile } = await supabase
      .from("profiles")
      .select("slug, user_type")
      .eq("id", user.id)
      .maybeSingle();

    const slug = user.user_metadata?.slug as string | undefined;

    if (slug && !profile?.slug) {
      await supabase
        .from("profiles")
        .update({ slug, name: slug, user_type: "member" })
        .eq("id", user.id);
    }
  }

  return redirect("/", { headers: responseHeaders });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
