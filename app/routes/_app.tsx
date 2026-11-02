import { useEffect, useRef, useState } from "react";
import { redirect, Link, Outlet, useLoaderData, useSearchParams, useNavigation, useLocation } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { requirePro } from "~/lib/pro.server";
import { getActiveProfile, listOwnedProfiles, getAccountBalanceCents } from "~/lib/profile.server";
import DashboardPanel, { type PanelKey } from "~/components/DashboardPanel";
import ProfileSwitcher, { TopupReturnNotice, type SwitcherProfile } from "~/components/ProfileSwitcher";
import SectionPills from "~/components/SectionPills";
import { MAIN_TABS, frameFor } from "~/lib/nav";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/login", { headers });
  }

  // SQRZ Pro gate — every dashboard route sits under this layout; each child
  // loader/action ALSO enforces it itself (child actions don't run this loader).
  await requirePro(supabase, user.id, headers);

  const profile = await getActiveProfile(request, supabase, user.id);

  // Guest profiles are deprecated (booking magic-link viewer removed with the
  // staged booking pipeline) — fall through to the home dashboard.
  if (profile?.user_type === 'guest') {
    return redirect('/');
  }

  // Header switcher data (web counterpart of iOS ActiveProfileStore + the
  // account sheet's wallet card): every profile this login owns, plus the
  // ACCOUNT-level wallet balance (account_wallets via profiles.account_id).
  const [profiles, balanceCents] = await Promise.all([
    listOwnedProfiles(supabase, user.id),
    getAccountBalanceCents(supabase, profile?.account_id as string | null | undefined),
  ]);

  return Response.json(
    {
      user,
      profile,
      profiles,
      balanceCents,
    },
    { headers }
  );
}

// ─── Nav config ───────────────────────────────────────────────────────────────

