import { redirect } from "react-router";

// Web signup was retired (2026-11): SQRZ accounts are created in the iOS app
// (Sign in with Apple). The route stays only so old links — marketing pages,
// bookmarks, emails — land on the login page instead of a 404.
// Account creation is also blocked server-side by the before-user-created auth
// hook (supabase/migrations/20261106120000_before_user_created_hook.sql).
export function loader() {
  return redirect("/login");
}
