import { redirect } from "react-router";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { Route } from "./+types/auth.callback";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const token = url.searchParams.get("token");
  const type = url.searchParams.get("type");
  const next = url.searchParams.get("next");

  const headers = new Headers();

  const supabase = createServerClient(
    import.meta.env.VITE_SUPABASE_URL as string,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
    {
      cookies: {
        getAll() {
          return parseCookieHeader(request.headers.get("Cookie") ?? "")
            .filter((c): c is { name: string; value: string } => c.value !== undefined);
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            headers.append("Set-Cookie", serializeCookieHeader(name, value, options));
          });
        },
      },
    }
  );

  let user = null;

  if (code) {
    // PKCE flow (standard magic link, Google OAuth)
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("[callback] exchange error:", error.message);
      return redirect("/login?error=auth_failed", { headers });
    }
    user = data.user;
  } else if (token && type) {
    // Token flow (admin-generated magic links via generateLink())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: type === "invite" ? "invite" : (type as any),
    });
    if (error) {
      console.error("[callback] verifyOtp error:", error.message);
      return redirect("/login?error=auth_failed", { headers });
    }
    user = data.user;
    console.log("[callback] verifyOtp user:", user?.id, user?.email);
  }

  console.log("[callback] user:", user?.id, user?.email);

  if (!user) {
    return redirect("/login?error=no_user", { headers });
  }

  // Link auth user to existing profile if not already linked
  // Covers guests (team invites) and members whose profile was pre-created
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("id, user_type, user_id")
    .eq("email", user.email!)
    .maybeSingle();

  if (existingProfile && !existingProfile.user_id) {
    await supabase
      .from("profiles")
      .update({ user_id: user.id })
      .eq("id", existingProfile.id);
  }

  // Re-fetch profile by user_id now that it may have just been linked
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, user_type")
    .eq("user_id", user.id)
    .maybeSingle();

  console.log("[callback] profile:", profile?.id, profile?.user_type);

  const decodedNext = next ? decodeURIComponent(next) : null;

  // Guest or no profile → booking page or home
  if (!profile || profile.user_type === "guest") {
    return redirect(decodedNext ?? "/", { headers });
  }

  // Member → dashboard or intended destination
  return redirect(decodedNext ?? "/", { headers });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
