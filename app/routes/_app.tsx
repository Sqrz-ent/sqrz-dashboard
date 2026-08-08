import { useEffect, useRef, useState } from "react";
import { redirect, Outlet, useLoaderData, NavLink, useSearchParams, useNavigation, useLocation } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import DashboardPanel, { type PanelKey } from "~/components/DashboardPanel";
import PartnerInviteBanner from "~/components/PartnerInviteBanner";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);

  // Guest profiles are deprecated (booking magic-link viewer removed with the
  // staged booking pipeline) — fall through to the home dashboard.
  if (profile?.user_type === 'guest') {
    return redirect('/');
  }

  return Response.json(
    {
      user,
      profile,
      isPartner: !!(profile?.is_partner as boolean | null),
      partnerInviteStatus: (profile?.partner_invite_status as string | null) ?? null,
      partnerInvitedAt: (profile?.partner_invited_at as string | null) ?? null,
    },
    { headers }
  );
}

// ─── Nav config ───────────────────────────────────────────────────────────────

// No Boost/Grow item here — Boost and Grow live exclusively in the Grow nav
// section (the /analytics route, reached via the main dashboard nav). This
// profile-builder menu is profile setup only.
// "Links" was removed 2026-08-01 — it now lives as a nav pill inside the Grow
// tab bar (/analytics) instead of this submenu. "Domain" was removed
// 2026-08-01 too — the custom-domain card moved into Account (see
// _app.account.tsx), folding the whole page in rather than leaving a
// half-empty destination. Final structure is exactly four: Dashboard,
// Profile, Business, Account — "Dashboard" itself stays as-is, an
// explicitly deferred rename from an earlier pass.
const topNavItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/profile", label: "Profile" },
  { to: "/service", label: "Business" },
  { to: "/account", label: "Account" },
];

// "Analytics" → "Grow": the /analytics route is now a static promo page
// (2026-08-06 collapse — see _app.analytics.tsx). Route path kept as /analytics.
//
// Bottom-nav "Profile" (2026-08-01) is the internal dashboard/profile-editing
// home (`/`) — distinct from `fourthNav`'s "Preview" below, which is the
// external link to the artist's own public page. Renamed from "Dashboard" +
// swapped the icon from a generic grid glyph to a person glyph so it reads as
// profile-appropriate; "Preview" got the freed-up-in-spirit eye glyph.
const bottomNavItems = [
  { to: "/", label: "Profile", icon: "👤", end: true },
  // "Office" → "Leads" (2026-08-07) — display-only, matching sqrz-ios's
  // identical rename. Route path (/office), file/route name (_app.office.tsx,
  // OfficePage), and internal comments/symbols are deliberately untouched.
  { to: "/office", label: "Leads", icon: "📋" },
  { to: "/analytics", label: "Grow", icon: "📊" },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { user, profile, isPartner, partnerInviteStatus, partnerInvitedAt } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown> | null;

  // 4th bottom-nav slot — beta invite access takes precedence, else own profile
  const profileSlug = (p?.slug as string | null) ?? "";
  const fourthNav = isPartner
    ? { to: "/invites", external: false, icon: "✦", label: "Invites" }
    : { to: `https://${profileSlug}.sqrz.com`, external: true, icon: "👁", label: "Preview" };

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

  // Grow (/analytics) and Office (/office) are both standalone destinations
  // outside the Dashboard/Profile/Business/Account tab flow — the submenu
  // doesn't belong above either. Logo stays for branding/wayfinding home;
  // only the submenu links are hidden. Office used to get its own minimal
  // "← Back" work-mode header instead of this nav entirely; removed
  // 2026-08-07 in favor of this same logo-only nav treatment.
  const hideTopSubmenuRoutes = ["/analytics", "/office"];
  const hideTopSubmenu = hideTopSubmenuRoutes.some(r => pathname === r || pathname.startsWith(r + "/"));

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
      <nav
        className="flex"
        style={{
          alignItems: "center",
          gap: 16,
          padding: "0 16px",
          height: 56,
          borderBottom: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 10,
          width: "100vw",
          maxWidth: "100vw",
          overflowX: "auto",
        }}
      >
          <img
            src="/sqrz-logo.png"
            alt="SQRZ"
            style={{ height: "36px", width: "auto", display: "block", marginRight: 8 }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />

          {/* Top nav tabs */}
          {!hideTopSubmenu && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", minWidth: "max-content" }}>
              {topNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  style={({ isActive }) => ({
                    textDecoration: "none",
                    fontSize: 13,
                    fontWeight: 500,
                    color: isActive ? "#F5A623" : "var(--text-muted)",
                    padding: "6px 12px",
                    borderRadius: 8,
                    borderBottom: isActive ? "2px solid #F5A623" : "2px solid transparent",
                    letterSpacing: "0.01em",
                    transition: "color 0.15s",
                  })}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          )}

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {!!p?.is_beta && (
              <span style={{
                background: "var(--accent, #F5A623)",
                color: "#111111",
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                borderRadius: 20,
                padding: "3px 8px",
                lineHeight: 1,
              }}>
                Beta
              </span>
            )}
          </div>
      </nav>

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

      {/* ── Partner invite banner ───────────────────────────────────────────── */}
      {partnerInviteStatus === "invited" && (
        <PartnerInviteBanner invitedAt={partnerInvitedAt} />
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
        <Outlet />
      </main>

      {/* ── Panel overlay ───────────────────────────────────────────────────── */}
      <DashboardPanel
        panel={activePanel}
        profile={profile as Record<string, unknown> | null}
        userId={(user as { id: string }).id}
        onClose={closePanel}
      />

      {/* ── Mobile bottom nav ───────────────────────────────────────────────── */}
      <nav
        className="md:hidden"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-around",
          padding: "10px 0 max(10px, env(safe-area-inset-bottom))",
          zIndex: 50,
          overflow: "visible",
          isolation: "isolate",
        }}
      >
        {bottomNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            style={({ isActive }) => ({
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              textDecoration: "none",
              fontSize: 11,
              color: isActive ? "#F5A623" : "var(--text-muted)",
            })}
          >
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
        {fourthNav.external ? (
          <a
            href={fourthNav.to}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              textDecoration: "none",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            <span style={{ fontSize: 18 }}>{fourthNav.icon}</span>
            <span>{fourthNav.label}</span>
          </a>
        ) : (
          <NavLink
            to={fourthNav.to}
            style={({ isActive }) => ({
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              textDecoration: "none",
              fontSize: 11,
              color: isActive ? "#F5A623" : "var(--text-muted)",
            })}
          >
            <span style={{ fontSize: 18 }}>{fourthNav.icon}</span>
            <span>{fourthNav.label}</span>
          </NavLink>
        )}
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
