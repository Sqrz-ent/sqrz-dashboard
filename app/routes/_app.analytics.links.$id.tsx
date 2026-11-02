import { redirect, useLoaderData, Link } from "react-router";
import type { Route } from "./+types/_app.analytics.links.$id";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import { buildLinkMetricsSections, formatDate, type MetricsSectionView } from "~/lib/campaigns";
import type { LinkMetrics } from "~/lib/grow";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

// Read-only link detail: the same "More info" metrics as the iOS Links tab
// (get_link_metrics — sources + impact funnel, since the link was created,
// zero values dropped). Scoped to the ACTIVE profile.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: link } = await supabase
    .from("private_booking_links")
    .select("id, title, link_slug, created_at")
    .eq("id", params.id)
    .eq("profile_id", profile.id as string)
    .maybeSingle();
  if (!link) throw new Response("Link not found", { status: 404, headers });

  const { data: metrics } = await supabase.rpc("get_link_metrics", { p_link_id: link.id });
  return Response.json(
    { link, slug: profile.slug as string, sections: buildLinkMetricsSections(metrics as LinkMetrics | null) },
    { headers }
  );
}

export default function LinkDetail() {
  const { link, slug, sections } = useLoaderData<typeof loader>() as unknown as {
    link: { id: string; title: string; link_slug: string; created_at: string | null };
    slug: string;
    sections: MetricsSectionView[];
  };
  const created = formatDate(link.created_at);
  return (
    <div style={{ maxWidth: 640, fontFamily: FONT_BODY, color: "var(--text)" }}>
      <Link to="/analytics?tab=links" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Links</Link>
      <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 800, color: ACCENT, textTransform: "uppercase", margin: "12px 0 4px", lineHeight: 1.05 }}>
        {link.title || link.link_slug}
      </h1>
      <p style={{ margin: "0 0 20px", fontSize: 12, color: "var(--text-muted)" }}>
        {slug}.sqrz.com/{link.link_slug} · Since the beginning{created ? ` · created ${created}` : ""}
      </p>
      {sections.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 16, fontSize: 14, color: "var(--text-muted)" }}>
          No results to show yet.
        </div>
      ) : (
        sections.map((s) => (
          <div key={s.title} style={{ marginBottom: 16 }}>
            <h2 style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: ACCENT }}>{s.title}</h2>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12 }}>
              {s.rows.map((r, i) => (
                <div key={r.label} style={{ padding: "12px 16px", borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{r.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 800 }}>{r.value}</span>
                  </div>
                  {r.explanation && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{r.explanation}</div>}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <p style={{ margin: "16px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Manage this link in the SQRZ app</p>
    </div>
  );
}
