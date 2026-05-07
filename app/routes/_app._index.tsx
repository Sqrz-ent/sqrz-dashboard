import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app._index";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getProfileCompletion, type RichProfile } from "~/lib/completion";
import { getPushPublicKey, isPushConfigured } from "~/lib/push.server";

const ACCENT = "#F5A623";
const FONT = "'DM Sans', ui-sans-serif, system-ui, sans-serif";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

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

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/join");

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/join");

  const profileId = profile.id as string;

  const adminClient = createSupabaseAdminClient();

  const { data: analyticsRaw } = await adminClient
    .from("profile_analytics")
    .select("*")
    .eq("profile_id", profile.id as string)
    .maybeSingle();

  const [activeBookingsRes, upcomingBookingsRes, skillsRes, servicesRes, videosRes, refsRes, planRes, blocksRes, refCodeRes, photosRes] =
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
      supabase
        .from("availability_blocks")
        .select("id, start_date, end_date, label, show_label")
        .eq("profile_id", profileId)
        .order("start_date", { ascending: true }),
      supabase
        .from("referral_codes")
        .select("code, use_count, commission_pct, discount_pct")
        .eq("owner_id", profileId)
        .maybeSingle(),
      supabase
        .from("profile_photos")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", profileId),
    ]);

  return Response.json(
    {
      profile,
      analytics: analyticsRaw ?? null,
      activeBookingsCount: activeBookingsRes.count ?? 0,
      upcomingBookings: upcomingBookingsRes.data ?? [],
      hasSkills: (skillsRes.count ?? 0) > 0,
      hasServices: (servicesRes.count ?? 0) > 0,
      hasVideos: (videosRes.count ?? 0) > 0,
      hasRefs: (refsRes.count ?? 0) > 0,
      hasGallery: (photosRes.count ?? 0) > 0,
      planName: ((planRes as { data: Record<string, unknown> | null }).data?.name as string) ?? null,
      availabilityBlocks: blocksRes.data ?? [],
      refCode: refCodeRes.data ?? null,
      webPushPublicKey: isPushConfigured() ? getPushPublicKey() : "",
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

  if (intent === "toggle_gig_history") {
    const { error } = await supabase.from("profiles").update({
      show_gig_history: !(profile.show_gig_history as boolean),
    }).eq("id", profile.id as string);
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
  const { profile, analytics, activeBookingsCount, upcomingBookings, hasSkills, hasServices, hasVideos, hasRefs, hasGallery, planName, availabilityBlocks, refCode, webPushPublicKey } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown>;
  const slug = p.slug as string | null;
  const firstName = (p.first_name as string | null)
    ?? (p.name as string | null)?.split(" ")[0]
    ?? slug
    ?? "there";
  const planId = p.plan_id as number | null | undefined;

  const a = (analytics ?? {}) as Record<string, number | null>;
  const views          = (a.views_7d                  ?? 0) as number;
  const uniqueVisitors = (a.unique_visitors_7d         ?? 0) as number;
  const formOpens      = (a.booking_modal_opens_7d     ?? 0) as number;
  const trend = (a.views_prev_7d ?? 0) > 0
    ? Math.round(((views - (a.views_prev_7d as number)) / (a.views_prev_7d as number)) * 100)
    : null;
  const trendUp = trend !== null && trend >= 0;
  const isPaid = !!planId && planId > 0;

  // Profile completion
  const richProfile: RichProfile = {
    ...p,
    hasSkills,
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
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<string>("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFeedback, setPushFeedback] = useState<string | null>(null);

  // Availability
  const gigHistoryFetcher = useFetcher();
  const blockFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const blocks = availabilityBlocks as AvailabilityBlock[];
  const [showBlockForm, setShowBlockForm] = useState(false);
  const blockLabelRef = useRef<HTMLInputElement>(null);
  const blockStartRef = useRef<HTMLInputElement>(null);
  const blockEndRef = useRef<HTMLInputElement>(null);

  // Share button
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setInquiryChatEnabled((p.inquiry_chat_enabled as boolean | null) !== false);
  }, [p.inquiry_chat_enabled]);

  useEffect(() => {
    let cancelled = false;

    async function loadPushState() {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window) || !webPushPublicKey) {
        if (!cancelled) setPushSupported(false);
        return;
      }

      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) {
          setPushSupported(true);
          setPushPermission(Notification.permission);
          setPushSubscribed(!!subscription);
        }
      } catch {
        if (!cancelled) setPushSupported(false);
      }
    }

    void loadPushState();
    return () => {
      cancelled = true;
    };
  }, [webPushPublicKey]);

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

  async function refreshPushState() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window) || !webPushPublicKey) {
      setPushSupported(false);
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setPushSupported(true);
    setPushPermission(Notification.permission);
    setPushSubscribed(!!subscription);
  }

  async function enablePushNotifications() {
    if (!webPushPublicKey || pushBusy) return;

    setPushBusy(true);
    setPushFeedback(null);
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== "granted") {
        throw new Error("Notification permission was not granted");
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(webPushPublicKey),
        });
      }

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: subscription.toJSON().keys,
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          appScope: registration.scope,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to save push subscription");
      }

      await refreshPushState();
      setPushFeedback("Instant alerts enabled.");
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Failed to enable notifications");
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePushNotifications() {
    if (pushBusy) return;

    setPushBusy(true);
    setPushFeedback(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      await refreshPushState();
      setPushFeedback("Instant alerts disabled.");
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Failed to disable notifications");
    } finally {
      setPushBusy(false);
    }
  }

  async function sendTestPushNotification() {
    if (pushBusy) return;

    setPushBusy(true);
    setPushFeedback(null);
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to send test notification");
      }

      if (payload?.sent > 0) {
        setPushFeedback("Test notification sent.");
      } else {
        setPushFeedback("No active push subscription found yet.");
      }
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Failed to send test notification");
    } finally {
      setPushBusy(false);
    }
  }

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
      </div>

      {/* Quick stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <div style={{ ...card, textAlign: "center", padding: "12px 14px" }}>
          <p style={metaLabel}>Total Views</p>
          <p style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
            {((a.total_views ?? 0) as number).toLocaleString()}
          </p>
        </div>

        <div style={{ ...card, textAlign: "center", padding: "12px 14px" }}>
          <p style={metaLabel}>Booking Inquiries</p>
          <p style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
            {((a.booking_modal_opens_7d ?? 0) as number).toLocaleString()}
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "4px 0 0" }}>Last 7 days</p>
        </div>

        <div style={{ ...card, textAlign: "center", padding: "12px 14px" }}>
          <p style={metaLabel}>Chat Opens</p>
          <p style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
            {((a.chat_opens_7d ?? 0) as number).toLocaleString()}
          </p>
        </div>

        <div style={{ ...card, textAlign: "center", padding: "12px 14px" }}>
          <p style={metaLabel}>Organic Visits</p>
          <p style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
            {((a.organic_views ?? 0) as number).toLocaleString()}
          </p>
        </div>

        <div style={{ ...card, textAlign: "center", padding: "12px 14px" }}>
          <p style={metaLabel}>Active Bookings</p>
          <p style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>
            {String(activeBookingsCount)}
          </p>
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 14 }}>
          <div>
            <p style={{ ...metaLabel, margin: "0 0 8px" }}>Communications</p>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              Creator messaging controls
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: "8px 0 0" }}>
              Control whether new inquiries can reach you and whether your installed SQRZ app can send high-priority alerts.
            </p>
          </div>
          {!isPaid && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 999, background: "rgba(245,166,35,0.14)", color: ACCENT }}>
              Creator
            </span>
          )}
        </div>

        {!isPaid && (
          <Link
            to="/account"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              textDecoration: "none",
              border: "1px solid rgba(245,166,35,0.4)",
              borderRadius: 16,
              padding: "16px 18px",
              background: "var(--bg)",
              marginBottom: 14,
            }}
          >
            <span style={{ fontSize: 24, lineHeight: 1 }}>🔒</span>
            <div>
              <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 700, margin: "0 0 4px" }}>
                This feature requires the Creator plan
              </p>
              <p style={{ color: ACCENT, fontSize: 14, fontWeight: 700, margin: 0 }}>
                Upgrade now →
              </p>
            </div>
          </Link>
        )}

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

          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <p style={{ ...metaLabel, margin: "0 0 8px" }}>Instant Alerts</p>
                <p style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>
                  Push notifications
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: 0, maxWidth: 620 }}>
                  Get high-priority inquiry alerts on your installed SQRZ app. Best experience on mobile comes from adding SQRZ to your Home Screen first.
                </p>
                {pushFeedback && (
                  <p style={{ color: pushFeedback.includes("Failed") || pushFeedback.includes("not") ? "#f87171" : ACCENT, fontSize: 12, margin: "10px 0 0", fontWeight: 700 }}>
                    {pushFeedback}
                  </p>
                )}
              </div>
              <div style={{ flexShrink: 0, textAlign: "right", display: "grid", gap: 8 }}>
                {!isPaid ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Upgrade to unlock</p>
                ) : !webPushPublicKey ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Push not configured</p>
                ) : !pushSupported ? (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>This browser does not support push here</p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void (pushSubscribed ? disablePushNotifications() : enablePushNotifications())}
                      disabled={pushBusy}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: pushSubscribed ? "1px solid var(--border)" : "none",
                        background: pushSubscribed ? "var(--surface)" : ACCENT,
                        color: pushSubscribed ? "var(--text)" : "#111",
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: pushBusy ? "not-allowed" : "pointer",
                        opacity: pushBusy ? 0.65 : 1,
                      }}
                    >
                      {pushSubscribed ? "Disable alerts" : "Enable alerts"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendTestPushNotification()}
                      disabled={pushBusy || !pushSubscribed}
                      style={{
                        padding: "9px 14px",
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        color: "var(--text)",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: pushBusy || !pushSubscribed ? "not-allowed" : "pointer",
                        opacity: pushBusy || !pushSubscribed ? 0.5 : 1,
                      }}
                    >
                      Send test
                    </button>
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

      {/* Availability widget */}
      <div style={{ ...card, marginBottom: 16 }}>
        <p style={{ ...metaLabel, margin: "0 0 14px" }}>Availability</p>

        {/* Gig history toggle */}
        <label style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer", marginBottom: 16 }}>
          <input
            type="checkbox"
            defaultChecked={!!(p.show_gig_history)}
            onChange={() => {
              const fd = new FormData();
              fd.append("intent", "toggle_gig_history");
              gigHistoryFetcher.submit(fd, { method: "post" });
            }}
            style={{ accentColor: ACCENT, width: 16, height: 16, marginTop: 3, flexShrink: 0 }}
          />
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>
              Show gig history on public calendar
            </p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "3px 0 0", lineHeight: 1.5 }}>
              Confirmed and completed bookings with dates will appear on your public profile calendar
            </p>
          </div>
        </label>

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
