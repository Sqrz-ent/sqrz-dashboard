import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  createSupabaseBearerClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { canManageBookingBilling } from "~/lib/delegate.server";
import { getStripeClient } from "~/lib/stripe-mode.server";

// Upload a seller-provided PDF invoice and send it to the buyer. Two CTAs share this route:
//   "Send Invoice"                — uploads + emails the PDF to the buyer
//   "Send Invoice + Payment Link" — same, plus generates a Stripe payment link (stored on
//                                   wallet_allocations.stripe_payment_link_url) included in
//                                   the email. No SQRZ platform fee on this link — plain
//                                   Checkout to the seller (mirrors wallet_request_payment).
// Access is gated to the booking owner OR an active agent delegate (profile_delegates).
// Web callers authenticate via cookie session; native (sqrz-ios) callers send a Bearer token.
export async function action({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let supabase;
  let user;
  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
  } else {
    ({ supabase } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
  }
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const viewerProfile = await getCurrentProfile(supabase, user.id);
  if (!viewerProfile) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const adminClient = createSupabaseAdminClient();

  const formData = await request.formData();
  const booking_id = (formData.get("booking_id") as string) || null;
  const invoice_number = (formData.get("invoice_number") as string) || null;
  const invoice_date =
    (formData.get("invoice_date") as string) ||
    new Date().toISOString().split("T")[0];
  const recipientNameInput = ((formData.get("recipient_name") as string) || "").trim();
  const withPaymentLink = formData.get("with_payment_link") === "true";
  const pdf = formData.get("pdf") as File | null;

  if (!booking_id) {
    return Response.json({ error: "Missing booking_id" }, { status: 400 });
  }
  if (!pdf) {
    return Response.json({ error: "No PDF file provided" }, { status: 400 });
  }
  if (pdf.size > 5 * 1024 * 1024) {
    return Response.json({ error: "PDF exceeds 5 MB limit" }, { status: 400 });
  }

  // Resolve the booking + owner. The invoice is always issued by the booking owner (the
  // seller), even when an agent delegate performs the action.
  const { data: booking } = await adminClient
    .from("bookings")
    .select("id, title, owner_id, status")
    .eq("id", booking_id)
    .maybeSingle();

  if (!booking) {
    return Response.json({ error: "Booking not found" }, { status: 404 });
  }

  const ownerProfileId = booking.owner_id as string;

  // Gate: owner or active delegate, and only on confirmed/completed bookings.
  const allowed = await canManageBookingBilling(adminClient, viewerProfile.id as string, ownerProfileId);
  if (!allowed) {
    return Response.json({ error: "Not authorized for this booking" }, { status: 403 });
  }
  if (!["confirmed", "completed"].includes(booking.status as string)) {
    return Response.json({ error: "Invoice can only be sent on a confirmed booking" }, { status: 400 });
  }

  // Issuer fields come from the OWNER profile (the seller), not the acting user.
  const { data: ownerProfile } = await adminClient
    .from("profiles")
    .select("company_name, first_name, last_name, name, company_address, vat_id, legal_form, email")
    .eq("id", ownerProfileId)
    .maybeSingle();

  const issuerName = (
    (ownerProfile?.company_name as string | null) ||
    `${(ownerProfile?.first_name as string | null) ?? ""} ${(ownerProfile?.last_name as string | null) ?? ""}`.trim() ||
    (ownerProfile?.name as string | null) ||
    "Unknown"
  );

  // Buyer participant — recipient for the invoice + email.
  const { data: buyer } = await adminClient
    .from("booking_participants")
    .select("email, name, invite_token, billing_company")
    .eq("booking_id", booking_id)
    .eq("role", "buyer")
    .maybeSingle();

  const recipientName =
    recipientNameInput ||
    (buyer?.billing_company as string | null) || (buyer?.name as string | null) || "";

  // Upload PDF to Supabase Storage.
  const storagePath = `${ownerProfileId}/${Date.now()}.pdf`;
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

  // INSERT invoice record.
  const { data: insertedInvoice, error: insertError } = await adminClient
    .from("invoices")
    .insert({
      invoice_number: invoice_number || null,
      invoice_date,
      booking_id: booking_id || null,
      issuer_profile_id: ownerProfileId,
      issuer_name: issuerName,
      issuer_address: (ownerProfile?.company_address as string | null) ?? null,
      issuer_vat_id: (ownerProfile?.vat_id as string | null) ?? null,
      issuer_email: (ownerProfile?.email as string | null) ?? null,
      issuer_legal_form: (ownerProfile?.legal_form as string | null) ?? null,
      recipient_name: recipientName,
      recipient_email: (buyer?.email as string | null) ?? null,
      net_amount: 0,
      tax_pct: 0,
      tax_amount: 0,
      sqrz_fee_amount: 0,
      gross_amount: 0,
      line_items: [],
      pdf_source: "uploaded",
      pdf_url: storagePath,
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

  // Signed URL for the PDF (1 hour) — used for the response + email link.
  const { data: signedData, error: signedError } = await adminClient.storage
    .from("invoices")
    .createSignedUrl(storagePath, 3600);

  if (signedError || !signedData?.signedUrl) {
    console.error("[invoices/upload] signed URL error:", signedError);
    return Response.json({ error: "PDF uploaded but could not create download link" }, { status: 500 });
  }
  const pdfUrl = signedData.signedUrl;

  // Optional Stripe payment link — reuses the wallet_allocations.stripe_payment_link_url
  // surface (same as wallet_request_payment). Plain Checkout to the seller, no platform fee.
  let paymentLinkUrl: string | null = null;
  if (withPaymentLink && buyer?.email) {
    try {
      const { data: wallet } = await adminClient
        .from("booking_wallets")
        .select("id, total_budget, secured_amount, currency, stripe_mode")
        .eq("booking_id", booking_id)
        .maybeSingle();

      const currency = ((wallet?.currency as string | null) ?? "EUR").toUpperCase();
      const gross = Number(wallet?.total_budget ?? wallet?.secured_amount ?? 0);
      const stripeMode = (wallet?.stripe_mode as string | null) === "test" ? "test" : "live";

      if (!wallet?.id) {
        paymentLinkUrl = null;
        console.error("[invoices/upload] no wallet for booking, skipping payment link");
      } else if (!(gross > 0)) {
        console.error("[invoices/upload] wallet gross is 0, skipping payment link");
      } else {
        const stripe = getStripeClient(stripeMode);
        if (!stripe) {
          console.error(`[invoices/upload] Stripe ${stripeMode} mode not configured, skipping payment link`);
        } else {
          // One income allocation carries the payable amount + the generated link.
          const { data: allocation } = await adminClient
            .from("wallet_allocations")
            .insert({
              wallet_id: wallet.id,
              allocation_type: "income",
              label: "Invoice payment",
              role: "Invoice payment",
              amount: gross,
              currency,
              status: "pending",
              billable_to_client: true,
            })
            .select("id")
            .single();

          const session = await stripe.checkout.sessions.create({
            mode: "payment",
            line_items: [{
              price_data: {
                currency: currency.toLowerCase(),
                unit_amount: Math.round(gross * 100),
                product_data: { name: (booking.title as string | null) ?? "Invoice payment" },
              },
              quantity: 1,
            }],
            success_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${buyer.invite_token ?? ""}&payment=success`,
            cancel_url: `https://dashboard.sqrz.com/booking/${booking_id}?token=${buyer.invite_token ?? ""}`,
            customer_email: buyer.email,
            metadata: {
              booking_id,
              wallet_allocation_id: allocation?.id ?? "",
              invoice_id: insertedInvoice.id,
              booking_type: "allocation_payment",
              stripe_mode: stripeMode,
            },
          });

          paymentLinkUrl = session.url ?? null;

          if (allocation?.id && paymentLinkUrl) {
            await adminClient
              .from("wallet_allocations")
              .update({ stripe_payment_link_url: paymentLinkUrl, stripe_session_id: session.id })
              .eq("id", allocation.id);
          }
        }
      }
    } catch (err) {
      console.error("[invoices/upload] payment link generation failed:", err);
    }
  }

  // Email the buyer the invoice (+ optional payment link).
  if (buyer?.email) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const payBlock = paymentLinkUrl
        ? `<div style="text-align:center;margin:24px 0;">
             <a href="${paymentLinkUrl}" style="background:#F3B130;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">Pay now →</a>
           </div>`
        : "";
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: buyer.email,
        subject: `Invoice from ${issuerName}${invoice_number ? ` — ${invoice_number}` : ""}`,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#0a0a0a;padding:32px;text-align:center;"><img src="https://sqrz.com/brand/sqrz_logo.png" alt="SQRZ" style="height:32px;" /></div>
    <div style="padding:32px;">
      <p style="color:#666;font-size:14px;margin:0 0 8px;">Hi ${buyer.name ?? "there"},</p>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 20px;color:#0a0a0a;">${issuerName} sent you an invoice</h1>
      <p style="font-size:14px;color:#0a0a0a;margin:0 0 20px;line-height:1.6;">Your invoice for <strong>${(booking.title as string | null) ?? "your booking"}</strong> is attached below.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${pdfUrl}" style="background:${paymentLinkUrl ? "#f0f0f0" : "#F3B130"};color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">Download Invoice (PDF) →</a>
      </div>
      ${payBlock}
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eee;text-align:center;"><p style="color:#ccc;font-size:11px;margin:0;">Powered by <a href="https://sqrz.com" style="color:#F3B130;text-decoration:none;">SQRZ</a></p></div>
  </div>
</body></html>`,
      });
    } catch (err) {
      console.error("[invoices/upload] email send failed:", err);
    }
  }

  return Response.json({
    signed_url: pdfUrl,
    invoice_number: insertedInvoice.invoice_number,
    invoice_id: insertedInvoice.id,
    payment_link_url: paymentLinkUrl,
  });
}
