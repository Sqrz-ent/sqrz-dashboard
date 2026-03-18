import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { createSupabaseServerClient } from "~/lib/supabase.server";

function parseCookie(header: string, name: string): string {
  const match = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

/**
 * Handles the redirect back from Supabase after a magic link click.
 * Exchanges the one-time code for a session (PKCE), then routes the user:
 *   - guest / no profile → booking page (decodedNext)
 *   - member → dashboard, writing slug/ref from cookies if present
 */
export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");

  // 1. Exchange PKCE code for session — must happen before getUser()
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[callback] code exchange error:", error);
      return redirect("/login?error=auth_failed", { headers: responseHeaders });
    }
  }

  // 2. Now the session cookie is set — getUser() will succeed
  const { data: { user } } = await supabase.auth.getUser();
  console.log("[callback] user after exchange:", user?.id, user?.email);

  if (!user) {
    return redirect("/login?error=no_user", { headers: responseHeaders });
  }

  // 3. Check profile type to decide where to send the user
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, user_type")
    .eq("user_id", user.id)
    .maybeSingle();
  console.log("[callback] profile:", profile);

  const decodedNext = next ? decodeURIComponent(next) : null;

  // Guest (team invite) or no profile yet → go to booking page
  if (!profile || profile.user_type === "guest") {
    return redirect(decodedNext ?? "/", { headers: responseHeaders });
  }

  // ── Member signup path ──────────────────────────────────────────────────────
  // Write slug + ref from cookies set in /join before the magic link was sent

  const cookieHeader = request.headers.get("Cookie") ?? "";
  const slug =
    parseCookie(cookieHeader, "sqrz_pending_handle") ||
    (user.user_metadata?.slug as string | undefined) ||
    "";
  const refCode =
    parseCookie(cookieHeader, "sqrz_pending_ref") ||
    (user.user_metadata?.ref_code as string | undefined) ||
    "";

  // Clear the pending cookies
  responseHeaders.append("Set-Cookie", "sqrz_pending_handle=; path=/; max-age=0; SameSite=Lax");
  responseHeaders.append("Set-Cookie", "sqrz_pending_ref=; path=/; max-age=0; SameSite=Lax");

  // Prevent duplicate profiles — if another row already has this email, redirect in
  if (user.email) {
    const { data: duplicate } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", user.email)
      .neq("user_id", user.id)
      .maybeSingle();

    if (duplicate) {
      return redirect(decodedNext ?? "/", { headers: responseHeaders });
    }
  }

  // Write all required fields to the profile row
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
        ...(refCode ? { referred_by_code: refCode } : {}),
      })
      .eq("user_id", user.id);
  }

  return redirect(decodedNext ?? "/", { headers: responseHeaders });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
