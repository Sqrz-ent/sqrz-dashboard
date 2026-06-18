import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
};

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function defaultInvoiceLine(netAmount: number): InvoiceLineItem[] {
  if (netAmount <= 0) return [];
  return [{
    description: "Professional Services",
    quantity: 1,
    unit_price: netAmount,
    amount: netAmount,
  }];
}

function normalizeLineItems(raw: unknown, netAmount: number): InvoiceLineItem[] {
  if (!Array.isArray(raw)) return defaultInvoiceLine(netAmount);

  const normalized = raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const record = item as Record<string, unknown>;
      const description =
        (typeof record.description === "string" && record.description.trim()) ||
        (typeof record.label === "string" && record.label.trim()) ||
        "Service item";

      const quantity = Math.max(1, toNumber(record.quantity) || 1);
      const directUnitPrice = toNumber(record.unit_price);
      const directAmount = toNumber(record.amount);

      let unitPrice = directUnitPrice;
      let amount = quantity * directUnitPrice;

      if (directAmount > 0) {
        amount = directAmount;
        if (unitPrice <= 0) {
          unitPrice = amount / quantity;
        }
      }

      if (amount <= 0 && unitPrice > 0) {
        amount = quantity * unitPrice;
      }

      if (amount <= 0 && unitPrice <= 0) {
        return null;
      }

      return {
        description,
        quantity,
        unit_price: roundCurrency(unitPrice),
        amount: roundCurrency(amount),
      } satisfies InvoiceLineItem;
    })
    .filter((item): item is InvoiceLineItem => item !== null);

  if (normalized.length === 0) return defaultInvoiceLine(netAmount);

  const normalizedTotal = roundCurrency(normalized.reduce((sum, item) => sum + item.amount, 0));
  const remainder = roundCurrency(netAmount - normalizedTotal);

  if (Math.abs(remainder) <= 0.01) return normalized;
  if (remainder < 0) return defaultInvoiceLine(netAmount);

  return [
    {
      description: "Professional Services",
      quantity: 1,
      unit_price: remainder,
      amount: remainder,
    },
    ...normalized,
  ];
}

