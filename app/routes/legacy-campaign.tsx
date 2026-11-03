import { redirect } from "react-router";
import type { Route } from "./+types/legacy-campaign";
import { campaignPath, GROW_CAMPAIGNS_PATH } from "~/lib/campaigns";

// /campaigns/:id → /grow/campaigns/:id (Grow). The id is only used to build
// the redirect target and is validated first; the destination route does the
// login, Pro and ownership checks.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loader({ params }: Route.LoaderArgs) {
  const id = params.id ?? "";
  return redirect(UUID_RE.test(id) ? campaignPath(id) : GROW_CAMPAIGNS_PATH);
}
