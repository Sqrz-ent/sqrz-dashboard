import { redirect, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/_app.media";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "22px 24px",
  marginBottom: 20,
  position: "relative",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: media } = await supabase
    .from("profile_media")
    .select("*")
    .eq("profile_id", profile.id as string)
    .order("sort_order", { ascending: true });

  return Response.json({ plan_id: (profile.plan_id as number | null) ?? null, media: media ?? [] }, { headers });
}

type MediaItem = {
  id: string;
  url: string;
  filename: string | null;
  media_type: string | null;
};

export default function MediaPage() {
  const { media, plan_id } = useLoaderData<typeof loader>() as { media: MediaItem[]; plan_id: number | null };
  const navigate = useNavigate();
  const locked = getPlanLevel(plan_id) < FEATURE_GATES.media;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 30,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 24px",
        lineHeight: 1.1,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}>
        Media Library
        {locked && (
          <button onClick={() => navigate("?upgrade=1")} title="Upgrade to unlock" style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 18, padding: 0, lineHeight: 1, color: "var(--text-muted)",
          }}>🔒</button>
        )}
      </h1>

      {/* Coming Soon card */}
      <div style={{ ...card, border: `1px solid ${ACCENT}`, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 24,
            fontWeight: 800,
            color: "var(--text)",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            margin: 0,
            lineHeight: 1.1,
          }}>
            Media Library
          </h2>
          <span style={{
            padding: "4px 10px",
            background: "rgba(245,166,35,0.12)",
            border: `1px solid rgba(245,166,35,0.35)`,
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            color: ACCENT,
            fontFamily: FONT_BODY,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}>
            Coming Soon
          </span>
        </div>
        <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0, lineHeight: 1.65, fontFamily: FONT_BODY }}>
          Strong campaigns need strong material. Upload approved images, videos, or graphics that we can use in advertising — aligned with your profile, positioning, and active call-to-actions. Only high-quality, rights-cleared content will be used.
        </p>
      </div>

      {/* Show existing media if any */}
      {media.length > 0 && (
        <div style={{ ...card, ...(locked ? { opacity: 0.45, pointerEvents: "none" } : {}) }}>
          <h2 style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 22,
            fontWeight: 800,
            color: ACCENT,
            textTransform: "uppercase",
            letterSpacing: "0.03em",
            margin: "0 0 16px",
            lineHeight: 1.1,
          }}>
            Uploaded Files
          </h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
            gap: 12,
          }}>
            {media.map(item => (
              <div key={item.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <img
                  src={item.url}
                  alt={item.filename ?? "media"}
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: 10,
                    objectFit: "cover",
                    border: "1px solid var(--border)",
                    display: "block",
                  }}
                />
                {item.filename && (
                  <span style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    textAlign: "center",
                    wordBreak: "break-all",
                    maxWidth: 80,
                    fontFamily: FONT_BODY,
                    lineHeight: 1.3,
                  }}>
                    {item.filename}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
