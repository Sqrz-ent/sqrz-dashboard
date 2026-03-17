import { redirect, Outlet, useLoaderData, NavLink, useSearchParams } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import DashboardPanel, { type PanelKey } from "~/components/DashboardPanel";
import NotificationBell from "~/components/NotificationBell";

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return redirect("/login", { headers: responseHeaders });
  }

  const profile = await getCurrentProfile(supabase, session.user.id);

  return Response.json({ session, profile }, { headers: responseHeaders });
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const bottomNavItems = [
  { to: "/", label: "Dashboard", icon: "⊞", end: true },
  { to: "/office", label: "Office", icon: "📋" },
  { to: "/crew", label: "Crew", icon: "👥" },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { session, profile } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const activePanel = (searchParams.get("panel") as PanelKey | null) ?? null;

  function openPanel(panel: PanelKey) {
    setSearchParams({ panel });
  }

  function closePanel() {
    setSearchParams({});
  }

  return (
    <div
      style={{
        background: "#111111",
        minHeight: "100vh",
        color: "#e5e7eb",
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
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          position: "sticky",
          top: 0,
          background: "#111111",
          zIndex: 10,
        }}
      >
        <span
          style={{ color: "#ffffff", fontSize: 16, fontWeight: 800, letterSpacing: "0.2em", marginRight: 8 }}
        >
          [<span style={{ color: "#F5A623" }}> SQRZ </span>]
        </span>

        <div style={{ marginLeft: "auto" }}>
          <NotificationBell />
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
        userId={session.user.id}
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
          background: "#111111",
          borderTop: "1px solid rgba(255,255,255,0.08)",
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
              color: isActive ? "#F5A623" : "rgba(255,255,255,0.4)",
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
            color: "rgba(255,255,255,0.4)",
          }}
        >
          <span style={{ fontSize: 18 }}>💼</span>
          <span>Jobs</span>
        </a>
      </nav>
    </div>
  );
}
