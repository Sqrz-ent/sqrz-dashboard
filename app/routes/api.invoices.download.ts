import { createSupabaseServerClient, createSupabaseAdminClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

export async function action({ request }: { request: Request }) {
  // Native callers (sqrz-ios) authenticate with a Bearer access token; the browser flow
  // uses cookies. Both paths return JSON — this route never redirects.
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let supabase;
  let user;
  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({
      data: { user },
    } = await supabase.auth.getUser(bearerToken));
  } else {
    ({ supabase } = createSupabaseServerClient(request));
    ({
      data: { user },
    } = await supabase.auth.getUser());
  }
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const adminClient = createSupabaseAdminClient();

  const body = (await request.json()) as { invoice_id: string };
  const { invoice_id } = body;

  const { data: invoice, error: fetchError } = await adminClient
    .from("invoices")
    .select("id, pdf_source, pdf_url, invoice_number")
    .eq("id", invoice_id)
    .eq("issuer_profile_id", profile.id as string)
    .maybeSingle();

  if (fetchError || !invoice) {
    return Response.json({ error: "Invoice not found or unauthorized" }, { status: 404 });
  }

  let signed_url: string | null = null;

  if (invoice.pdf_source === "uploaded" && invoice.pdf_url) {
    // Create fresh signed URL from storage
    const { data: signedData, error: signedError } = await adminClient.storage
      .from("invoices")
      .createSignedUrl(invoice.pdf_url as string, 3600);
    if (signedError || !signedData?.signedUrl) {
      console.error("[invoices/download] signed URL error:", signedError);
      return Response.json({ error: "Failed to generate download link" }, { status: 500 });
    }
    signed_url = signedData.signedUrl;
  }

  return Response.json({ signed_url });
}
