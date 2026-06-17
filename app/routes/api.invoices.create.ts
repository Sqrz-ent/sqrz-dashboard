import { createSupabaseServerClient, createSupabaseAdminClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import {
  reconcileInvoiceLineItems,
  resolveLockedSqrzFeePct,
  roundCurrency,
} from "~/lib/proposal-pricing";

const COUNTRY_LABEL_BY_CODE: Record<string, string> = {
  AR: "Argentina",
  AT: "Austria",
  AU: "Australia",
  BE: "Belgium",
  BO: "Bolivia",
  BR: "Brazil",
  CA: "Canada",
  CH: "Switzerland",
  CL: "Chile",
  CO: "Colombia",
  CR: "Costa Rica",
  CZ: "Czech Republic",
  DE: "Germany",
  DK: "Denmark",
  DO: "Dominican Republic",
  EC: "Ecuador",
  ES: "Spain",
  FI: "Finland",
  FR: "France",
  GB: "United Kingdom",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  JP: "Japan",
  KR: "South Korea",
  MX: "Mexico",
  NL: "Netherlands",
  NO: "Norway",
  NZ: "New Zealand",
  PA: "Panama",
  PE: "Peru",
  PL: "Poland",
  PT: "Portugal",
  PY: "Paraguay",
  RO: "Romania",
  SE: "Sweden",
  SG: "Singapore",
  TR: "Turkey",
  US: "United States",
  UY: "Uruguay",
  ZA: "South Africa",
};

function normalizeCountryValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return COUNTRY_LABEL_BY_CODE[trimmed.toUpperCase()] ?? trimmed;
}

