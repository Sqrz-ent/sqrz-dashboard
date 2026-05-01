import { redirect } from "react-router";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

export async function loader({ request, params }: { request: Request; params: { linkId: string } }) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const linkId = params.linkId;
  const admin = createSupabaseAdminClient();

  // Verify ownership
  const { data: link } = await admin
    .from("private_booking_links")
    .select("id")
    .eq("id", linkId)
    .eq("profile_id", profile.id as string)
    .single();

  if (!link) return new Response("Not found", { status: 404 });

  const { data: leads } = await admin
    .from("link_leads")
    .select("email, collected_at")
    .eq("link_id", linkId)
    .order("collected_at", { ascending: false });

  const rows = (leads ?? [])
    .map((r) => `"${String(r.email).replace(/"/g, '""')}","${r.collected_at}"`)
    .join("\n");

  const csv = `email,collected_at\n${rows}`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="leads-${linkId}.csv"`,
    },
  });
}
