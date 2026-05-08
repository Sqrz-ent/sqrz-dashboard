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

  const { data: tokenData, error: tokenError } = await admin.rpc("generate_claim_token", {
    p_slug: slug,
  });

  if (tokenError || !tokenData) {
    return Response.json(
      { error: "Failed to generate claim token", detail: tokenError?.message ?? "no data returned" },
      { status: 500 }
    );
  }

  const claim_token = tokenData as string;

  const { error: updateError } = await admin
    .from("profiles")
    .update({ claim_token })
    .eq("id", profileId);

  if (updateError) {
    return Response.json(
      { error: "Failed to save claim token", detail: updateError.message },
      { status: 500 }
    );
  }

  return Response.json({
    slug,
    claim_token,
    claim_url: `https://${slug}.sqrz.com?claim=${claim_token}`,
  });
}
