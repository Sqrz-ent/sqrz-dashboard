import { redirect } from "react-router";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { Route } from "./+types/auth.callback";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
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

  if (!code) {
    return redirect("/login?error=no_code", { headers });
  }

  const { data: exchangeData, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[callback] exchange error:", error.message);
    return redirect("/login?error=auth_failed", { headers });
  }

  // Use the user from the exchange response directly — getUser() on the
  // same request would read the old empty cookie state before Set-Cookie fires
  const user = exchangeData?.user;
  console.log("[callback] user from exchange:", user?.id, user?.email);

  if (!user) {
    console.error("[callback] no user in exchange response");
    return redirect("/login?error=no_user", { headers });
  }

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
