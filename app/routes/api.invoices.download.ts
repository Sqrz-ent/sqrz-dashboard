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

  if (invoice.pdf_source === "generated") {
    // Re-call the Edge Function to get a fresh signed URL
    try {
      const edgeRes = await fetch(
        `${process.env.SUPABASE_URL}/functions/v1/generate-invoice`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ invoice_id }),
        }
      );
      const edgeJson = (await edgeRes.json()) as { ok?: boolean; signed_url?: string };
      signed_url = edgeJson.signed_url ?? null;
    } catch (err) {
      console.error("[invoices/download] edge function error:", err);
      return Response.json({ error: "Failed to generate download link" }, { status: 500 });
    }
  } else if (invoice.pdf_source === "uploaded" && invoice.pdf_url) {
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
