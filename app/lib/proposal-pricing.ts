export type ProposalBreakdownLineItem = {
  label: string;
  amount: number;
};

export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function normalizeProposalLineItems(raw: unknown): ProposalBreakdownLineItem[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const amount = Number(record.amount ?? 0);
      if (!label || !Number.isFinite(amount) || amount <= 0) return null;
      return { label, amount: roundCurrency(amount) } satisfies ProposalBreakdownLineItem;
    })
    .filter((item): item is ProposalBreakdownLineItem => item !== null);
}

export function resolveLockedSqrzFeePct(input: {
  requiresPayment: boolean | null | undefined;
  proposalFeePct?: number | null;
  fallbackFeePct?: number | null;
}): number {
  if (!input.requiresPayment) return 0;
  const pct = input.proposalFeePct ?? input.fallbackFeePct ?? 0;
  const normalized = Number(pct);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

export function reconcileInvoiceLineItems(input: {
  netAmount: number | null | undefined;
  rawLineItems: unknown;
  primaryLabel?: string | null;
}): ProposalBreakdownLineItem[] {
  const netAmount = roundCurrency(Number(input.netAmount ?? 0));
  const primaryLabel = input.primaryLabel?.trim() || "Professional services";
  const lineItems = normalizeProposalLineItems(input.rawLineItems);

  if (netAmount <= 0) return lineItems;
  if (lineItems.length === 0) {
    return [{ label: primaryLabel, amount: netAmount }];
  }

  const breakdownTotal = roundCurrency(
    lineItems.reduce((sum, item) => sum + item.amount, 0)
  );
  const remainder = roundCurrency(netAmount - breakdownTotal);

  if (Math.abs(remainder) <= 0.01) return lineItems;
  if (remainder < 0) {
    return [{ label: primaryLabel, amount: netAmount }];
  }

  return [{ label: primaryLabel, amount: remainder }, ...lineItems];
}
