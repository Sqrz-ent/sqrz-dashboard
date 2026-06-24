import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getOwnerProfile } from "~/lib/profile.server";
import { isAgent } from "~/lib/agent.server";

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/**
 * POST /api/crew/create-profile
 *
 * Creates a managed talent profile via the create_managed_profile RPC, which
 * atomically creates a guest profile + seeds the active beta delegation linking
 * it to the current user's roster. Returns the claim token + profile URL so it
 * can be sent to the talent.
 */
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve the REAL user (not any acting-as profile) — they own the new roster row.
  const owner = await getOwnerProfile(supabase, user.id);
  if (!owner) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Gate: only managers (active beta delegation) can create managed profiles.
  if (!(await isAgent(owner.id as string))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await request.formData();
  const slug = sanitizeSlug((formData.get("slug") as string) ?? "");
  const name = ((formData.get("name") as string) ?? "").trim() || slug;
  if (!slug) return Response.json({ error: "Slug is required" }, { status: 400 });

  const admin = createSupabaseAdminClient();

  // Pre-check for a friendlier conflict message than the raw unique-violation.
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    return Response.json({ error: `@${slug} is already taken` }, { status: 409 });
  }

  const { data, error } = await admin.rpc("create_managed_profile", {
    p_name: name,
    p_slug: slug,
    p_agent_profile_id: owner.id as string,
  });

  if (error || !data) {
    return Response.json(
      { error: "Failed to create profile", detail: error?.message ?? "no data returned" },
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

  const claimUrl = result.claim_token
    ? `${result.profile_url}?claim=${encodeURIComponent(result.claim_token)}`
    : result.profile_url;

  return Response.json({
    profile_id: result.profile_id,
    name,
    slug: result.slug,
    claim_token: result.claim_token,
    profile_url: result.profile_url,
    claim_url: claimUrl,
    delegated: result.delegated,
  });
}
