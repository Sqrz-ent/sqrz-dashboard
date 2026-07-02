import { useEffect, useRef, useState } from "react";
import { redirect, Outlet, useLoaderData, NavLink, useSearchParams, useNavigation, useLocation, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { normalizeTaxPresets } from "~/lib/tax-presets";
import DashboardPanel, { type PanelKey } from "~/components/DashboardPanel";
import UpgradeModal from "~/components/UpgradeModal";
import OnboardingModal from "~/components/OnboardingModal";
import PartnerInviteBanner from "~/components/PartnerInviteBanner";
import InquiryBubble from "~/components/InquiryBubble";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const admin = createSupabaseAdminClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);

  if (profile?.user_type === 'guest') {
    const url = new URL(request.url);
    const next = url.searchParams.get('next');

    // If coming from a booking magic link — redirect there
    if (next && next.startsWith('/booking/')) {
      return redirect(next);
    }

    // Guest profiles are deprecated — fall through to dashboard
    return redirect('/dashboard');
  }

  // Fetch subscription + services in parallel; plan query follows subscription result
  let subscriptionData: {
    planName: string;
    planDescription: string | null;
    status: string | null;
    currentPeriodEnd: string | null;
  } = { planName: "No plan", planDescription: null, status: null, currentPeriodEnd: null };

  const [subQueryResult, servicesResult] = profile
    ? await Promise.all([
        supabase
          .from("subscriptions")
          .select("status, current_period_end, stripe_price_id")
          .eq("profile_id", profile.id as string)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Use the admin client (not the RLS-scoped `supabase`): the owner reads their
        // own services here regardless of is_published. The profile_services RLS owner
        // policy compares auth.uid() to profile_id (= profiles.id), which never matches
        // for migrated users (profiles.id != auth.users.id), and public_read is gated on
        // is_published — so the RLS path returns nothing for unpublished owners.
        admin
          .from("profile_services")
          .select("id, title, booking_type")
          .eq("profile_id", profile.id as string)
          .eq("is_active", true)
          .order("sort_order"),
      ])
    : [{ data: null }, { data: [] as Array<{ id: string; title: string; booking_type: string }> }];

  if (profile) {
    const planId = profile.plan_id as number | null | undefined;
    const sub = subQueryResult.data as Record<string, unknown> | null;
    const priceId = sub?.stripe_price_id as string | null;

    const planResult = priceId
      ? await supabase
          .from("plans")
          .select("name, description")
          .or(`stripe_price_monthly.eq.${priceId},stripe_price_yearly.eq.${priceId}`)
          .maybeSingle()
      : planId
        ? await supabase.from("plans").select("name, description").eq("id", planId).maybeSingle()
        : { data: null };

    subscriptionData = {
      planName: (planResult.data as Record<string, unknown> | null)?.name as string ?? "No plan",
      planDescription: (planResult.data as Record<string, unknown> | null)?.description as string ?? null,
      status: sub?.status as string ?? null,
      currentPeriodEnd: sub?.current_period_end as string ?? null,
    };
  }

  return Response.json(
    {
      user,
      profile,
      services: servicesResult.data ?? [],
      subscriptionData,
      creatorMonthlyPriceId: process.env.STRIPE_CREATOR_PRICE_ID_MONTHLY ?? "",
      creatorYearlyPriceId: process.env.STRIPE_CREATOR_PRICE_ID_YEARLY ?? "",
      isPartner: !!(profile?.is_partner as boolean | null),
      partnerInviteStatus: (profile?.partner_invite_status as string | null) ?? null,
      partnerInvitedAt: (profile?.partner_invited_at as string | null) ?? null,
    },
    { headers }
  );
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const topNavItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/profile", label: "Profile" },
  { to: "/service", label: "Business" },
  { to: "/boost", label: "Boost" },
  { to: "/domain", label: "Domain" },
  { to: "/links", label: "Links" },
  { to: "/payments", label: "Payments" },
  { to: "/account", label: "Account" },
];

