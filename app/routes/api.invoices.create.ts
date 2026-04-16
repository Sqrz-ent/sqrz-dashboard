import Stripe from "stripe";
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

  // Parse multipart form data
  const formData = await request.formData();
  const booking_id = formData.get("booking_id") as string;
  const proposal_id = formData.get("proposal_id") as string | null;
  const invoice_number = (formData.get("invoice_number") as string) || null;
  const invoice_date = formData.get("invoice_date") as string;
  const due_date = (formData.get("due_date") as string) || null;
  const recipient_name = formData.get("recipient_name") as string;
  const recipient_email = (formData.get("recipient_email") as string) || null;
  const recipient_address = (formData.get("recipient_address") as string) || null;
  const recipient_city = (formData.get("recipient_city") as string) || null;
  const recipient_country = (formData.get("recipient_country") as string) || null;
  const recipient_vat_id = (formData.get("recipient_vat_id") as string) || null;
  const notes = (formData.get("notes") as string) || null;
  const stripe_payment_intent = (formData.get("stripe_payment_intent") as string) || null;

  const planId = (profile.plan_id as number | null) ?? null;
  const isPaidUser = planId === 1 || planId === 5;

  // Free user gate: require stripe_payment_intent and verify it succeeded
  if (!isPaidUser) {
    if (!stripe_payment_intent) {
      return Response.json({ error: "Payment required for free plan" }, { status: 402 });
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const pi = await stripe.paymentIntents.retrieve(stripe_payment_intent);
    if (pi.status !== "succeeded") {
      return Response.json({ error: "Payment not completed" }, { status: 402 });
    }
  }

  // Fetch booking owned by this profile
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, title, owner_id")
    .eq("id", booking_id)
    .eq("owner_id", profile.id as string)
    .maybeSingle();

  if (!booking) {
    return Response.json({ error: "Booking not found or unauthorized" }, { status: 404 });
  }

  // Fetch accepted proposal (latest version, status=accepted)
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("id, rate, currency, tax_pct, tax_amount, line_items")
    .eq("booking_id", booking_id)
    .eq("status", "accepted")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!proposal) {
    return Response.json({ error: "No accepted proposal found for this booking" }, { status: 404 });
  }

  // Calculate fee amounts
  const sqrzFeeRate = planId === 5 ? 0.03 : planId === 1 ? 0.05 : 0;
  const sqrzFeeAmount = Number(proposal.rate) * sqrzFeeRate;
  const taxAmt = Number((proposal as { tax_amount?: number | null }).tax_amount ?? 0);
  const gross = Number(proposal.rate) + taxAmt + sqrzFeeAmount;

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
      booking_id,
      proposal_id: proposal_id || proposal.id,
      issuer_profile_id: profile.id as string,
      invoice_number: invoice_number || null,
      invoice_date,
      due_date: due_date || null,
      issuer_name: issuerName,
      issuer_address: (profile.company_address as string | null) ?? null,
      issuer_city: (profile.city as string | null) ?? null,
      issuer_vat_id: (profile.vat_id as string | null) ?? null,
      issuer_tax_id: (profile.company_tax_id as string | null) ?? null,
      issuer_email: (profile.email as string | null) ?? null,
      issuer_legal_form: (profile.legal_form as string | null) ?? null,
      recipient_name,
      recipient_email: recipient_email || null,
      recipient_address: recipient_address || null,
      recipient_city: recipient_city || null,
      recipient_country: recipient_country || null,
      recipient_vat_id: recipient_vat_id || null,
      currency: (proposal.currency as string | null) ?? "EUR",
      net_amount: proposal.rate,
      tax_pct: (proposal.tax_pct as number | null) ?? 0,
      tax_amount: taxAmt,
      sqrz_fee_amount: sqrzFeeAmount,
      gross_amount: gross,
      line_items: (proposal.line_items as unknown[]) ?? [],
      notes: notes || null,
      pdf_source: "generated",
      status: "sent",
      invoice_type: "proposal",
      plan_id_at_issuance: planId,
      invoice_fee_paid: true,
      stripe_payment_intent_id: stripe_payment_intent || null,
    })
    .select("id, invoice_number")
    .single();

  if (insertError || !insertedInvoice) {
    console.error("[invoices/create] insert error:", insertError);
    return Response.json({ error: insertError?.message ?? "Failed to create invoice" }, { status: 500 });
  }

  // Call Edge Function to generate PDF
  let signed_url: string | null = null;
  try {
    const edgeRes = await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/generate-invoice`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ invoice_id: insertedInvoice.id }),
      }
    );
    const edgeJson = (await edgeRes.json()) as { ok?: boolean; signed_url?: string; pdf_url?: string };
    signed_url = edgeJson.signed_url ?? null;
  } catch (err) {
    console.error("[invoices/create] edge function error:", err);
  }

  return Response.json({
    signed_url,
    invoice_number: insertedInvoice.invoice_number,
    invoice_id: insertedInvoice.id,
  });
}
