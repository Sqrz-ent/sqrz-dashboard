import { redirect } from "react-router";
import type { Route } from "./+types/_app.domain";

// /domain was folded into /account on 2026-08-01 (nav consolidation down to
// Dashboard/Profile/Business/Account — see _app.account.tsx for the relocated
// pixel-tracking + custom-domain cards, moved with their logic intact). This
// route stays alive as a redirect only, so old bookmarks/links never 404.
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/account${url.search}`);
}
