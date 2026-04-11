import { useEffect } from "react";
import { redirect, useNavigate, useSearchParams } from "react-router";
import { createServerClient, createBrowserClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Route } from "./+types/auth.callback";

// ─── Server loader — handles query-param flows (PKCE, token_hash) ─────────────

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

  // PKCE flow (standard magic link, OAuth)
  if (code) {
    const { data: sessionData } = await supabase.auth.exchangeCodeForSession(code);

    // Apply the user's chosen handle from the join form if present
    const cookieHeader = request.headers.get("Cookie") ?? "";
    const pendingHandle = cookieHeader.match(/sqrz_pending_handle=([^;]+)/)?.[1];
    const pendingRef    = cookieHeader.match(/sqrz_pending_ref=([^;]+)/)?.[1];

    if (sessionData?.user && (pendingHandle || pendingRef)) {
      const admin = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );

      // Check the handle isn't already taken by a different profile
      if (pendingHandle) {
        const { data: taken } = await admin
          .from("profiles")
          .select("id")
          .eq("slug", pendingHandle)
          .neq("user_id", sessionData.user.id)
          .maybeSingle();

        if (!taken) {
          await admin
            .from("profiles")
            .update({ slug: pendingHandle })
            .eq("user_id", sessionData.user.id);
        }
      }

      if (pendingRef) {
        await admin
          .from("profiles")
          .update({ referred_by_code: pendingRef })
          .eq("user_id", sessionData.user.id)
          .is("referred_by_code", null); // only set if not already set
      }

      // Clear the pending cookies
      headers.append("Set-Cookie", "sqrz_pending_handle=; Path=/; Max-Age=0");
      headers.append("Set-Cookie", "sqrz_pending_ref=; Path=/; Max-Age=0");
    }
  }

  
  // Token hash flow (admin-generated links)
  if (token_hash && type) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.auth.verifyOtp({ token_hash, type: type as any });
  }

  if (code || (token_hash && type)) {
    const decodedNext = next ? decodeURIComponent(next) : null;

    const { data: { user: authedUser } } = await supabase.auth.getUser();
    if (authedUser) {
      // Link user_id to booking_participants on any auth (e.g. claim flow)
      if (authedUser.email) {
        await supabase
          .from('booking_participants')
          .update({
            user_id: authedUser.id,
            joined_at: new Date().toISOString()
          })
          .eq('email', authedUser.email)
          .is('user_id', null);
      }

      // Follow /booking/ next param if present
      if (decodedNext?.startsWith('/booking/')) {
        return redirect(decodedNext, { headers });
      }
    }

    return redirect(decodedNext ?? "/", { headers });
  }

  // No query params — render the client component to handle hash fragment
  return null;
}


// ─── Client component — handles hash-fragment flows ───────────────────────────
// Supabase implicit flow puts access_token / error in window.location.hash
// which is invisible to the server loader.

export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;

    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const next = searchParams.get("next");
    const destination = next ? decodeURIComponent(next) : "/";

    // Hash contains an error (e.g. expired invite link)
    if (params.get("error")) {
      const errorDesc = params.get("error_description") ?? "This link has expired.";
      document.body.innerHTML = `
        <div style="min-height:100vh;background:#111;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif">
          <div style="text-align:center;padding:40px;max-width:420px">
            <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:.25em">[<span style="color:#F5A623"> SQRZ </span>]</span>
            <h2 style="color:#fff;margin:24px 0 8px">Link expired</h2>
            <p style="color:rgba(255,255,255,.5);font-size:14px;margin:0 0 24px">${errorDesc.replace(/\+/g, " ")}</p>
            <p style="color:rgba(255,255,255,.35);font-size:13px">Please ask to be reinvited.</p>
          </div>
        </div>
      `;
      return;
    }

    // Hash contains an access token (implicit flow)
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token") ?? "";

    if (access_token) {
      const supabase = createBrowserClient(
        import.meta.env.VITE_SUPABASE_URL as string,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
      );

      supabase.auth.setSession({ access_token, refresh_token }).then(() => {
        navigate(destination, { replace: true });
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111111",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "rgba(255,255,255,0.5)",
        fontSize: 14,
      }}
    >
      Signing you in…
    </div>
  );
}