async function buildInvoicePDF(invoice: Record<string, unknown>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const { width, height } = page.getSize();

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.05, 0.05, 0.05);
  const gray = rgb(0.45, 0.45, 0.45);
  const lightGray = rgb(0.85, 0.85, 0.85);
  const accent = rgb(0.0, 0.0, 0.0);

  const margin = 56;
  let y = height - margin;

  page.drawText("SQRZ", {
    x: width - margin - 60,
    y,
    size: 18,
    font: fontBold,
    color: accent,
  });

  page.drawText("INVOICE", {
    x: margin,
    y,
    size: 22,
    font: fontBold,
    color: black,
  });

  y -= 28;

  page.drawText(`No. ${invoice.invoice_number}`, {
    x: margin,
    y,
    size: 10,
    font: fontRegular,
    color: gray,
  });

  page.drawText(`Date: ${formatDate(invoice.invoice_date as string)}`, {
    x: width - margin - 130,
    y,
    size: 10,
    font: fontRegular,
    color: gray,
  });

  if (invoice.due_date) {
    y -= 14;
    page.drawText(`Due: ${formatDate(invoice.due_date as string)}`, {
      x: width - margin - 130,
      y,
      size: 10,
      font: fontRegular,
      color: gray,
    });
  }

  y -= 36;

  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: lightGray,
  });

  y -= 28;

  const colFrom = margin;
  const colTo = width / 2 + 10;

  page.drawText("FROM", { x: colFrom, y, size: 8, font: fontBold, color: gray });
  page.drawText("TO", { x: colTo, y, size: 8, font: fontBold, color: gray });

  y -= 16;

  const issuerLines = [
    invoice.issuer_name as string,
    invoice.issuer_legal_form as string ?? "",
    invoice.issuer_address as string ?? "",
    invoice.issuer_city as string ?? "",
    invoice.issuer_country as string ?? "",
    invoice.issuer_vat_id ? `VAT ID: ${invoice.issuer_vat_id}` : "",
    invoice.issuer_tax_id ? `Tax ID: ${invoice.issuer_tax_id}` : "",
    invoice.issuer_email as string ?? "",
  ].filter(Boolean);

  const recipientLines = [
    invoice.recipient_name as string,
    invoice.recipient_address as string ?? "",
    invoice.recipient_city as string ?? "",
    invoice.recipient_country as string ?? "",
    invoice.recipient_vat_id ? `VAT ID: ${invoice.recipient_vat_id}` : "",
    invoice.recipient_email as string ?? "",
  ].filter(Boolean);

  const maxLines = Math.max(issuerLines.length, recipientLines.length);
  for (let i = 0; i < maxLines; i++) {
    const isBold = i === 0;
    if (issuerLines[i]) {
      page.drawText(issuerLines[i], {
        x: colFrom,
        y,
        size: 9,
        font: isBold ? fontBold : fontRegular,
        color: black,
      });
    }
    if (recipientLines[i]) {
      page.drawText(recipientLines[i], {
        x: colTo,
        y,
        size: 9,
        font: isBold ? fontBold : fontRegular,
        color: black,
      });
    }
    y -= 13;
  }

  y -= 24;

  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: lightGray,
  });

  y -= 20;

  const colDesc = margin;
  const colQty = width - margin - 200;
  const colUnit = width - margin - 120;
  const colTotal = width - margin - 40;

  page.drawText("Description", { x: colDesc, y, size: 8, font: fontBold, color: gray });
  page.drawText("Qty", { x: colQty, y, size: 8, font: fontBold, color: gray });
  page.drawText("Unit Price", { x: colUnit, y, size: 8, font: fontBold, color: gray });
  page.drawText("Amount", { x: colTotal, y, size: 8, font: fontBold, color: gray });

  y -= 10;
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.3,
    color: lightGray,
  });
  y -= 14;

  const currency = invoice.currency as string ?? "EUR";
  const net = toNumber(invoice.net_amount);
  const lineItems = normalizeLineItems(invoice.line_items, net);

  for (const item of lineItems) {
    page.drawText(item.description, { x: colDesc, y, size: 9, font: fontRegular, color: black });
    page.drawText(String(item.quantity), { x: colQty, y, size: 9, font: fontRegular, color: black });
    page.drawText(formatCurrency(item.unit_price, currency), { x: colUnit, y, size: 9, font: fontRegular, color: black });
    page.drawText(formatCurrency(item.amount, currency), { x: colTotal, y, size: 9, font: fontRegular, color: black });
    y -= 16;
  }

  y -= 10;

  const totalsX = width - margin - 200;
  const amountX = width - margin - 40;

  const taxPct = toNumber(invoice.tax_pct);
  const taxAmount = toNumber(invoice.tax_amount);
  const gross = toNumber(invoice.gross_amount);

  page.drawLine({
    start: { x: totalsX, y },
    end: { x: width - margin, y },
    thickness: 0.3,
    color: lightGray,
  });
  y -= 14;

  page.drawText("Net amount", { x: totalsX, y, size: 9, font: fontRegular, color: gray });
  page.drawText(formatCurrency(net, currency), { x: amountX, y, size: 9, font: fontRegular, color: black });
  y -= 13;

  if (taxPct > 0) {
    page.drawText(`Tax (${taxPct}%)`, { x: totalsX, y, size: 9, font: fontRegular, color: gray });
    page.drawText(formatCurrency(taxAmount, currency), { x: amountX, y, size: 9, font: fontRegular, color: black });
    y -= 13;
  }

  page.drawLine({
    start: { x: totalsX, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: black,
  });
  y -= 14;

  page.drawText("TOTAL", { x: totalsX, y, size: 10, font: fontBold, color: black });
  page.drawText(formatCurrency(gross, currency), { x: amountX, y, size: 10, font: fontBold, color: black });

  if (invoice.notes) {
    y -= 36;
    page.drawText("Notes", { x: margin, y, size: 8, font: fontBold, color: gray });
    y -= 13;
    page.drawText(invoice.notes as string, { x: margin, y, size: 8, font: fontRegular, color: gray });
  }

  page.drawText(
    "Tax compliance and invoicing are the responsibility of the issuing party. Generated via SQRZ.",
    {
      x: margin,
      y: margin,
      size: 7,
      font: fontRegular,
      color: lightGray,
    },
  );

  return doc.save();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { invoice_id: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { invoice_id } = body;
  if (!invoice_id) {
    return new Response("Missing invoice_id", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: invoice, error: fetchError } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoice_id)
    .single();

  if (fetchError || !invoice) {
    console.error("Invoice fetch error:", fetchError);
    return new Response("Invoice not found", { status: 404 });
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await buildInvoicePDF(invoice);
  } catch (err) {
    console.error("PDF generation error:", err);
    return new Response("PDF generation failed", { status: 500 });
  }

  const filePath = `${invoice.issuer_profile_id}/${invoice.invoice_number}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(filePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error("Storage upload error:", uploadError);
    return new Response("PDF upload failed", { status: 500 });
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from("invoices")
    .createSignedUrl(filePath, 3600);

  if (signedError || !signedData) {
    return new Response("Could not create signed URL", { status: 500 });
  }

  await supabase
    .from("invoices")
    .update({ pdf_url: filePath, status: "sent" })
    .eq("id", invoice_id);

  return new Response(
    JSON.stringify({ ok: true, signed_url: signedData.signedUrl, pdf_url: filePath }),
    { headers: { "Content-Type": "application/json" } },
  );
});
