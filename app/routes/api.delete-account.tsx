import type { Route } from "./+types/api.delete-account";
import { createSupabaseBearerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Thin authenticated forwarder to the delete-account edge function — iOS-
// only. Unlike api.campaign-advisor.tsx / api.profile-advisor.tsx, there is
// no web UI for account deletion at all, so a non-Bearer (cookie/web) caller
// is rejected outright rather than given a structured "available in the
// app" 200 — there's no legitimate reason a web session would ever call
// this.
//
// This is the trust boundary: resolves the caller's OWN profile_id/
// auth_user_id from their real session and NEVER accepts either as client
// input. The edge function is invoked via a service-role admin client, whose
// Authorization header carries the SERVICE ROLE key, not this caller's own
// token — so it cannot verify a Bearer token itself (same constraint as
// profile-advisor's deployed, non-hardened variant) and trusts whatever this
// forwarder passes.
export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) {
    return Response.json(
      { error: "Account deletion is only available in the SQRZ iOS app." },
      { status: 403 },
    );
  }

  const supabase = createSupabaseBearerClient(bearerToken);
  const { data: { user } } = await supabase.auth.getUser(bearerToken);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404 });
  }

  let body: { apple_authorization_code?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const appleAuthorizationCode = String(body?.apple_authorization_code ?? "");
  if (!appleAuthorizationCode) {
    return Response.json({ error: "apple_authorization_code required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.functions.invoke("delete-account", {
    body: {
      profile_id: profile.id,
      auth_user_id: user.id,
      apple_authorization_code: appleAuthorizationCode,
    },
  });

  if (error || !data) {
    return Response.json({ error: "Account deletion failed" }, { status: 502 });
  }

  // The edge function deliberately returns every expected outcome — success,
  // "money_in_play", "apple_verification_failed" — as a plain 200 body (see
  // its own comments): admin.functions.invoke() treats any non-2xx as a
  // transport-level error and drops the body, which would lose these for the
  // iOS client. Relay the body as-is; iOS branches on the `error` field.
  return Response.json(data);
}
