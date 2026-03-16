import { redirect, Outlet, useLoaderData, NavLink } from "react-router";
import type { Route } from "./+types/_app";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export async function loader({ request }: Route.LoaderArgs) {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return redirect("/join", { headers: responseHeaders });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();

  return Response.json({ session, profile }, { headers: responseHeaders });
}

// ─── Nav items ────────────────────────────────────────────────────────────────

const topNavItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/profile", label: "Profile" },
  { to: "/service", label: "Service" },
  { to: "/domain", label: "Domain" },
  { to: "/media", label: "Media" },
];

const bottomNavItems = [
  { to: "/", label: "Dashboard", icon: "⊞", end: true },
  { to: "/office", label: "Office", icon: "📋" },
  { to: "/crew", label: "Crew", icon: "👥" },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function AppLayout() {
  const { profile } = useLoaderData<typeof loader>();

  const activeStyle: React.CSSProperties = { color: "#ffffff", fontWeight: 600 };
  const inactiveStyle: React.CSSProperties = { color: "rgba(255,255,255,0.45)" };

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

        {topNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            style={({ isActive }) => ({
              fontSize: 14,
              textDecoration: "none",
              ...(isActive ? activeStyle : inactiveStyle),
            })}
          >
            {item.label}
          </NavLink>
        ))}

        <div style={{ marginLeft: "auto" }}>
          <NavLink
            to="/account"
            style={({ isActive }) => ({
              fontSize: 14,
              textDecoration: "none",
              ...(isActive ? activeStyle : inactiveStyle),
            })}
          >
            {(profile as Record<string, unknown>)?.name as string ?? "Account"} ↓
          </NavLink>
        </div>
      </nav>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main style={{ paddingBottom: 80 }} className="md:pb-0">
        <Outlet />
      </main>

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
