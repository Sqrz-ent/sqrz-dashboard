import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { listOpenInquiryThreadsForProfile } from "~/lib/messaging/inquiry.server";

// Native app clients (sqrz-ios) authenticate with Authorization: Bearer {access_token}
// instead of cookies. The user's JWT is forwarded to PostgREST so RLS applies as usual.
function createSupabaseBearerClient(accessToken: string) {
  return createClient(
    import.meta.env.VITE_SUPABASE_URL as string,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}

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

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, plan_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error(`[stream-inquiry] (${authPath}) profile query failed:`, profileError);
    }

    if (!profile?.id) {
      return Response.json({ error: "Profile not found" }, { status: 404, headers });
    }

    if (profile.plan_id == null || Number(profile.plan_id) <= 0) {
      return Response.json({ threads: [] }, { headers });
    }

    const session = await listOpenInquiryThreadsForProfile(profile.id as string);
    return Response.json(session ?? { threads: [] }, { headers });
  } catch (error) {
    console.error(`[stream-inquiry] (${authPath}) loader failed:`, error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load inquiry thread" },
      { status: 500, headers }
    );
  }
}
