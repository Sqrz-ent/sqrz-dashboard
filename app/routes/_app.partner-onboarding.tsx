import { redirect } from "react-router";
import type { Route } from "./+types/_app.partner-onboarding";

// /invite-onboarding (and the whole invitees/partners dashboard section it
// fronted) was removed 2026-08-08 — kept as a bare redirect for old
// bookmarks, same "keep alive" pattern already used elsewhere
// (_app.boost.tsx/_app.links.tsx → /analytics), just pointed at a still-live
// destination now that /invite-onboarding itself is gone.
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/office${url.search}`);
}
