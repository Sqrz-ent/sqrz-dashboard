import { useEffect, useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app._index";
import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getProfileCompletion, type RichProfile } from "~/lib/completion";
import { useTheme, writeThemeCookie } from "~/lib/theme";

const ACCENT = "#F5A623";
const FONT = "'DM Sans', ui-sans-serif, system-ui, sans-serif";

// ─── Types ────────────────────────────────────────────────────────────────────

async function getDashboardAnalytics(profileId: string) {
  const admin = createSupabaseAdminClient();
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [
    totalViewsRes,
    views7dRes,
    viewsPrev7dRes,
    uniqueVisitorsRes,
    bookingModalOpensRes,
  ] = await Promise.all([
    admin
      .from("profile_views")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId),
    admin
      .from("profile_views")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .gte("created_at", sevenDaysAgo),
    admin
      .from("profile_views")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .gte("created_at", fourteenDaysAgo)
      .lt("created_at", sevenDaysAgo),
    admin
      .from("profile_views")
      .select("visitor_fingerprint")
      .eq("profile_id", profileId)
      .gte("created_at", sevenDaysAgo)
      .limit(10000),
    admin
      .from("jitsu_events")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .eq("event_type", "booking_modal_open")
      .gte("created_at", sevenDaysAgo),
  ]);

  const uniqueVisitors = new Set(
    (uniqueVisitorsRes.data ?? [])
      .map((row) => row.visitor_fingerprint as string | null)
      .filter(Boolean)
  ).size;

  return {
    total_views: totalViewsRes.count ?? 0,
    views_7d: views7dRes.count ?? 0,
    views_prev_7d: viewsPrev7dRes.count ?? 0,
    unique_visitors_7d: uniqueVisitors,
    booking_modal_opens_7d: bookingModalOpensRes.count ?? 0,
  };
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/join");

  const homeDataPromise = supabase.rpc("get_dashboard_home");
  const profileIdPromise = supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .single();
  const analyticsPromise = profileIdPromise.then(async ({ data: profileRow, error }) => {
    if (error || !profileRow?.id) return null;
    return getDashboardAnalytics(profileRow.id as string);
  });

  const [{ data: homeData, error: homeError }, analytics] = await Promise.all([
    homeDataPromise,
    analyticsPromise,
  ]);
  if (homeError) throw homeError;
  if (!homeData?.profile) return redirect("/join");

  const profile = homeData.profile as Record<string, unknown>;

  return Response.json(
    {
      profile,
      analytics: analytics ?? null,
      hasServices: !!homeData.hasServices,
      hasVideos: !!homeData.hasVideos,
      hasRefs: !!homeData.hasRefs,
      planName: homeData.planName ?? null,
      refCode: homeData.refCode ?? null,
    },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/join", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/join", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_template") {
    const { error } = await supabase
      .from("profiles")
      .update({ template_id: formData.get("template_id") as string })
      .eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false }, { headers });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardIndex() {
  const { profile, analytics, hasServices, hasVideos, hasRefs, planName, refCode } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown>;
  const slug = p.slug as string | null;
  const firstName = (p.first_name as string | null)
    ?? (p.name as string | null)?.split(" ")[0]
    ?? slug
    ?? "there";

  const a = (analytics ?? {}) as Record<string, unknown>;
  const views          = ((a.views_7d                  ?? 0) as number);
  const uniqueVisitors = ((a.unique_visitors_7d         ?? 0) as number);
  const formOpens      = ((a.booking_modal_opens_7d     ?? 0) as number);
  const trend = ((a.views_prev_7d ?? 0) as number) > 0
    ? Math.round(((views - (a.views_prev_7d as number)) / (a.views_prev_7d as number)) * 100)
    : null;
  const trendUp = trend !== null && trend >= 0;

  // Profile completion
  const richProfile: RichProfile = {
    ...p,
    hasServices,
    hasVideos,
    hasRefs,
  };
  const completion = getProfileCompletion(richProfile);
  const { score: doneCount, total: totalSections, percentage: pct, items: completionItems } = completion;

  // Theme picker
  const templateFetcher = useFetcher();
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    (p.template_id as string) || "midnight"
  );

  // Dark/light mode — theme lives in the root Layout (server-rendered from a
  // cookie so <html> has the right class at first paint). Toggling updates that
  // shared state (instant, no reload) and persists the choice to the cookie.
  const { theme, setTheme } = useTheme();
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    writeThemeCookie(next);
  }

  // Share button
  const [copied, setCopied] = useState(false);

  function copyLink() {
    if (!slug) return;
    navigator.clipboard.writeText(`https://${slug}.sqrz.com`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const card: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: "20px 22px",
  };

  const metaLabel: React.CSSProperties = {
    color: "var(--text-muted)",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    margin: "0 0 6px",
  };

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "36px 24px", fontFamily: FONT }}>

      {/* Welcome header */}
      <h1 style={{ color: "var(--text)", fontSize: 26, fontWeight: 700, margin: "0 0 4px" }}>
        Welcome back, {firstName}
      </h1>
      {slug && (
        <a
          href={`https://${slug}.sqrz.com`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: ACCENT, fontSize: 13, textDecoration: "none" }}
        >
          {slug}.sqrz.com →
        </a>
      )}

      {/* Profile completion */}
      <div style={{ ...card, marginTop: 28, marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
            gap: 12,
          }}
        >
          <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: 0 }}>
            Profile completion
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, flexShrink: 0 }}>
            {doneCount} of {totalSections} complete
          </p>
        </div>

        {/* Progress bar */}
        <div
          style={{
            background: "var(--border)",
            borderRadius: 6,
            height: 7,
            overflow: "hidden",
            marginBottom: 14,
          }}
        >
          <div
            style={{
              background: ACCENT,
              borderRadius: 6,
              height: "100%",
              width: `${pct}%`,
              transition: "width 0.4s ease",
            }}
          />
        </div>

        {/* Completion pills */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {completionItems.map((item) => (
            item.done ? (
              <span
                key={item.key}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 9px",
                  borderRadius: 20,
                  background: ACCENT,
                  color: "#111111",
                  border: "1px solid transparent",
                  letterSpacing: "0.01em",
                }}
              >
                {item.label}
              </span>
            ) : (
              <span
                key={item.key}
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: "3px 9px",
                  borderRadius: 20,
                  background: "transparent",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                  opacity: 0.7,
                  letterSpacing: "0.01em",
                }}
              >
                {item.label}
              </span>
            )
          ))}
        </div>
      </div>

      {/* Analytics widget */}
      <div style={{ ...card, marginBottom: 16 }}>
        <p style={{ ...metaLabel, margin: "0 0 14px" }}>Profile Views — Last 7 days</p>

        {views === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            No views yet — share your profile!
          </p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
              <span style={{ color: "var(--text)", fontSize: 36, fontWeight: 700, lineHeight: 1 }}>
                {views.toLocaleString()}
              </span>
              {trend !== null && (
                <span style={{ fontSize: 13, fontWeight: 700, color: trendUp ? "#22c55e" : ACCENT }}>
                  {trendUp ? "↑" : "↓"} {Math.abs(trend)}%
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 20 }}>
              <div>
                <span style={{ color: "var(--text)", fontSize: 16, fontWeight: 600 }}>
                  {uniqueVisitors.toLocaleString()}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 5 }}>
                  unique visitors
                </span>
              </div>
              <div>
                <span style={{ color: "var(--text)", fontSize: 16, fontWeight: 600 }}>
                  {formOpens.toLocaleString()}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 5 }}>
                  form opens
                </span>
              </div>
            </div>
          </>
        )}

        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <Link to="/analytics" style={{ color: ACCENT, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
            View full analytics →
          </Link>
        </div>
      </div>

      {/* Theme picker */}
      <div style={{ ...card, marginBottom: 16 }}>
        <p style={{ ...metaLabel, margin: "0 0 14px" }}>Your theme</p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 10,
          }}
        >
          {([
            { key: "midnight", label: "Midnight", accent: "#F3B130", live: true },
            { key: "neon",     label: "Neon",     accent: "#A855F7", live: true },
            { key: "studio",   label: "Studio",   accent: "#38BDF8", live: true },
            { key: "noir",     label: "Noir",     accent: "#22C55E", live: false },
          ] as const).map(({ key, label, accent, live }) => {
            const active = selectedTemplate === key;
            return (
              <button
                key={key}
                onClick={() => {
                  if (!live) return;
                  setSelectedTemplate(key);
                  const fd = new FormData();
                  fd.append("intent", "update_template");
                  fd.append("template_id", key);
                  templateFetcher.submit(fd, { method: "post" });
                }}
                style={{
                  minWidth: 0,
                  padding: 0,
                  background: active ? "var(--surface-muted)" : "var(--bg)",
                  border: active ? `2px solid ${accent}` : live ? "2px solid var(--border)" : "2px dashed var(--border)",
                  borderRadius: 14,
                  cursor: live ? "pointer" : "default",
                  display: "flex",
                  flexDirection: "column",
                  transition: "border-color 0.15s, background 0.15s",
                  fontFamily: FONT,
                  aspectRatio: "1 / 1",
                  opacity: live ? 1 : 0.72,
                  overflow: "hidden",
                }}
                disabled={!live}
              >
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: 1,
                    padding: "16px 14px 12px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 20,
                      fontWeight: 800,
                      color: active ? accent : "var(--text)",
                      letterSpacing: "0.02em",
                      textAlign: "center",
                    }}
                  >
                    {label}
                  </span>
                </div>
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: 1,
                    background: accent,
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* Appearance — dark/light mode */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <p style={{ ...metaLabel, margin: "0 0 4px" }}>Appearance</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
              Switch between dark and light themes
            </p>
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 20,
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 16px",
              cursor: "pointer",
              fontFamily: FONT,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{theme === "dark" ? "☀️" : "🌙"}</span>
            {theme === "dark" ? "Switch to light" : "Switch to dark"}
          </button>
        </div>
      </div>
    </div>
  );
}
