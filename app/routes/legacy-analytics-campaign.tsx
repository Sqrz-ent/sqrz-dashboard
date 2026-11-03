import { redirect } from "react-router";
import type { Route } from "./+types/legacy-analytics-campaign";
import { campaignPath } from "~/lib/campaigns";

// /analytics/campaigns/:id → /grow/campaigns/:id. Permanent redirect, query
// string preserved. The destination route does the login/Pro/ownership checks.
export function loader({ params, request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`${campaignPath(params.id ?? "")}${search}`, 301);
}
