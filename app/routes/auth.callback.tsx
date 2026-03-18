import { redirect } from "react-router";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { Route } from "./+types/auth.callback";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  const headers = new Headers();

  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
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

  // Handle PKCE code flow
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  // Handle token hash flow (magic links, invites)
  if (token_hash && type) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.auth.verifyOtp({ token_hash, type: type as any });
  }

  // The database trigger handles ALL profile creation/linking automatically.
  // Just redirect — session cookie is set via headers.
  const decodedNext = next ? decodeURIComponent(next) : null;

  return redirect(decodedNext ?? "/", { headers });
}

// No UI — this route only runs a server loader and redirects
export default function AuthCallback() {
  return null;
}
