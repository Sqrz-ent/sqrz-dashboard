import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/pro-required";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getActiveProfile } from "~/lib/profile.server";
import { getProStatus } from "~/lib/pro.server";

// Where signed-in users WITHOUT SQRZ Pro land (every dashboard route redirects
// here). Deliberately minimal: their public link, a note that the web dashboard
// is part of SQRZ Pro (available in the app), a contact option and log out.
// NO web checkout / purchase link — Pro is bought in the SQRZ app.
// Public (outside the _app layout) so it can never redirect-loop with the gate.

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? "info@sqrz.com";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  // "Check again" re-asks RevenueCat (rate-limited inside getProStatus) — e.g.
  // right after upgrading in the app.
  const recheck = new URL(request.url).searchParams.get("recheck") === "1";
  const status = await getProStatus(supabase, user.id, { force: recheck });
  if (status.state === "pro") return redirect("/", { headers });

  const profile = await getActiveProfile(request, supabase, user.id);
  const slug = (profile?.slug as string | undefined) ?? null;

  return Response.json(
    { slug, verifyFailed: status.state === "error", supportEmail: SUPPORT_EMAIL },
    { headers }
  );
}

// Log out (the only action on this page).
export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  await supabase.auth.signOut();
  return redirect("/login", { headers });
}

export default function ProRequired() {
  const { slug, verifyFailed, supportEmail } = useLoaderData<typeof loader>() as unknown as {
    slug: string | null;
    verifyFailed: boolean;
    supportEmail: string;
  };
  const publicUrl = slug ? `https://${slug}.sqrz.com` : null;

  const card: React.CSSProperties = {
    background: "#1a1a1a",
    border: "1px solid rgba(245,166,35,0.2)",
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
  };
  const linkStyle: React.CSSProperties = { color: "#F5A623", textDecoration: "none", fontWeight: 600 };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111111",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <img src="/sqrz-logo.png" alt="SQRZ" style={{ height: 40, width: "auto", display: "block", margin: "0 auto" }} />
        </div>

        {publicUrl && (
          <div style={card}>
            <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
              Your public page
            </p>
            <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={{ ...linkStyle, fontSize: 18, wordBreak: "break-all" }}>
              {publicUrl.replace("https://", "")}
            </a>
          </div>
        )}

        <div style={card}>
          <p role={verifyFailed ? "alert" : undefined} style={{ margin: 0, color: "#ffffff", fontSize: 15, lineHeight: 1.55 }}>
            {verifyFailed
              ? "We couldn't verify your SQRZ Pro status right now. Please try again in a moment."
              : "The SQRZ web dashboard is part of SQRZ Pro — available in the SQRZ app."}
          </p>
          <p style={{ margin: "14px 0 0", fontSize: 13 }}>
            <a href="?recheck=1" style={linkStyle}>Check again</a>
          </p>
        </div>

        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
          <a href={`mailto:${supportEmail}`} style={{ ...linkStyle, fontSize: 14 }}>
            Contact us
          </a>
          <form method="post">
            <button
              type="submit"
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.45)", fontSize: 13, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
            >
              Log out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
