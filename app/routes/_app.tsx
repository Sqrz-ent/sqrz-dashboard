import { useEffect, useState } from "react";
import { redirect, Outlet, useLoaderData, NavLink, useSearchParams } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import DashboardPanel, { type PanelKey } from "~/components/DashboardPanel";
import NotificationBell from "~/components/NotificationBell";
import UpgradeModal from "~/components/UpgradeModal";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);

  console.log("[loader] profile:", profile?.id, profile?.plan_id);

  // Fetch subscription + plan for AccountPanel (parallel queries)
  let subscriptionData: {
    planName: string;
    planDescription: string | null;
    status: string | null;
    currentPeriodEnd: string | null;
  } = { planName: "No plan", planDescription: null, status: null, currentPeriodEnd: null };

  if (profile) {
    const planId = profile.plan_id as number | null | undefined;

    const [subResult, planResult] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("status, current_period_end")
        .eq("profile_id", profile.id as string)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      planId
        ? supabase.from("plans").select("id, name, description").eq("id", planId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    subscriptionData = {
      planName: (planResult.data as Record<string, unknown> | null)?.name as string ?? "No plan",
      planDescription: (planResult.data as Record<string, unknown> | null)?.description as string ?? null,
      status: (subResult.data as Record<string, unknown> | null)?.status as string ?? null,
      currentPeriodEnd: (subResult.data as Record<string, unknown> | null)?.current_period_end as string ?? null,
    };
  }

  console.log("[loader] subscription:", subscriptionData);

  return Response.json(
    {
      user,
      profile,
      subscriptionData,
      basicMonthlyPriceId: process.env.STRIPE_BASIC_PRICE_ID_MONTHLY ?? "",
      basicYearlyPriceId: process.env.STRIPE_BASIC_PRICE_ID_YEARLY ?? "",
      earlyAccessCouponId: process.env.STRIPE_EARLY_ACCESS_COUPON_ID ?? "",
    },
    { headers }
  );
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const topNavItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/profile", label: "Profile" },
  { to: "/service", label: "Service" },
  { to: "/domain", label: "Domain" },
  { to: "/media", label: "Media" },
  { to: "/account", label: "Account" },
];

const bottomNavItems = [
  { to: "/", label: "Dashboard", icon: "⊞", end: true },
  { to: "/office", label: "Office", icon: "📋" },
  { to: "/crew", label: "Crew", icon: "👥" },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { user, profile, subscriptionData, basicMonthlyPriceId, basicYearlyPriceId, earlyAccessCouponId } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = localStorage.getItem("sqrz_theme") as "dark" | "light" | null;
    const initial = saved ?? "dark";
    setTheme(initial);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(initial);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sqrz_theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }

  const activePanel = (searchParams.get("panel") as PanelKey | null) ?? null;

  function openPanel(panel: PanelKey) {
    setSearchParams({ panel });
  }

  function closePanel() {
    setSearchParams({});
  }

  // Show Upgrade button only when user has no plan (null or 0)
  const planId = (profile as Record<string, unknown> | null)?.plan_id as number | null | undefined;
  const showUpgrade = !planId || planId === 0;

  return (
    <div
      style={{
        background: "var(--bg)",
        minHeight: "100vh",
        color: "var(--text)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      {/* ── Desktop top nav ─────────────────────────────────────────────────── */}
      <nav
        className="hidden md:flex"
        style={{
          alignItems: "center",
          gap: 28,
          padding: "0 28px",
          height: 56,
          borderBottom: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 10,
        }}
      >
        <img src="/sqrz_logo.png" alt="SQRZ" style={{ height: 36, width: "auto", marginRight: 8, display: "block" }} />

        {/* Top nav tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
          {showUpgrade && (
            <button
              onClick={() => setUpgradeOpen(true)}
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
          <NotificationBell />
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 18,
              cursor: "pointer",
              padding: "4px 6px",
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
            }}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </nav>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main style={{ paddingBottom: 80 }} className="md:pb-0">
        <Outlet />
      </main>

      {/* ── Panel overlay ───────────────────────────────────────────────────── */}
      <DashboardPanel
        panel={activePanel}
        profile={profile as Record<string, unknown> | null}
        userId={(user as { id: string }).id}
        onClose={closePanel}
        subscription={subscriptionData}
        onUpgrade={() => setUpgradeOpen(true)}
      />

      {/* ── Upgrade modal ────────────────────────────────────────────────────── */}
      {upgradeOpen && (
        <UpgradeModal
          onClose={() => setUpgradeOpen(false)}
          monthlyPriceId={basicMonthlyPriceId}
          yearlyPriceId={basicYearlyPriceId}
          earlyAccessCouponId={earlyAccessCouponId}
          referredByCode={(profile as Record<string, unknown> | null)?.referred_by_code as string | null ?? null}
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
          zIndex: 10,
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

        <a
          href="https://jobs.sqrz.com"
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
          <span style={{ fontSize: 18 }}>💼</span>
          <span>Jobs</span>
        </a>
      </nav>
    </div>
  );
}
