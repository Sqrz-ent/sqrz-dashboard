// ─── Plan levels ─────────────────────────────────────────────────────────────
// plan_id null/0  → level 0 (free)
// plan_id 1, 4   → level 1 (Creator / Early Access)
// plan_id 5      → level 2 (Boost)
// plan_id 2, 3   → level 3 (Grow / Grow Pro)
// is_beta true   → level 2 (Boost access regardless of plan_id)

export function getPlanLevel(planId: number | null | undefined, isBeta?: boolean): number {
  if (isBeta) return 2;
  if (!planId) return 0;
  if (planId === 1 || planId === 4) return 1;
  if (planId === 5) return 2;
  if (planId === 2 || planId === 3) return 3;
  return 0;
}

// Feature gates: required level to access each feature
export const FEATURE_GATES = {
  domain:  1,  // any paid plan
  boost:   2,  // Boost or higher
  links:   2,  // Boost or higher
} as const;

export type FeatureKey = keyof typeof FEATURE_GATES;
