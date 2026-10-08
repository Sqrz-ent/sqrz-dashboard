import type { Route } from "./+types/api.profile-advisor";
import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Thin authenticated forwarder to the `profile-advisor` edge function — the
// profile-level sibling of api.campaign-advisor.tsx (same shape, deliberately
// mirrored). ANTHROPIC_API_KEY lives only in the edge function; this route's
// job is auth + the iOS-app gate, nothing else. No campaign_id / ownership
// check needed here — there's no second party's row to own, just the
// caller's own profile, resolved below via getCurrentProfile.
//
// Dual auth: the browser flow authenticates via cookies; native callers
// (sqrz-ios) send a Bearer access token. The rate-limit decision (one free
// run/week until the profile has an activated campaign, unlimited after —
// no RevenueCat/grow_access check at all, same rule for everyone) lives in
// the edge function itself, not here — this route only decides whether the
// feature exists for this caller at all (the iOS-app gate below).
export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  // ── iOS-app entitlement gate ─────────────────────────────────────────────────
  // Same gate as api.campaign-advisor.tsx: access to the iOS app is itself the
  // gate right now (TestFlight, invite-only). A non-native (web) caller gets a
  // structured 200 instead of a 403 or a paid LLM call.
  if (!isNative) {
    return Response.json(
      {
        locked: true,
        health: null,
        summary: "Recommendations are available in the SQRZ iOS app.",
        insights: [],
        actions: [],
      },
      { headers },
    );
  }

  // The edge function is invoked via a service-role admin client, whose
  // Authorization header carries the SERVICE ROLE key, not this caller's own
  // token — so the function cannot verify a Bearer token itself (same
  // constraint as campaign-advisor's deployed, non-hardened variant). This
  // forwarder is the security boundary: profile ownership was already
  // resolved above via getCurrentProfile(supabase, user.id), so it's safe to
  // pass profile_id through directly.
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.functions.invoke("profile-advisor", {
    body: { profile_id: profile.id },
  });

  if (error || !data) {
    return Response.json({ error: "Advisor unavailable" }, { status: 502, headers });
  }

  return Response.json(data, { headers });
}
