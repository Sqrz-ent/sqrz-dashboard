import { GROW_TABS, GROW_TAB_LABELS, type GrowTab } from "~/lib/grow";
import SectionPills from "~/components/SectionPills";

// The iOS Grow tab's pill bar: Grow · Campaigns · Links · Analytics.
export default function GrowTabs({ active }: { active: GrowTab }) {
  return (
    <SectionPills
      pills={GROW_TABS.map((tab) => ({
        label: GROW_TAB_LABELS[tab],
        to: tab === "grow" ? "/grow" : `/grow?tab=${tab}`,
        active: tab === active,
      }))}
    />
  );
}
