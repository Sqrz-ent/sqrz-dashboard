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

  const formData = await request.formData();
  const booking_id = (formData.get("booking_id") as string) || null;
  const invoice_number = (formData.get("invoice_number") as string) || null;
  const invoice_date =
    (formData.get("invoice_date") as string) ||
    new Date().toISOString().split("T")[0];
  const recipient_name = (formData.get("recipient_name") as string) || "";
  const pdf = formData.get("pdf") as File | null;

  if (!pdf) {
    return Response.json({ error: "No PDF file provided" }, { status: 400 });
  }
  if (pdf.size > 5 * 1024 * 1024) {
    return Response.json({ error: "PDF exceeds 5 MB limit" }, { status: 400 });
  }

  // Upload to Supabase Storage
  const storagePath = `${profile.id as string}/${Date.now()}.pdf`;
  const fileBuffer = await pdf.arrayBuffer();

  const { error: uploadError } = await adminClient.storage
    .from("invoices")
    .upload(storagePath, fileBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error("[invoices/upload] storage error:", uploadError);
    return Response.json({ error: uploadError.message }, { status: 500 });
  }

  const issuerName = (
    (profile.company_name as string | null) ||
    `${(profile.first_name as string | null) ?? ""} ${(profile.last_name as string | null) ?? ""}`.trim() ||
    (profile.name as string | null) ||
    "Unknown"
  );

  // INSERT invoice record
  const { data: insertedInvoice, error: insertError } = await adminClient
    .from("invoices")
    .insert({
      invoice_number: invoice_number || null,
      invoice_date,
      booking_id: booking_id || null,
      issuer_profile_id: profile.id as string,
      issuer_name: issuerName,
      recipient_name,
      net_amount: 0,
      tax_pct: 0,
      tax_amount: 0,
      sqrz_fee_amount: 0,
      gross_amount: 0,
      line_items: [],
      pdf_source: "uploaded",
      pdf_url: storagePath,
      invoice_fee_paid: true,
      status: "sent",
      invoice_type: "manual",
      currency: "EUR",
    })
    .select("id, invoice_number")
    .single();

  if (insertError || !insertedInvoice) {
    console.error("[invoices/upload] insert error:", insertError);
    return Response.json({ error: insertError?.message ?? "Failed to create invoice record" }, { status: 500 });
  }

  // Create signed URL (1 hour)
  const { data: signedData, error: signedError } = await adminClient.storage
    .from("invoices")
    .createSignedUrl(storagePath, 3600);

  if (signedError || !signedData?.signedUrl) {
    console.error("[invoices/upload] signed URL error:", signedError);
    return Response.json({ error: "PDF uploaded but could not create download link" }, { status: 500 });
  }

  return Response.json({
    signed_url: signedData.signedUrl,
    invoice_number: insertedInvoice.invoice_number,
    invoice_id: insertedInvoice.id,
  });
}
