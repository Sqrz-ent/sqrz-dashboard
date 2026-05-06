import Stripe from "stripe";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import {
  reconcileInvoiceLineItems,
  resolveLockedSqrzFeePct,
  roundCurrency,
} from "~/lib/proposal-pricing";

function deriveIssuerCountry(profile: Record<string, unknown>): string | null {
  const explicitCountry =
    (profile.company_country as string | null) ||
    (profile.location_iso as string | null);
  if (explicitCountry && explicitCountry.trim()) return explicitCountry.trim();

  const address = (profile.company_address as string | null)?.trim();
  if (!address) return null;

  const lastSegment = address.split(",").map((part) => part.trim()).filter(Boolean).pop();
  return lastSegment || null;
}

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
  const booking_id = (formData.get("booking_id") as string) || null;
  // UUID fields — must be valid UUID or null, never empty string
  const proposal_id_raw = (formData.get("proposal_id") as string) || "";
  const proposal_id = proposal_id_raw.match(/^[0-9a-f-]{36}$/i) ? proposal_id_raw : null;
  const invoice_number = (formData.get("invoice_number") as string) || null;
  // Dates — coerce to YYYY-MM-DD
  const rawInvoiceDate = (formData.get("invoice_date") as string) || "";
  const invoice_date = rawInvoiceDate ? rawInvoiceDate.split("T")[0] : new Date().toISOString().split("T")[0];
  const rawDueDate = (formData.get("due_date") as string) || "";
  const due_date = rawDueDate ? rawDueDate.split("T")[0] : null;
  const recipient_name = (formData.get("recipient_name") as string) || "";
  const recipient_email = (formData.get("recipient_email") as string) || null;
  const recipient_address = (formData.get("recipient_address") as string) || null;
  const recipient_city = (formData.get("recipient_city") as string) || null;
  const recipient_country = (formData.get("recipient_country") as string) || null;
  const recipient_vat_id = (formData.get("recipient_vat_id") as string) || null;
  const notes = (formData.get("notes") as string) || null;
  const stripe_payment_intent = (formData.get("stripe_payment_intent") as string) || null;

  console.log("[invoices/create] parsed fields:", JSON.stringify({
    booking_id, proposal_id, invoice_number, invoice_date, due_date,
    recipient_name, recipient_email, recipient_country,
  }));

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
    .select("id, title, service, owner_id")
    .eq("id", booking_id)
    .eq("owner_id", profile.id as string)
    .maybeSingle();

  if (!booking) {
    return Response.json({ error: "Booking not found or unauthorized" }, { status: 404 });
  }

  // Fetch accepted proposal (latest version, status=accepted)
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("id, rate, currency, tax_pct, tax_amount, line_items, requires_payment, sqrz_fee_pct")
    .eq("booking_id", booking_id)
    .eq("status", "accepted")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!proposal) {
    return Response.json({ error: "No accepted proposal found for this booking" }, { status: 404 });
  }

  const lockedFeePct = resolveLockedSqrzFeePct({
    requiresPayment: (proposal as { requires_payment?: boolean | null }).requires_payment,
    proposalFeePct: (proposal as { sqrz_fee_pct?: number | null }).sqrz_fee_pct,
  });
  const sqrzFeeAmount = roundCurrency(Number(proposal.rate) * (lockedFeePct / 100));
  const taxAmt = Number((proposal as { tax_amount?: number | null }).tax_amount ?? 0);
  const gross = roundCurrency(Number(proposal.rate) + taxAmt + sqrzFeeAmount);
  const invoiceLineItems = reconcileInvoiceLineItems({
    netAmount: proposal.rate,
    rawLineItems: proposal.line_items,
    primaryLabel: (booking.service as string | null) || (booking.title as string | null) || "Professional services",
  });

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
      issuer_country: deriveIssuerCountry(profile as Record<string, unknown>),
      issuer_vat_id: (profile.vat_id as string | null) ?? null,
      issuer_tax_id: null,
      issuer_email: (profile.email as string | null) ?? null,
      issuer_legal_form: (profile.legal_form as string | null) ?? null,
      recipient_name,
      recipient_email: recipient_email || null,
      recipient_address: recipient_address || null,
      recipient_city: recipient_city || null,
      recipient_country: recipient_country || null,
      recipient_vat_id: recipient_vat_id || null,
      currency: ((proposal.currency as string | null) ?? "EUR").toUpperCase(),
      net_amount: proposal.rate,
      tax_pct: (proposal.tax_pct as number | null) ?? 0,
      tax_amount: taxAmt,
      sqrz_fee_amount: sqrzFeeAmount,
      gross_amount: gross,
      line_items: invoiceLineItems,
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
    console.error("[invoices/create] insert error FULL:", JSON.stringify(insertError));
    console.error("[invoices/create] insert error code:", insertError?.code);
    console.error("[invoices/create] insert error details:", insertError?.details);
    console.error("[invoices/create] insert error hint:", insertError?.hint);
    console.error("[invoices/create] insert error message:", insertError?.message);
    return Response.json({
      error: insertError?.message ?? "Failed to create invoice",
      details: insertError?.details,
      hint: insertError?.hint,
      code: insertError?.code,
    }, { status: 500 });
  }

  // Call Edge Function to generate PDF
  console.log("[invoices/create] insertedInvoice:", JSON.stringify(insertedInvoice));
  console.log("[invoices/create] invoice_id type:", typeof insertedInvoice.id, "value:", insertedInvoice.id);

  // Re-fetch the row to ensure we have the trigger-updated id
  const { data: confirmedInvoice } = await adminClient
    .from("invoices")
    .select("id, invoice_number")
    .eq("id", insertedInvoice.id)
    .single();

  console.log("[invoices/create] confirmedInvoice:", JSON.stringify(confirmedInvoice));
  const invoiceIdToUse = confirmedInvoice?.id ?? insertedInvoice.id;
  console.log("[invoices/create] calling edge function with invoice_id:", invoiceIdToUse);

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
        body: JSON.stringify({ invoice_id: invoiceIdToUse }),
      }
    );
    const edgeText = await edgeRes.text();
    console.log("[invoices/create] edge function response status:", edgeRes.status, "body:", edgeText);
    const edgeJson = JSON.parse(edgeText) as { ok?: boolean; signed_url?: string; pdf_url?: string; error?: string };
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
