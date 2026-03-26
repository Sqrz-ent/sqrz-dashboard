import { useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.theme";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

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

const sectionTitle: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 30,
  fontWeight: 800,
  color: ACCENT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.03em",
  margin: "0 0 18px",
  lineHeight: 1.1,
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  return Response.json({ profile }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_template") {
    const { error } = await supabase.from("profiles").update({
      template_id: formData.get("template_id") as string,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

export default function ThemePage() {
  const { profile } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
  };

  const templateFetcher = useFetcher();
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    (profile.template_id as string) || "midnight"
  );

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ ...sectionTitle, fontSize: 36, marginBottom: 6 }}>Theme</h1>
      <p style={{ fontSize: 14, color: "var(--text-muted)", fontFamily: FONT_BODY, margin: "0 0 28px" }}>
        Choose the look of your public profile.
      </p>

      <div style={card}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {([
            { key: "midnight", label: "Midnight", accent: "#F3B130", bg: "#0a0a0a" },
            { key: "neon",     label: "Neon",     accent: "#A855F7", bg: "#0d0d1a" },
            { key: "studio",   label: "Studio",   accent: "#38BDF8", bg: "#080f1a" },
          ] as const).map(({ key, label, accent, bg }) => {
            const active = selectedTemplate === key;
            return (
              <button
                key={key}
                onClick={() => {
                  setSelectedTemplate(key);
                  const fd = new FormData();
                  fd.append("intent", "update_template");
                  fd.append("template_id", key);
                  templateFetcher.submit(fd, { method: "post" });
                }}
                style={{
                  flex: "1 1 80px",
                  minWidth: 80,
                  padding: "14px 10px 12px",
                  background: bg,
                  border: active ? `2px solid ${accent}` : "2px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  transition: "border-color 0.15s",
                }}
              >
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: accent,
                  boxShadow: active ? `0 0 10px ${accent}80` : "none",
                  transition: "box-shadow 0.15s",
                }} />
                <span style={{
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: FONT_BODY,
                  color: active ? accent : "rgba(255,255,255,0.6)",
                  letterSpacing: "0.04em",
                }}>
                  {label}
                </span>
                {active && (
                  <span style={{ fontSize: 10, color: accent }}>✓</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
