import { redirect } from "react-router";
import type { Route } from "./+types/_app.boost";

// Self-serve Boost campaign creation moved to iOS-only (2026-08-06 Grow
// collapse — see _app.analytics.tsx). This route stays alive purely as a
// redirect for anything that still links here directly (bookmarks, etc.) —
// same pattern as _app.partners.tsx → /invites.
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/analytics${url.search}`);
}
