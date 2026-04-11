import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

export async function loader() {
  return {};
}

export default function AuthCallback() {
  const [status, setStatus] = useState("Signing you in…");

  useEffect(() => {
    const supabase = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    );

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const next = params.get("next") ?? "/";
    const destination = next.startsWith("/booking") ? next : "/";

    if (code) {
      // Exchange happens CLIENT-SIDE — verifier is in localStorage here
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          console.error("[callback] exchange error:", error.message);
          setStatus("Sign in failed — please try again");
          setTimeout(() => window.location.replace("/"), 2000);
        } else {
          window.location.replace(destination);
        }
      });
      return;
    }

    // No code — check for existing session (returning user)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        window.location.replace(destination);
      } else {
        setStatus("Sign in failed — please try again");
        setTimeout(() => window.location.replace("/"), 2000);
      }
    });
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
