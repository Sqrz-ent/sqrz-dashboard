import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { createBrowserClient } from "@supabase/ssr";
import type { Route } from "./+types/auth.callback";

// ─── Server loader ────────────────────────────────────────────────────────────
// Implicit flow: session arrives as a hash fragment, invisible to the server.
// Loader just renders the page shell; client handles everything.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function loader(_: Route.LoaderArgs) {
  return Response.json({});
}

// ─── Client component ─────────────────────────────────────────────────────────

export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const supabase = createBrowserClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
      {
        auth: {
          flowType: "implicit",
          detectSessionInUrl: true,
        },
      }
    );

    const nextParam = searchParams.get("next");
    const decodedNext = nextParam ? decodeURIComponent(nextParam) : "/";
    const destination = decodedNext.startsWith("/booking/") ? decodedNext : "/";

    function handleError(desc: string) {
      document.body.innerHTML = `
        <div style="min-height:100vh;background:#111;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif">
          <div style="text-align:center;padding:40px;max-width:420px">
            <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:.25em">[<span style="color:#F5A623"> SQRZ </span>]</span>
            <h2 style="color:#fff;margin:24px 0 8px">Link expired</h2>
            <p style="color:rgba(255,255,255,.5);font-size:14px;margin:0 0 24px">${desc.replace(/\+/g, " ")}</p>
            <p style="color:rgba(255,255,255,.35);font-size:13px">Please ask to be reinvited.</p>
          </div>
        </div>
      `;
    }

    // Check for hash error first (e.g. expired link)
    const hash = window.location.hash;
    if (hash) {
      const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
      if (hashParams.get("error")) {
        handleError(hashParams.get("error_description") ?? "This link has expired.");
        return;
      }
    }

    async function afterSignIn(userId: string, email: string | undefined) {
      // Link booking_participants row to this user
      if (email) {
        await supabase
          .from("booking_participants")
          .update({ user_id: userId, joined_at: new Date().toISOString() })
          .eq("email", email)
          .is("user_id", null);
      }

      // Apply pending handle / referral set during the join flow
      const pendingHandle = document.cookie.match(/sqrz_pending_handle=([^;]+)/)?.[1];
      const pendingRef    = document.cookie.match(/sqrz_pending_ref=([^;]+)/)?.[1];

      if (pendingHandle || pendingRef) {
        if (pendingHandle) {
          // Only update slug if not already taken by another profile
          const { data: taken } = await supabase
            .from("profiles")
            .select("id")
            .eq("slug", pendingHandle)
            .neq("user_id", userId)
            .maybeSingle();

          if (!taken) {
            await supabase.from("profiles").update({ slug: pendingHandle }).eq("user_id", userId);
          }
        }

        if (pendingRef) {
          await supabase
            .from("profiles")
            .update({ referred_by_code: pendingRef })
            .eq("user_id", userId)
            .is("referred_by_code", null);
        }

        // Clear pending cookies
        document.cookie = "sqrz_pending_handle=; Path=/; Max-Age=0";
        document.cookie = "sqrz_pending_ref=; Path=/; Max-Age=0";
      }

      navigate(destination, { replace: true });
    }

    // onAuthStateChange fires as soon as detectSessionInUrl processes the hash
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        subscription.unsubscribe();
        afterSignIn(session.user.id, session.user.email);
      }
    });

    // Also check if already signed in (page reload / token already in storage)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        subscription.unsubscribe();
        afterSignIn(session.user.id, session.user.email);
      }
    });

    return () => subscription.unsubscribe();
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
