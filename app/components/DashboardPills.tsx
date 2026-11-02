import { useLocation } from "react-router";
import SectionPills from "~/components/SectionPills";

// The Dashboard's sub-navigation (iOS DashboardShellView): Dashboard · Profile ·
// Business · Account, as a pill row under the page title — same component and
// styling as the Grow pills. The active pill follows the current URL.
const ITEMS = [
  { label: "Dashboard", to: "/" },
  { label: "Profile", to: "/profile" },
  { label: "Business", to: "/service" },
  { label: "Account", to: "/account" },
];

export default function DashboardPills({ style }: { style?: React.CSSProperties }) {
  const path = useLocation().pathname.replace(/\/+$/, "") || "/";
  return <SectionPills pills={ITEMS.map((i) => ({ ...i, active: i.to === path }))} style={style} />;
}
