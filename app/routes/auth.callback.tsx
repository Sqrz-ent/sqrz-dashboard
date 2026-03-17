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
      return redirect("/login?error=Authentication+failed", { headers: responseHeaders });
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const slug = user.user_metadata?.slug as string | undefined;

    // Bug 3: Prevent duplicate profiles — if another row already has this email, redirect
    if (user.email) {
      const { data: duplicate } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", user.email)
        .neq("user_id", user.id)
        .maybeSingle();

      if (duplicate) {
        return redirect("/", { headers: responseHeaders });
      }
    }

    // Bug 2: Write all required fields on profile creation — never use email as name
    if (slug) {
      await supabase
        .from("profiles")
        .update({
          user_id: user.id,
          slug,
          username: slug,
          name: slug,
          email: user.email,
          is_published: false,
          is_claimed: true,
          created_by: "signup",
          user_type: "member",
        })
        .eq("user_id", user.id);
    }
  }

  return redirect("/", { headers: responseHeaders });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
