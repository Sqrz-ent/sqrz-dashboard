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
 * Exchanges the one-time code for a session, then writes the profile row
 * using the handle and ref code stored in cookies before the user left.
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

  // Decode the `next` redirect param (may contain nested query string like ?token=xxx)
  const next = url.searchParams.get("next");
  const decodedNext = next ? decodeURIComponent(next) : null;

  if (user) {
    // Check whether this is a guest user (team invite) or a signup member
    const { data: profile } = await supabase
      .from("profiles")
      .select("user_type")
      .eq("user_id", user.id)
      .maybeSingle();

    // Guests go directly to their booking page — skip signup profile writing
    if (!profile || profile.user_type === "guest") {
      return redirect(decodedNext ?? "/", { headers: responseHeaders });
    }

    // ── Member signup path ────────────────────────────────────────────────────

    // Read handle and ref from cookies set before the magic link was sent
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

    // Prevent duplicate profiles — if another row already has this email, just redirect in
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
  }

  return redirect(decodedNext ?? "/", { headers: responseHeaders });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
