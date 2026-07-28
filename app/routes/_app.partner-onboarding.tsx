import { redirect } from "react-router";
import type { Route } from "./+types/_app.partner-onboarding";

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/invite-onboarding${url.search}`);
}
