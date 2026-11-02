// The web dashboard's navigation model — mirrors the iOS app (sqrz-ios):
//   Main tabs (MainTabView):      Profile · Leads · Grow · Preview
//   Profile tab sub-menu (DashboardShellView): Dashboard · Profile · Business · Account
//   Grow tab sub-menu (GrowTabView):           Grow · Campaigns · Links · Analytics
// Account is ALSO reachable from the profile switcher menu (iOS opens it from the
// avatar sheet). One layout (routes/_app.tsx) renders header, main nav, page title
// and sub-section pills from this single source, so every page has the same frame.

export type MainTabKey = "profile" | "leads" | "grow" | "preview";

export type MainTab = {
  key: MainTabKey;
  label: string;
  to: string | null; // null = external (Preview opens the public page)
  icon: string;
};

// Same names and order as the iOS tab bar.
export const MAIN_TABS: MainTab[] = [
  { key: "profile", label: "Profile", to: "/", icon: "👤" },
  { key: "leads", label: "Leads", to: "/office", icon: "📋" },
  { key: "grow", label: "Grow", to: "/analytics", icon: "📊" },
  { key: "preview", label: "Preview", to: null, icon: "👁" },
];

export type NavPill = { label: string; to: string; active: boolean };

export type PageFrame = {
  tab: MainTabKey | null; // which main tab is active (Preview is external, never active)
  title: string;
  pills: NavPill[];
};

const GROW_TABS = [
  { key: "grow", label: "Grow" },
  { key: "campaigns", label: "Campaigns" },
  { key: "links", label: "Links" },
  { key: "analytics", label: "Analytics" },
] as const;

const PROFILE_PILLS = [
  { label: "Dashboard", to: "/", match: (p: string) => p === "/" },
  { label: "Profile", to: "/profile", match: (p: string) => p === "/profile" },
  { label: "Business", to: "/service", match: (p: string) => p === "/service" },
  { label: "Account", to: "/account", match: (p: string) => p === "/account" },
];

// Which Grow pill a Grow URL belongs to (tabs live in ?tab=; detail pages sit under their tab).
export function growTabFor(pathname: string, search: URLSearchParams): (typeof GROW_TABS)[number]["key"] {
  if (pathname.startsWith("/analytics/links/")) return "links";
  if (pathname.startsWith("/analytics/campaigns/new/")) return "grow"; // templates live on the Grow pill
  if (pathname.startsWith("/analytics/campaigns/")) return "campaigns";
  const t = search.get("tab");
  return GROW_TABS.some((g) => g.key === t) ? (t as (typeof GROW_TABS)[number]["key"]) : "grow";
}

export function frameFor(pathname: string, search: URLSearchParams): PageFrame {
  const path = pathname.replace(/\/+$/, "") || "/";

  if (path === "/analytics" || path.startsWith("/analytics/")) {
    const active = growTabFor(path, search);
    return {
      tab: "grow",
      title: "Grow",
      pills: GROW_TABS.map((g) => ({
        label: g.label,
        to: g.key === "grow" ? "/analytics" : `/analytics?tab=${g.key}`,
        active: g.key === active,
      })),
    };
  }

  if (path === "/office") return { tab: "leads", title: "Leads", pills: [] };

  if (PROFILE_PILLS.some((p) => p.match(path))) {
    return {
      tab: "profile",
      title: "Profile",
      pills: PROFILE_PILLS.map((p) => ({ label: p.label, to: p.to, active: p.match(path) })),
    };
  }

  if (path === "/notifications") return { tab: null, title: "Notifications", pills: [] };

  return { tab: null, title: "", pills: [] };
}
