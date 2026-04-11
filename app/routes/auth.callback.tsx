import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  console.log("[callback] SUPABASE_URL:", !!process.env.SUPABASE_URL);
  console.log("[callback] VITE_SUPABASE_URL:", !!process.env.VITE_SUPABASE_URL);
  console.log("[callback] code present:", !!code);

  if (code) {
    const headers = new Headers();
    const supabase = createServerClient(
      process.env.SUPABASE_URL!,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll: () => parseCookieHeader(request.headers.get("Cookie") ?? ""),
          setAll: (cookies) =>
            cookies.forEach(({ name, value, options }) =>
              headers.append("Set-Cookie", serializeCookieHeader(name, value, options))
            ),
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      headers.set("Location", next.startsWith("/booking") ? next : "/");
      return new Response(null, { status: 302, headers });
    }

    console.error("[callback] exchange error:", error);
  }

  return new Response(null, { status: 302, headers: { Location: "/" } });
}

export default function AuthCallback() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "rgba(255,255,255,0.5)",
        background: "#111111",
        fontSize: 14,
      }}
    >
      Signing you in…
    </div>
  );
}