const bottomNavItems = [
  { to: "/", label: "Dashboard", icon: "⊞", end: true },
  { to: "/office", label: "Office", icon: "📋" },
  { to: "/analytics", label: "Analytics", icon: "📊" },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { user, profile, services, subscriptionData, creatorMonthlyPriceId, creatorYearlyPriceId, isPartner, partnerInviteStatus, partnerInvitedAt } =
    useLoaderData<typeof loader>();

  const p = profile as Record<string, unknown> | null;

  // 4th bottom-nav slot — partner takes precedence, then beta crew, else own profile
  const isBeta = !!(p?.is_beta as boolean | null);
  const profileSlug = (p?.slug as string | null) ?? "";
  const fourthNav = isPartner
    ? { to: "/partners", external: false, icon: "🤝", label: "Partners" }
    : isBeta
    ? { to: "/crew", external: false, icon: "👥", label: "Crew" }
    : { to: `https://${profileSlug}.sqrz.com`, external: true, icon: "👤", label: "Profile" };

  const [showOnboarding, setShowOnboarding] = useState(false);
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const upgradeParam = searchParams.get("upgrade");
  const [upgradeContext, setUpgradeContext] = useState<string | null>(upgradeParam);
  const upgradeOpen = !!upgradeContext;
  function openUpgrade(context = "1") {
    setUpgradeContext(context);
  }
  function closeUpgrade() {
    setUpgradeContext(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("upgrade")) {
        url.searchParams.delete("upgrade");
        const next = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(window.history.state, "", next);
      }
    }
  }

  useEffect(() => {
    if (p !== null && p.onboarding_completed === false) {
      setShowOnboarding(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (upgradeParam) {
      setUpgradeContext(upgradeParam);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("upgrade");
        const next = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(window.history.state, "", next);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleOpenUpgrade(event: Event) {
      const customEvent = event as CustomEvent<{ context?: string }>;
      setUpgradeContext(customEvent.detail?.context ?? "1");
    }

    window.addEventListener("sqrz:open-upgrade", handleOpenUpgrade as EventListener);
    return () => {
      window.removeEventListener("sqrz:open-upgrade", handleOpenUpgrade as EventListener);
    };
  }, []);

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
  const navigate = useNavigate();
  const pathname = location.pathname;

  const workModeRoutes = ["/office", "/crew"];
  const isWorkMode = workModeRoutes.some(r => pathname === r || pathname.startsWith(r + "/"));

  // Derive work mode title + breadcrumb from pathname
  function getWorkModeTitle(): { title: string; breadcrumb: string | null } {
    if (pathname === "/partners") return { title: "Partners", breadcrumb: null };
    if (pathname === "/partner-onboarding") return { title: "Partner Program", breadcrumb: null };
    if (pathname.startsWith("/office/")) return { title: "Booking Detail", breadcrumb: "Office" };
    if (pathname === "/office") return { title: "Office", breadcrumb: null };
    if (pathname.startsWith("/crew/")) return { title: "Crew", breadcrumb: "Crew" };
    if (pathname === "/crew") return { title: "Crew", breadcrumb: null };
    return { title: "Dashboard", breadcrumb: null };
  }
  const { title: workTitle, breadcrumb } = getWorkModeTitle();

  const activePanel = (searchParams.get("panel") as PanelKey | null) ?? null;

  function openPanel(panel: PanelKey) {
    setSearchParams({ panel });
  }

  function closePanel() {
    setSearchParams({});
  }

  // Show Upgrade button only when user has no plan (null or 0)
  const planId = p?.plan_id as number | null | undefined;
  const showUpgrade = !planId || planId === 0;

  // Compliance banner
  const isPaid = planId != null && planId >= 1;
  const hasCustomPixels = !!(
    (p?.pixel_google as string) ||
    (p?.pixel_facebook as string) ||
    (p?.pixel_linkedin as string) ||
    (p?.pixel_hubspot as string)
  );
  const impressumMissing = !(p?.responsible_person as string);
  const shouldShowCompliance = isPaid && hasCustomPixels && impressumMissing;

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

      {/* ── Top nav — dashboard mode ─────────────────────────────────────────── */}
      {!isWorkMode && (
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
            {showUpgrade && (
              <button
                onClick={() => openUpgrade()}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(245,166,35,0.5)",
                  color: "#F5A623",
                  fontSize: 12,
                  fontWeight: 600,
                  borderRadius: 20,
                  padding: "5px 13px",
                  cursor: "pointer",
                  letterSpacing: "0.02em",
                }}
              >
                Upgrade
              </button>
            )}
          </div>
        </nav>
      )}

      {/* ── Minimal header — work mode ───────────────────────────────────────── */}
      {isWorkMode && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            height: 56,
            padding: "0 16px",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          {/* Left — back */}
          <div style={{ display: "flex", alignItems: "center", minWidth: 80 }}>
            <button
              onClick={() => navigate(-1)}
              aria-label="Back"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                fontSize: 13,
                cursor: "pointer",
                padding: "4px 6px",
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              ← Back
            </button>
          </div>

          {/* Center — page title */}
          <div style={{ flex: 1, textAlign: "center" }}>
            <span style={{
              fontSize: 15,
              fontWeight: 700,
              color: "var(--text)",
              letterSpacing: "0.01em",
            }}>
              {workTitle}
            </span>
          </div>

          {/* Right — spacer (balances the back button, keeps the title centered) */}
          <div style={{ minWidth: 80 }} />
        </header>
      )}

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
        subscription={subscriptionData}
        onUpgrade={() => openUpgrade()}
      />

      <InquiryBubble
      enabled={true}
      chatEnabled={(p?.inquiry_chat_enabled as boolean | null) !== false}
      services={(services as Array<{ id: string; title: string; booking_type: string }>) ?? []}
      taxPresets={normalizeTaxPresets(p?.tax_presets)}
      />

      {/* ── Onboarding modal ─────────────────────────────────────────────────── */}
      {showOnboarding && p && (
        <OnboardingModal
          profileId={p.id as string}
          slug={p.slug as string}
          initialFirstName={(p.first_name as string) ?? ""}
          initialLastName={(p.last_name as string) ?? ""}
          initialAvatarUrl={(p.avatar_url as string) ?? ""}
          onComplete={() => { setShowOnboarding(false); revalidator.revalidate(); }}
        />
      )}

      {/* ── Upgrade modal ────────────────────────────────────────────────────── */}
      {upgradeOpen && upgradeContext && (
        <UpgradeModal
          onClose={closeUpgrade}
          upgradeContext={upgradeContext}
          monthlyPriceId={creatorMonthlyPriceId}
          yearlyPriceId={creatorYearlyPriceId}
          referredByCode={p?.referred_by_code as string | null ?? null}
        />
      )}

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
