import { redirect } from "react-router";
import { GROW_PATH } from "~/lib/campaigns";

// Campaigns now live inside Grow — keep old /campaigns links working.
// (No data here; the Grow page itself enforces login + the Pro gate.)
export function loader() {
  return redirect(GROW_PATH);
}