// One content width for every page (header, title, pills and content share it).
const CONTAINER_MAX = 1140;

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  // Response.json() loses the loader's types, so type the shape explicitly.
  const { profile, profiles, balanceCents } = useLoaderData<typeof loader>() as unknown as {
    profile: Record<string, unknown> | null;
    profiles: SwitcherProfile[];
    balanceCents: number;
  };

  const p = profile as Record<string, unknown> | null;

  // "Preview" (the iOS tab that shows the artist's own public page) opens it in a new tab.
  const profileSlug = (p?.slug as string | null) ?? "";
  const previewUrl = `https://${profileSlug}.sqrz.com`;

  const [searchParams, setSearchParams] = useSearchParams();

  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";
  const [isCompleting, setIsCompleting] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const wasNavigating = useRef(false);

  useEffect(() => {
    if (!isNavigating) {
      setShowProgress(false);
      return;
    }

    const t = setTimeout(() => setShowProgress(true), 220);
    return () => clearTimeout(t);
  }, [isNavigating]);

  useEffect(() => {
    if (wasNavigating.current && !isNavigating) {
      setIsCompleting(true);
      const t = setTimeout(() => setIsCompleting(false), 400);
      return () => clearTimeout(t);
    }
    wasNavigating.current = isNavigating;
  }, [isNavigating]);

  const location = useLocation();
  const pathname = location.pathname;

  // One frame for every page: which main tab is active, the page title and the
  // sub-section pills — all derived from the URL in lib/nav.ts (mirrors the iOS tabs).
  const frame = frameFor(pathname, searchParams);

  const activePanel = (searchParams.get("panel") as PanelKey | null) ?? null;

  function openPanel(panel: PanelKey) {
    setSearchParams({ panel });
  }

  function closePanel() {
    setSearchParams({});
  }

  // Compliance banner
  const hasCustomPixels = !!(
    (p?.pixel_google as string) ||
    (p?.pixel_facebook as string) ||
    (p?.pixel_linkedin as string) ||
    (p?.pixel_hubspot as string)
  );
  const impressumMissing = !(p?.responsible_person as string);
  const shouldShowCompliance = hasCustomPixels && impressumMissing;

  const DISMISS_KEY = "sqrz_compliance_dismissed_until";
  const [complianceDismissed, setComplianceDismissed] = useState(true); // start hidden, reveal after mount

  useEffect(() => {
    const until = localStorage.getItem(DISMISS_KEY);
    if (!until || Date.now() > Number(until)) {
      setComplianceDismissed(false);
    }
  }, []);

  function dismissCompliance() {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
    setComplianceDismissed(true);
  }

  const showComplianceBanner = shouldShowCompliance && !complianceDismissed;

  return (
    <div
      style={{
        background: "var(--bg)",
        minHeight: "100vh",
        color: "var(--text)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* ── Beta banner ─────────────────────────────────────────────────────── */}

      {/* ── Top progress bar ────────────────────────────────────────────────── */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          zIndex: 9999,
          pointerEvents: "none",
          opacity: showProgress || isCompleting ? 1 : 0,
          transition: isCompleting ? "opacity 300ms ease 100ms" : "opacity 150ms ease",
        }}
      >
        <div
          style={{
            height: "100%",
            background: "var(--accent, #F5A623)",
            transformOrigin: "left center",
            transform: isCompleting ? "scaleX(1)" : "scaleX(0.72)",
            transition: isCompleting ? "transform 100ms ease-out" : undefined,
            animation: showProgress ? "sqrzProgressPulse 900ms ease-in-out infinite alternate" : "none",
          }}
        />
      </div>

      {/* ── Top nav ──────────────────────────────────────────────────────────── */}
      {/* ── Header (identical on every page) ─────────────────────────────────────
          Logo left; balance, Top up and the profile switcher right. On desktop the
          main navigation (the iOS tabs) sits next to the logo; on mobile it lives in
          the bottom bar, so the mobile header is only logo + balance + Top up + switcher. */}
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, maxWidth: CONTAINER_MAX, margin: "0 auto", padding: "0 20px", height: 56 }}>
          <img
            src="/sqrz-logo.png"
            alt="SQRZ"
            style={{ height: "36px", width: "auto", display: "block", flexShrink: 0 }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />

          {/* Main navigation — desktop */}
          <nav className="hidden md:flex" aria-label="Main" style={{ alignItems: "center", gap: 4 }}>
            {MAIN_TABS.map((tab) => {
              const active = frame.tab === tab.key;
              const style: React.CSSProperties = {
                textDecoration: "none",
                fontSize: 14,
                fontWeight: 600,
                color: active ? "#F5A623" : "var(--text-muted)",
                padding: "6px 12px",
                borderRadius: 8,
                borderBottom: active ? "2px solid #F5A623" : "2px solid transparent",
                whiteSpace: "nowrap",
              };
              return tab.to ? (
                <Link key={tab.key} to={tab.to} prefetch="intent" aria-current={active ? "page" : undefined} style={style}>
                  {tab.label}
                </Link>
              ) : (
                <a key={tab.key} href={previewUrl} target="_blank" rel="noopener noreferrer" style={style}>
                  {tab.label} ↗
                </a>
              );
            })}
          </nav>

          {/* Balance + Top up + profile switcher */}
          {profile && profiles.length > 0 && (
            <ProfileSwitcher
              profiles={profiles}
              activeProfileId={profile.id as string}
              balanceCents={balanceCents}
            />
          )}
        </div>
      </header>

      <TopupReturnNotice balanceCents={balanceCents} />

      {/* ── Compliance warning banner ────────────────────────────────────────── */}
      {showComplianceBanner && (
        <div style={{
          background: "rgba(245,166,35,0.12)",
          borderBottom: "1px solid rgba(245,166,35,0.3)",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <p style={{ fontSize: 13, color: "var(--text)", margin: 0, lineHeight: 1.5, flex: 1, minWidth: 200 }}>
            You have active tracking pixels on your profile. EU law requires you to display an
            Impressum and privacy policy. Complete your business details to stay compliant.
          </p>
          <a
            href="/profile#business"
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#F5A623",
              textDecoration: "none",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Complete now →
          </a>
          <button
            onClick={dismissCompliance}
            aria-label="Dismiss"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 16,
              cursor: "pointer",
              padding: "2px 4px",
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main
        style={{
          paddingBottom: 80,
          opacity: isNavigating ? 0.3 : 1,
          transition: "opacity 200ms ease",
          pointerEvents: isNavigating ? "none" : undefined,
        }}
        className="md:pb-0"
      >
        {/* One content container for every page: same max width and left edge for the
            title, the pills and the content. */}
        <div style={{ maxWidth: CONTAINER_MAX, margin: "0 auto", padding: "28px 20px 60px" }}>
          {frame.title && (
            <h1
              style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 38,
                fontWeight: 800,
                color: "#F5A623",
                textTransform: "uppercase",
                letterSpacing: "0.03em",
                margin: `0 0 ${frame.pills.length ? 16 : 24}px`,
                lineHeight: 1,
              }}
            >
              {frame.title}
            </h1>
          )}
          <SectionPills pills={frame.pills} />
          <Outlet />
        </div>
      </main>

      {/* ── Panel overlay ───────────────────────────────────────────────────── */}
      <DashboardPanel
        panel={activePanel}
        profile={profile as Record<string, unknown> | null}
        onClose={closePanel}
      />

      {/* ── Mobile bottom nav ───────────────────────────────────────────────── */}
      {/* Visibility comes from classes only: an inline `display` would override md:hidden
          and show this bar on desktop too. */}
      <nav
        className="flex md:hidden"
        aria-label="Main"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderTop: "1px solid var(--border)",
          justifyContent: "space-around",
          padding: "10px 0 max(10px, env(safe-area-inset-bottom))",
          zIndex: 50,
          overflow: "visible",
          isolation: "isolate",
        }}
      >
        {MAIN_TABS.map((tab) => {
          const active = frame.tab === tab.key;
          const style: React.CSSProperties = {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 3,
            textDecoration: "none",
            fontSize: 11,
            color: active ? "#F5A623" : "var(--text-muted)",
          };
          const inner = (
            <>
              <span style={{ fontSize: 18 }}>{tab.icon}</span>
              <span>{tab.label}</span>
            </>
          );
          return tab.to ? (
            <Link key={tab.key} to={tab.to} aria-current={active ? "page" : undefined} style={style}>{inner}</Link>
          ) : (
            <a key={tab.key} href={previewUrl} target="_blank" rel="noopener noreferrer" style={style}>{inner}</a>
          );
        })}
      </nav>

      <style>{`
        @keyframes sqrzProgressPulse {
          0%   { opacity: 0.55; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