function deriveIssuerCountry(profile: Record<string, unknown>): string | null {
  const explicitCountry = normalizeCountryValue(
    (profile.company_country as string | null) ||
    (profile.location_iso as string | null)
  );
  if (explicitCountry) return explicitCountry;

  const address = (profile.company_address as string | null)?.trim();
  if (!address) return null;

  const lastSegment = address.split(",").map((part) => part.trim()).filter(Boolean).pop();
  return normalizeCountryValue(lastSegment);
}

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

  // Content-type-aware body parsing. Native (sqrz-ios) callers send a JSON body with a
  // Bearer token; the browser flow sends multipart FormData. request.formData() throws on
  // a JSON body, so we must branch on the caller. For native, recipient_* are auto-filled
  // from booking_participants after the booking is loaded (see below).
  const isNative = !!bearerToken;

  let booking_id: string | null;
  let proposal_id: string | null = null;
  let invoice_number: string | null = null;
  let invoice_date: string;
  let due_date: string | null = null;
  let recipient_name = "";
  let recipient_email: string | null = null;
  let recipient_address: string | null = null;
  let recipient_city: string | null = null;
  let recipient_country: string | null = null;
  let recipient_vat_id: string | null = null;
  let notes: string | null = null;

  if (isNative) {
    const json = (await request.json()) as { booking_id?: string; notes?: string | null };
    booking_id = json.booking_id ?? null;
    notes = json.notes ?? null;
    invoice_date = new Date().toISOString().split("T")[0];
  } else {
    const formData = await request.formData();
    booking_id = (formData.get("booking_id") as string) || null;
    // UUID fields — must be valid UUID or null, never empty string
    const proposal_id_raw = (formData.get("proposal_id") as string) || "";
    proposal_id = proposal_id_raw.match(/^[0-9a-f-]{36}$/i) ? proposal_id_raw : null;
    invoice_number = (formData.get("invoice_number") as string) || null;
    // Dates — coerce to YYYY-MM-DD
    const rawInvoiceDate = (formData.get("invoice_date") as string) || "";
    invoice_date = rawInvoiceDate ? rawInvoiceDate.split("T")[0] : new Date().toISOString().split("T")[0];
    const rawDueDate = (formData.get("due_date") as string) || "";
    due_date = rawDueDate ? rawDueDate.split("T")[0] : null;
    recipient_name = (formData.get("recipient_name") as string) || "";
    recipient_email = (formData.get("recipient_email") as string) || null;
    recipient_address = (formData.get("recipient_address") as string) || null;
    recipient_city = (formData.get("recipient_city") as string) || null;
    recipient_country = (formData.get("recipient_country") as string) || null;
    recipient_vat_id = (formData.get("recipient_vat_id") as string) || null;
    notes = (formData.get("notes") as string) || null;
  }

  console.log("[invoices/create] parsed fields:", JSON.stringify({
    booking_id, proposal_id, invoice_number, invoice_date, due_date,
    recipient_name, recipient_email, recipient_country,
  }));

  const planId = (profile.plan_id as number | null) ?? null;

  // Fetch booking owned by this profile
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, title, service, owner_id, status")
    .eq("id", booking_id)
    .eq("owner_id", profile.id as string)
    .maybeSingle();

  if (!booking) {
    return Response.json({ error: "Booking not found or unauthorized" }, { status: 404 });
  }

  // Native callers send no recipient fields — derive them from the buyer participant
  // (billing details preferred, falling back to name/email). Web keeps its form prefill.
  if (isNative) {
    const { data: participant } = await adminClient
      .from("booking_participants")
      .select("name, email, billing_company, billing_address, billing_city, billing_country, billing_vat_id, billing_confirmed")
      .eq("booking_id", booking_id)
      .eq("role", "buyer")
      .limit(1)
      .maybeSingle();

    recipient_name = (participant?.billing_company as string | null) || (participant?.name as string | null) || "";
    recipient_email = (participant?.email as string | null) || "";
    recipient_address = (participant?.billing_address as string | null) || null;
    recipient_city = (participant?.billing_city as string | null) || null;
    recipient_country = (participant?.billing_country as string | null) || null;
    recipient_vat_id = (participant?.billing_vat_id as string | null) || null;
  }

  // Fetch the wallet (+ allocations). When a wallet exists it is the source of truth for
  // amounts and line items; the accepted proposal is only a fallback (instant pre-wallet
  // bookings, edge cases).
  const { data: wallet } = await adminClient
    .from("booking_wallets")
    .select("*, wallet_allocations(*)")
    .eq("booking_id", booking_id)
    .maybeSingle();

  // Fetch accepted proposal (latest version) — fallback source + consolidated line items.
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("id, rate, currency, tax_pct, tax_amount, line_items, requires_payment, sqrz_fee_pct")
    .eq("booking_id", booking_id)
    .eq("status", "accepted")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!wallet && !proposal) {
    return Response.json({ error: "No accepted proposal found for this booking" }, { status: 404 });
  }

  // GATE: once a wallet exists, an invoice may only be generated after the booking has
  // been delivered (wallet payout approved, or booking completed). No gate without a wallet.
  if (wallet) {
    const payoutStatus = (wallet as { payout_status?: string | null }).payout_status;
    if (payoutStatus !== "approved" && (booking.status as string) !== "completed") {
      return Response.json(
        { error: "Invoice can only be generated after marking the booking as delivered" },
        { status: 400 }
      );
    }
  }

  const primaryLabel =
    (booking.service as string | null) || (booking.title as string | null) || "Professional services";

  // Computed invoice amounts + line items — wallet-first, proposal fallback.
  let currency: string;
  let netAmount: number;
  let taxPct: number;
  let taxAmt: number;
  let sqrzFeeAmount: number;
  let gross: number;
  let invoiceLineItems: Array<Record<string, unknown>>;

  if (wallet) {
    const w = wallet as {
      secured_amount?: number | string | null;
      total_budget?: number | string | null;
      tax_pct?: number | string | null;
      tax_amount?: number | string | null;
      sqrz_fee_pct?: number | string | null;
      currency?: string | null;
      invoice_mode?: string | null;
      wallet_allocations?: Array<{
        label?: string | null;
        amount?: number | string | null;
        allocation_type?: string | null;
        billable_to_client?: boolean | null;
        show_amount?: boolean | null;
      }> | null;
    };

    currency = ((w.currency as string | null) ?? (proposal?.currency as string | null) ?? "EUR").toUpperCase();
    netAmount = Number(w.secured_amount ?? 0);
    taxPct = Number(w.tax_pct ?? 0);
    taxAmt = Number(w.tax_amount ?? 0);
    const feePct = Number(w.sqrz_fee_pct ?? 0);
    sqrzFeeAmount = roundCurrency(netAmount * (feePct / 100));
    gross =
      w.total_budget != null
        ? Number(w.total_budget)
        : roundCurrency(netAmount + taxAmt + sqrzFeeAmount);

    const invoiceMode = (w.invoice_mode as string | null) ?? "consolidated";
    if (invoiceMode === "itemized") {
      // Only client-billable allocations; honor the per-line privacy flag (show_amount).
      // crew/promo default to billable_to_client=false, so they're already excluded.
      invoiceLineItems = (w.wallet_allocations ?? [])
        .filter((a) => a.billable_to_client === true)
        .map((a) => ({
          label: a.show_amount ? (a.label ?? "Item") : `${a.label ?? "Item"} (amount withheld)`,
          amount: a.show_amount ? Number(a.amount ?? 0) : 0,
          allocation_type: a.allocation_type ?? null,
        }));
    } else {
      // Consolidated: existing proposal line-item logic, against the wallet net.
      invoiceLineItems = reconcileInvoiceLineItems({
        netAmount,
        rawLineItems: proposal?.line_items,
        primaryLabel,
      });
    }
  } else {
    // Fallback — proposal-based (existing logic, unchanged).
    const p = proposal as NonNullable<typeof proposal>;
    const lockedFeePct = resolveLockedSqrzFeePct({
      requiresPayment: (p as { requires_payment?: boolean | null }).requires_payment,
      proposalFeePct: (p as { sqrz_fee_pct?: number | null }).sqrz_fee_pct,
    });
    currency = ((p.currency as string | null) ?? "EUR").toUpperCase();
    netAmount = Number(p.rate);
    taxPct = (p.tax_pct as number | null) ?? 0;
    taxAmt = Number((p as { tax_amount?: number | null }).tax_amount ?? 0);
    sqrzFeeAmount = roundCurrency(Number(p.rate) * (lockedFeePct / 100));
    gross = roundCurrency(Number(p.rate) + taxAmt + sqrzFeeAmount);
    invoiceLineItems = reconcileInvoiceLineItems({
      netAmount: p.rate,
      rawLineItems: p.line_items,
      primaryLabel,
    });
  }

  const proposalIdForInsert = proposal_id || (proposal?.id as string | undefined) || null;

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
      proposal_id: proposalIdForInsert,
      issuer_profile_id: profile.id as string,
      invoice_number: invoice_number || null,
      invoice_date,
      due_date: due_date || null,
      issuer_name: issuerName,
      issuer_address: (profile.company_address as string | null) ?? null,
      issuer_city: null,
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
      currency,
      net_amount: netAmount,
      tax_pct: taxPct,
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
