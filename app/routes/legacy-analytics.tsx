import { redirect } from "react-router";
import type { Route } from "./+types/legacy-analytics";
import { GROW_PATH } from "~/lib/campaigns";

// Grow used to live at /analytics — permanent redirect to its real home, /grow,
// preserving the query string so old tab links (?tab=campaigns etc.) keep working.
export function loader({ request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`${GROW_PATH}${search}`, 301);
}
