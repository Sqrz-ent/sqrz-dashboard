import { redirect } from "react-router";
import type { Route } from "./+types/legacy-analytics-link";

// /analytics/links/:id → /grow/links/:id. Permanent redirect, query string
// preserved. The destination route does the login/Pro/ownership checks.
export function loader({ params, request }: Route.LoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`/grow/links/${params.id ?? ""}${search}`, 301);
}
