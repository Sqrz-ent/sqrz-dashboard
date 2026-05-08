import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export async function action({ request }: { request: Request }) {
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
  if (!slug) return Response.json({ error: "Slug is required" }, { status: 400 });

  // Use admin client for all DB ops — profile has no user_id yet
  const admin = createSupabaseAdminClient();

  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    return Response.json({ error: `@${slug} is already taken` }, { status: 409 });
  }

  const profileId = crypto.randomUUID();

  const { error: insertError } = await admin.from("profiles").insert({
    id: profileId,
    slug,
    user_type: "member",
    is_published: false,
    is_claimed: false,
    template_id: "midnight",
  });

  if (insertError) {
    return Response.json(
      { error: "Failed to create profile", detail: insertError.message },
      { status: 500 }
    );
  }

  // claim_token is set by the set_claim_token DB trigger on INSERT — read it back
  const { data: row, error: selectError } = await admin
    .from("profiles")
    .select("claim_token")
    .eq("id", profileId)
    .single();

  if (selectError || !row?.claim_token) {
    return Response.json(
      { error: "Profile created but claim token not found", detail: selectError?.message ?? "claim_token is null" },
      { status: 500 }
    );
  }

  return Response.json({
    slug,
    claim_token: row.claim_token,
    claim_url: `https://${slug}.sqrz.com?claim=${row.claim_token}`,
  });
}
