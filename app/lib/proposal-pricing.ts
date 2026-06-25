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

export function resolveLockedSqrzFeePct(_input: {
  requiresPayment: boolean | null | undefined;
  proposalFeePct?: number | null;
  fallbackFeePct?: number | null;
}): number {
  // SQRZ fee has been removed from the product — always 0. The function is kept
  // (called in many places) and the DB columns remain, but no fee is ever charged.
  return 0;
}
