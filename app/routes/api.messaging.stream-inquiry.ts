import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { listOpenInquiryThreadsForProfile, resolveOwnedProfileId } from "~/lib/messaging/inquiry.server";

export async function loader({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const authPath = bearerToken ? "bearer" : "cookie";

  let headers = new Headers();

  try {
    let supabase;
    let user;

    if (bearerToken) {
      supabase = createSupabaseBearerClient(bearerToken);
      ({
        data: { user },
      } = await supabase.auth.getUser(bearerToken));
    } else {
      ({ supabase, headers } = createSupabaseServerClient(request));
      ({
        data: { user },
      } = await supabase.auth.getUser());
    }

    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    }

    // Multi-profile ownership (2026-10-18) — a login can own more than one
    // profile, so this can no longer assume .eq("user_id", user.id) ever
    // resolves to exactly one row. iOS's ActiveProfileStore sends which
    // profile it means via ?profile_id=; an older/unaware caller falls
    // back to the oldest profile. See resolveOwnedProfileId's own doc
    // comment for the full story (this is what was producing the 404).
    const requestedProfileId = new URL(request.url).searchParams.get("profile_id");
    const profileId = await resolveOwnedProfileId(supabase, user.id, requestedProfileId);

    if (!profileId) {
      return Response.json({ error: "Profile not found" }, { status: 404, headers });
    }

    const session = await listOpenInquiryThreadsForProfile(profileId);
    return Response.json(session ?? { threads: [] }, { headers });
  } catch (error) {
    console.error(`[stream-inquiry] (${authPath}) loader failed:`, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load inquiry thread" },
      { status: 500, headers }
    );
  }
}
