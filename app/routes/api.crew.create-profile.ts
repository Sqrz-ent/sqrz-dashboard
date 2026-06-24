import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: { request: Request }) {
  console.log("[create-profile] action hit:", request.method, request.url);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const userProfile = await getCurrentProfile(supabase, user.id);
  if (!userProfile?.is_beta) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await request.formData();
  const slug = sanitizeSlug((formData.get("slug") as string) ?? "");
  const name = ((formData.get("name") as string) ?? "").trim() || slug;
  if (!slug) return Response.json({ error: "Slug is required" }, { status: 400 });

  // Use admin client (service role) — profile has no user_id yet, and
  // create_managed_profile also seeds the agent delegation row.
  const admin = createSupabaseAdminClient();

  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    return Response.json({ error: `@${slug} is already taken` }, { status: 409 });
  }

  // Creates the guest profile + seeds the delegation atomically, so the new
  // profile shows up in the agent's roster (get_agent_roster).
  const { data, error: rpcError } = await admin.rpc("create_managed_profile", {
    p_name: name,
    p_slug: slug,
    p_agent_profile_id: "8fc5755f-8e1b-47ce-b971-641860458bd0",
  });

  if (rpcError || !data) {
    return Response.json(
      { error: "Failed to create profile", detail: rpcError?.message ?? "no data returned" },
      { status: 500 }
    );
  }

  // RPC returns { profile_id, slug, claim_token, profile_url, delegated }
  const result = data as {
    profile_id: string;
    slug: string;
    claim_token: string;
    profile_url: string;
    delegated: boolean;
  };

  return Response.json({
    slug: result.slug,
    claim_token: result.claim_token,
    claim_url: `https://${result.slug}.sqrz.com?claim=${result.claim_token}`,
    profile_url: result.profile_url,
  });
}
