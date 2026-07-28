import { redirect } from "react-router";
import type { Route } from "./+types/_app.partners";

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/invites${url.search}`);
}
