import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

export async function action({ request }: { request: Request }) {
  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const adminClient = createSupabaseAdminClient();

  const body = (await request.json()) as { invoice_id: string };
  const { invoice_id } = body;

  const { error } = await adminClient
    .from("invoices")
    .update({ status: "void" })
    .eq("id", invoice_id)
    .eq("issuer_profile_id", profile.id as string);

  if (error) {
    console.error("[invoices/void] update error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
