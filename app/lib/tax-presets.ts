// Tax presets live on profiles.tax_presets (JSONB array). Keys are snake_case to match
// the DB convention and stay consistent with the sqrz-ios decoder.
export type TaxPreset = {
  label: string;
  rate: number;
  is_default: boolean;
};

// Coerce arbitrary JSONB into a clean TaxPreset[] — drops malformed/blank entries and
// guarantees at most one default (first default wins).
export function normalizeTaxPresets(raw: unknown): TaxPreset[] {
  if (!Array.isArray(raw)) return [];
  let defaultSeen = false;
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      label: typeof p.label === "string" ? p.label.trim() : "",
      rate: Number(p.rate) || 0,
      is_default: (p.is_default ?? (p as { isDefault?: boolean }).isDefault) === true,
    }))
    .filter((p) => p.label !== "")
    .map((p) => {
      if (p.is_default && defaultSeen) return { ...p, is_default: false };
      if (p.is_default) defaultSeen = true;
      return p;
    });
}
