import { redirect } from "react-router";
import type { Route } from "./+types/api.active-profile";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile, serializeActiveProfileCookie } from "~/lib/profile.server";

// Same-origin relative paths only (mirrors safeNextPath in auth.callback.tsx).
function safePath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return "/";
  return raw;
}

// Switch the active profile (web). POST { profile_id, redirect_to? } from the
// header switcher. The id is verified against the signed-in user before it is
// stored — the cookie is only ever a preference, never trusted on read either
// (see getActiveProfile). No profile creation here: that stays in the iOS app.
export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const formData = await request.formData();
  const profileId = String(formData.get("profile_id") ?? "");
  const next = safePath(String(formData.get("redirect_to") ?? ""));

  const owned = profileId ? await getCurrentProfile(supabase, user.id, profileId) : null;
  if (!owned) {
    return Response.json({ error: "Profile not found" }, { status: 403, headers });
  }

  headers.append("Set-Cookie", serializeActiveProfileCookie(owned.id as string));
  return redirect(next, { headers });
}
