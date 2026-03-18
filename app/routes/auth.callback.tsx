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

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");

  const { supabase, headers } = createSupabaseServerClient(request);

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[callback] exchange error:", error.message);
      return redirect("/login?error=auth_failed", { headers });
    }
  }

  const { data: { user } } = await supabase.auth.getUser();
  console.log("[callback] user:", user?.id, user?.email);

  if (!user) {
    return redirect("/login?error=no_user", { headers });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, user_type")
    .eq("user_id", user.id)
    .maybeSingle();

  console.log("[callback] profile:", profile?.id, profile?.user_type);

  const decodedNext = next ? decodeURIComponent(next) : null;

  // Guest or no profile → go to booking or home
  if (!profile || profile.user_type === "guest") {
    return redirect(decodedNext ?? "/", { headers });
  }

  // Member signup path — write slug/ref from cookies set in /join
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const slug =
    parseCookie(cookieHeader, "sqrz_pending_handle") ||
    (user.user_metadata?.slug as string | undefined) ||
    "";
  const refCode =
    parseCookie(cookieHeader, "sqrz_pending_ref") ||
    (user.user_metadata?.ref_code as string | undefined) ||
    "";

  headers.append("Set-Cookie", "sqrz_pending_handle=; path=/; max-age=0; SameSite=Lax");
  headers.append("Set-Cookie", "sqrz_pending_ref=; path=/; max-age=0; SameSite=Lax");

  if (user.email) {
    const { data: duplicate } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", user.email)
      .neq("user_id", user.id)
      .maybeSingle();

    if (duplicate) {
      return redirect(decodedNext ?? "/", { headers });
    }
  }

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

  return redirect(decodedNext ?? "/", { headers });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
