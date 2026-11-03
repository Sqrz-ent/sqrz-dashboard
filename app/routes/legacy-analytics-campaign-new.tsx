import { redirect } from "react-router";
import type { Route } from "./+types/legacy-analytics-campaign-new";

// /analytics/campaigns/new/:templateId → /grow/campaigns/new/:templateId.
// Permanent redirect, query string preserved. Stays hidden behind
// web_campaign_create_enabled at the destination route, same as before.
export function loader({ params, request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`/grow/campaigns/new/${params.templateId ?? ""}${search}`, 301);
}
