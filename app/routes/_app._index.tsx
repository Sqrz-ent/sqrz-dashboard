import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app._index";
import { createSupabaseAdminClient, createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getProfileCompletion, type RichProfile } from "~/lib/completion";
import UpgradeBanner from "~/components/UpgradeBanner";

const ACCENT = "#F5A623";
const FONT = "'DM Sans', ui-sans-serif, system-ui, sans-serif";

// Inquiry chat is an iOS-first feature — it works on the PWA but not well enough
// to expose on web yet. Flag the web dashboard config UI off (kept, not deleted).
// The DB column, action handler, and the iOS app are untouched, so existing users
// keep their setting and the feature keeps working for them.
const SHOW_INQUIRY_CHAT_SETTING = false;

// ─── Types ────────────────────────────────────────────────────────────────────

type UpcomingBooking = {
  id: string;
  title: string | null;
  service: string | null;
  date_start: string | null;
  city: string | null;
};

type AvailabilityBlock = {
  id: number;
  start_date: string;
  end_date: string;
  label: string | null;
  show_label: boolean | null;
};

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
    chatOpensRes,
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
    admin
      .from("jitsu_events")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profileId)
      .eq("event_type", "chat_opened")
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
    chat_opens_7d: chatOpensRes.count ?? 0,
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
      activeBookingsCount: homeData.activeBookingsCount ?? 0,
      upcomingBookings: homeData.upcomingBookings ?? [],
      hasServices: !!homeData.hasServices,
      hasVideos: !!homeData.hasVideos,
      hasRefs: !!homeData.hasRefs,
      hasGallery: !!homeData.hasGallery,
      planName: homeData.planName ?? null,
      availabilityBlocks: homeData.availabilityBlocks ?? [],
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

  if (intent === "update_availability_status") {
    const { error } = await supabase
      .from("profiles")
      .update({ availability_status: formData.get("status") as string })
      .eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "add_availability_block") {
    const { error } = await supabase
      .from("availability_blocks")
      .insert({
        profile_id: profile.id as string,
        start_date: formData.get("start_date") as string,
        end_date: formData.get("end_date") as string,
        label: (formData.get("label") as string) || "Unavailable",
      });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_block_show_label") {
    const { error } = await supabase
      .from("availability_blocks")
      .update({ show_label: formData.get("show_label") === "true" })
      .eq("id", Number(formData.get("block_id")))
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_availability_block") {
    const { error } = await supabase
      .from("availability_blocks")
      .delete()
      .eq("id", Number(formData.get("block_id")))
      .eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_inquiry_chat_enabled") {
    const enabled = formData.get("enabled") === "true";
    const { error } = await supabase
      .from("profiles")
      .update({ inquiry_chat_enabled: enabled })
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
  const { profile, analytics, activeBookingsCount, upcomingBookings, hasServices, hasVideos, hasRefs, hasGallery, planName, availabilityBlocks, refCode } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown>;
  const slug = p.slug as string | null;
  const firstName = (p.first_name as string | null)
    ?? (p.name as string | null)?.split(" ")[0]
    ?? slug
    ?? "there";
  const planId = p.plan_id as number | null | undefined;

  const a = (analytics ?? {}) as Record<string, unknown>;
  const views          = ((a.views_7d                  ?? 0) as number);
  const uniqueVisitors = ((a.unique_visitors_7d         ?? 0) as number);
  const formOpens      = ((a.booking_modal_opens_7d     ?? 0) as number);
  const trend = ((a.views_prev_7d ?? 0) as number) > 0
    ? Math.round(((views - (a.views_prev_7d as number)) / (a.views_prev_7d as number)) * 100)
    : null;
  const trendUp = trend !== null && trend >= 0;
  const isPaid = !!planId && planId > 0;

  // Profile completion
  const richProfile: RichProfile = {
    ...p,
    hasServices,
    hasVideos,
    hasRefs,
    hasGallery: hasGallery as boolean,
  };
  const completion = getProfileCompletion(richProfile);
  const { score: doneCount, total: totalSections, percentage: pct, items: completionItems } = completion;

  // Theme picker
  const templateFetcher = useFetcher();
  const inquiryChatFetcher = useFetcher();
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    (p.template_id as string) || "midnight"
  );
  const [inquiryChatEnabled, setInquiryChatEnabled] = useState<boolean>((p.inquiry_chat_enabled as boolean | null) !== false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Availability
  const blockFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const blocks = availabilityBlocks as AvailabilityBlock[];
  const [showBlockForm, setShowBlockForm] = useState(false);
  const blockLabelRef = useRef<HTMLInputElement>(null);
  const blockStartRef = useRef<HTMLInputElement>(null);
  const blockEndRef = useRef<HTMLInputElement>(null);

  // Dark/light mode
  const [theme, setThemeState] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setThemeState((localStorage.getItem("sqrz_theme") as "dark" | "light" | null) ?? "dark");
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setThemeState(next);
    localStorage.setItem("sqrz_theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }

  // Share button
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setInquiryChatEnabled((p.inquiry_chat_enabled as boolean | null) !== false);
  }, [p.inquiry_chat_enabled]);

  useEffect(() => {
    if (inquiryChatFetcher.state !== "idle") return;
    const data = inquiryChatFetcher.data as { ok?: boolean; error?: string } | undefined;
    if (!data) return;
    if (!data.ok) {
      setInquiryChatEnabled((p.inquiry_chat_enabled as boolean | null) !== false);
      setToggleError(data.error ?? "Failed to update");
      const t = setTimeout(() => setToggleError(null), 2500);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inquiryChatFetcher.state, inquiryChatFetcher.data]);


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

      {SHOW_INQUIRY_CHAT_SETTING && (
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 14 }}>
          <div>
            <p style={{ ...metaLabel, margin: "0 0 8px" }}>Communications</p>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              Creator messaging controls
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: "8px 0 0" }}>
              Control whether new inquiries can reach you.
            </p>
          </div>
          {!isPaid && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 999, background: "rgba(245,166,35,0.14)", color: ACCENT }}>
              Creator
            </span>
          )}
        </div>

        {!isPaid && <UpgradeBanner planName="Creator plan" upgradeParam="creator" />}

        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <p style={{ ...metaLabel, margin: "0 0 8px" }}>Profile Inquiry Chat</p>
                <p style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>
                  Allow new inquiries
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: 0, maxWidth: 620 }}>
                  Show the premium chat bubble on your profile and private link pages. Turn this off if you do not want to receive new inquiries right now.
                </p>
              </div>
              <div style={{ flexShrink: 0, textAlign: "right" }}>
                {isPaid ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setInquiryChatEnabled((value) => !value);
                        const fd = new FormData();
                        fd.append("intent", "toggle_inquiry_chat_enabled");
                        fd.append("enabled", String(!inquiryChatEnabled));
                        inquiryChatFetcher.submit(fd, { method: "post" });
                      }}
                      disabled={inquiryChatFetcher.state !== "idle"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        cursor: inquiryChatFetcher.state !== "idle" ? "not-allowed" : "pointer",
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 700, color: inquiryChatEnabled ? ACCENT : "var(--text-muted)" }}>
                        {inquiryChatEnabled ? "On" : "Off"}
                      </span>
                      <span style={{ width: 36, height: 20, borderRadius: 999, background: inquiryChatEnabled ? ACCENT : "var(--surface-muted)", position: "relative", display: "inline-block" }}>
                        <span style={{ width: 14, height: 14, borderRadius: "50%", background: inquiryChatEnabled ? "#111" : "var(--text-muted)", position: "absolute", top: 3, left: inquiryChatEnabled ? 19 : 3 }} />
                      </span>
                    </button>
                    <p style={{ fontSize: 11, color: ACCENT, margin: "8px 0 0", fontWeight: 700 }}>
                      Included in your plan
                    </p>
                  </>
                ) : (
                  <>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface)", opacity: 0.75 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>Off</span>
                      <span style={{ width: 36, height: 20, borderRadius: 999, background: "var(--surface-muted)", position: "relative", display: "inline-block" }}>
                        <span style={{ width: 14, height: 14, borderRadius: "50%", background: "var(--text-muted)", position: "absolute", top: 3, left: 3 }} />
                      </span>
                    </div>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0", fontWeight: 700 }}>
                      Upgrade to unlock
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

        </div>

        {toggleError && (
          <p style={{ color: "#f87171", fontSize: 12, margin: "12px 0 0", fontWeight: 700 }}>
            {toggleError}
          </p>
        )}
      </div>
      )}

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

      {/* Availability widget */}
      <div style={{ ...card, marginBottom: 16 }}>
        <p style={{ ...metaLabel, margin: "0 0 14px" }}>Availability</p>

        {/* Blocked periods list */}
        {blocks.length === 0 && !showBlockForm ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>
            No blocks added yet
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {blocks.map((block) => (
              <div
                key={block.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "10px 12px",
                  background: "var(--surface-muted)",
                  borderRadius: 8,
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 13, color: "var(--text)" }}>
                    <span style={{ fontWeight: 600 }}>{block.label || "Unavailable"}</span>
                    <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                      {block.start_date} → {block.end_date}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      const fd = new FormData();
                      fd.append("intent", "delete_availability_block");
                      fd.append("block_id", String(block.id));
                      deleteFetcher.submit(fd, { method: "post" });
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: "2px 4px",
                      lineHeight: 1,
                      flexShrink: 0,
                      fontFamily: FONT,
                    }}
                    aria-label="Delete block"
                  >
                    ✕
                  </button>
                </div>
                {/* Show label toggle */}
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    defaultChecked={!!block.show_label}
                    onChange={(e) => {
                      const fd = new FormData();
                      fd.append("intent", "update_block_show_label");
                      fd.append("block_id", String(block.id));
                      fd.append("show_label", String(e.target.checked));
                      blockFetcher.submit(fd, { method: "post" });
                    }}
                    style={{ accentColor: ACCENT, cursor: "pointer" }}
                  />
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Show label on public calendar</span>
                </label>
              </div>
            ))}
          </div>
        )}

        {/* Inline add form */}
        {showBlockForm ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px 14px",
              background: "var(--surface-muted)",
              borderRadius: 10,
            }}
          >
            <input
              ref={blockLabelRef}
              type="text"
              placeholder="e.g. On contract, Touring, Holiday"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 13,
                color: "var(--text)",
                fontFamily: FONT,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={blockStartRef}
                type="date"
                style={{
                  flex: 1,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "var(--text)",
                  fontFamily: FONT,
                  outline: "none",
                }}
              />
              <input
                ref={blockEndRef}
                type="date"
                onChange={(e) => {
                  const start = blockStartRef.current?.value;
                  if (start && e.target.value && e.target.value < start) {
                    e.target.value = start;
                  }
                }}
                style={{
                  flex: 1,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "var(--text)",
                  fontFamily: FONT,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  const start = blockStartRef.current?.value;
                  const end = blockEndRef.current?.value;
                  if (!start || !end) return;
                  if (end < start) return;
                  const fd = new FormData();
                  fd.append("intent", "add_availability_block");
                  fd.append("label", blockLabelRef.current?.value || "Unavailable");
                  fd.append("start_date", start);
                  fd.append("end_date", end);
                  blockFetcher.submit(fd, { method: "post" });
                  setShowBlockForm(false);
                }}
                style={{
                  flex: 1,
                  padding: "8px",
                  background: ACCENT,
                  color: "#111111",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                Add
              </button>
              <button
                onClick={() => setShowBlockForm(false)}
                style={{
                  padding: "8px 14px",
                  background: "transparent",
                  color: "var(--text-muted)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowBlockForm(true)}
            style={{
              background: "none",
              border: "none",
              color: ACCENT,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              fontFamily: FONT,
            }}
          >
            + Add unavailable period
          </button>
        )}
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
