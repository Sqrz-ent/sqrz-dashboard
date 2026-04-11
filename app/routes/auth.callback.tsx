import { useEffect, useState } from "react";

export async function loader() {
  return {};
}

export default function AuthCallback() {
  const [status, setStatus] = useState("Signing you in…");

  useEffect(() => {
    const checkSession = async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            flowType: "implicit",
            detectSessionInUrl: true,
            persistSession: true,
          },
        }
      );

      // detectSessionInUrl: true auto-processes the #access_token hash fragment.
      // Give it a moment then check.
      await new Promise((r) => setTimeout(r, 500));

      const { data: { session } } = await supabase.auth.getSession();

      if (session) {
        const next = new URLSearchParams(window.location.search).get("next") ?? "/";
        window.location.replace(next.startsWith("/booking") ? next : "/");
        return;
      }

      // Listen for auth state change in case the 500ms wasn't enough
      const { data: { subscription } } = supabase.auth.onAuthStateChange(
        (event, session) => {
          if (event === "SIGNED_IN" && session) {
            subscription.unsubscribe();
            clearTimeout(fallbackTimer);
            const next = new URLSearchParams(window.location.search).get("next") ?? "/";
            window.location.replace(next.startsWith("/booking") ? next : "/");
          }
        }
      );

      const fallbackTimer = setTimeout(() => {
        subscription.unsubscribe();
        setStatus("Sign in failed — please try again");
        setTimeout(() => window.location.replace("/"), 2000);
      }, 8000);
    };

    checkSession();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "DM Sans, sans-serif",
        color: "var(--text-muted, #888)",
      }}
    >
      {status}
    </div>
  );
}
