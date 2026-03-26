import { useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app._index";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getProfileCompletion, type RichProfile } from "~/lib/completion";

const ACCENT = "#F5A623";
const FONT = "'DM Sans', ui-sans-serif, system-ui, sans-serif";

// ─── Types ────────────────────────────────────────────────────────────────────

type UpcomingBooking = {
  id: string;
  title: string | null;
  service: string | null;
  date_start: string | null;
  city: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/join");

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/join");

  const profileId = profile.id as string;

  const { data: analytics } = await supabase.rpc("get_profile_analytics", {
    p_profile_id: profile.id,
    p_days: 7,
  });

  const [activeBookingsRes, upcomingBookingsRes, skillsRes, servicesRes, videosRes, refsRes, planRes] =
    await Promise.all([
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", profileId)
        .in("status", ["requested", "pending", "confirmed"]),
      supabase
        .from("bookings")
        .select("id, title, service, date_start, city")
        .eq("owner_id", profileId)
        .eq("status", "confirmed")
        .gt("date_start", new Date().toISOString())
        .order("date_start", { ascending: true })
        .limit(3),
      supabase
        .from("profile_skills")
        .select("skill_id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      supabase
        .from("profile_services")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      supabase
        .from("profile_videos")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      supabase
        .from("profile_references")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
      profile.plan_id
        ? supabase.from("plans").select("name").eq("id", profile.plan_id as number).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  return Response.json(
    {
      profile,
      activeBookingsCount: activeBookingsRes.count ?? 0,
      upcomingBookings: upcomingBookingsRes.data ?? [],
      hasSkills: (skillsRes.count ?? 0) > 0,
      hasServices: (servicesRes.count ?? 0) > 0,
      hasVideos: (videosRes.count ?? 0) > 0,
      hasRefs: (refsRes.count ?? 0) > 0,
      planName: ((planRes as { data: Record<string, unknown> | null }).data?.name as string) ?? null,
      analytics: analytics ?? null,
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
  if (formData.get("intent") === "update_template") {
    const { error } = await supabase
      .from("profiles")
      .update({ template_id: formData.get("template_id") as string })
      .eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardIndex() {
  const { profile, activeBookingsCount, upcomingBookings, hasSkills, hasServices, hasVideos, hasRefs, planName, analytics } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown>;
  const slug = p.slug as string | null;
  const name = p.name as string | null;
  const firstName = name?.split(" ")[0] ?? slug ?? "there";
  const planId = p.plan_id as number | null | undefined;

  const analyticsData = analytics as { views_total?: number; views_prev_period?: number; unique_visitors?: number; form_opens?: number } | null;
  const views = analyticsData?.views_total ?? 0;
  const prevViews = analyticsData?.views_prev_period ?? 0;
  const uniqueVisitors = analyticsData?.unique_visitors ?? 0;
  const formOpens = analyticsData?.form_opens ?? 0;
  const trend = prevViews > 0 ? Math.round(((views - prevViews) / prevViews) * 100) : null;
  const trendUp = trend !== null && trend >= 0;
  const isPaid = !!planId && planId > 0;

  // Profile completion
  const richProfile: RichProfile = {
    ...p,
    hasSkills,
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

        {/* Completion checklist */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {completionItems.map((item) => (
            <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: item.done ? "rgba(245,166,35,0.15)" : "var(--surface-muted)",
                border: `1px solid ${item.done ? "rgba(245,166,35,0.4)" : "var(--border)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: item.done ? ACCENT : "transparent",
                flexShrink: 0,
              }}>✓</span>
              <span style={{
                fontSize: 13,
                color: item.done ? "var(--text)" : "var(--text-muted)",
                textDecoration: item.done ? "none" : "none",
              }}>
                {item.label}
              </span>
            </div>
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
      </div>

      {/* Theme picker */}
      <div style={{ ...card, marginBottom: 16 }}>
        <p style={{ ...metaLabel, margin: "0 0 14px" }}>Your theme</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {([
            { key: "midnight", label: "Midnight", accent: "#F3B130" },
            { key: "neon",     label: "Neon",     accent: "#A855F7" },
            { key: "studio",   label: "Studio",   accent: "#38BDF8" },
          ] as const).map(({ key, label, accent }) => {
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
                  padding: "16px 10px 14px",
                  background: active ? "var(--surface-muted)" : "var(--bg)",
                  border: active ? `2px solid ${accent}` : "2px solid var(--border)",
                  borderRadius: 14,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  transition: "border-color 0.15s, background 0.15s",
                  fontFamily: FONT,
                }}
              >
                <div style={{
                  width: 60,
                  height: 60,
                  borderRadius: "50%",
                  background: accent,
                  boxShadow: active ? `0 0 16px ${accent}60` : "none",
                  transition: "box-shadow 0.15s",
                }} />
                <span style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: active ? accent : "var(--text)",
                  letterSpacing: "0.04em",
                }}>
                  {label}
                </span>
                {active && <span style={{ fontSize: 10, color: accent }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ ...card, textAlign: "center" }}>
          <p style={metaLabel}>Active Bookings</p>
          <p style={{ color: "var(--text)", fontSize: 28, fontWeight: 700, margin: 0 }}>
            {String(activeBookingsCount)}
          </p>
        </div>

        <div style={{ ...card, textAlign: "center" }}>
          <p style={metaLabel}>Plan</p>
          <p
            style={{
              color: isPaid ? ACCENT : "var(--text-muted)",
              fontSize: 16,
              fontWeight: 700,
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            {planName ?? "Free"}
          </p>
        </div>
      </div>

      {/* Upcoming bookings */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: 0 }}>
            Upcoming
          </p>
          <Link
            to="/office"
            style={{ color: "var(--text-muted)", fontSize: 12, textDecoration: "none" }}
          >
            View all →
          </Link>
        </div>

        {(upcomingBookings as UpcomingBooking[]).length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            No upcoming confirmed bookings.{" "}
            <Link to="/office" style={{ color: ACCENT, textDecoration: "none" }}>
              Go to pipeline →
            </Link>
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(upcomingBookings as UpcomingBooking[]).map((b) => (
              <Link key={b.id} to={`/office/${b.id}`} style={{ textDecoration: "none" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 14px",
                    background: "var(--surface-muted)",
                    borderRadius: 10,
                    gap: 12,
                    transition: "opacity 0.15s",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p
                      style={{
                        color: "var(--text)",
                        fontSize: 14,
                        fontWeight: 600,
                        margin: "0 0 2px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {b.title ?? b.service ?? "Booking"}
                    </p>
                    {b.city && (
                      <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
                        📍 {b.city}
                      </p>
                    )}
                  </div>
                  <p
                    style={{
                      color: ACCENT,
                      fontSize: 12,
                      fontWeight: 600,
                      margin: 0,
                      flexShrink: 0,
                    }}
                  >
                    {formatDate(b.date_start)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {slug && (
          <a
            href={`https://${slug}.sqrz.com`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "10px 20px",
              background: ACCENT,
              color: "#111",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            View my profile →
          </a>
        )}
        <button
          onClick={copyLink}
          disabled={!slug}
          style={{
            padding: "10px 20px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            color: copied ? "#4ade80" : "var(--text)",
            cursor: slug ? "pointer" : "default",
            fontFamily: FONT,
          }}
        >
          {copied ? "✓ Copied!" : "Share profile"}
        </button>
        <Link
          to="/office"
          style={{
            padding: "10px 20px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            textDecoration: "none",
          }}
        >
          New booking request
        </Link>
      </div>
    </div>
  );
}
