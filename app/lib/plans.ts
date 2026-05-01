// ─── Plan levels ─────────────────────────────────────────────────────────────
// plan_id null / anything else → level 0 (Free)
// plan_id 1                    → level 1 (Creator)
// plan_id 2                    → level 2 (Boost)
//
// is_beta and grow_qualified activate features within the Boost panel
// but do NOT bypass plan requirements — not passed to getPlanLevel.

export function getPlanLevel(plan_id: number | null | undefined): number {
  if (plan_id === 2) return 2;  // Boost
  if (plan_id === 1) return 1;  // Creator
  return 0;                      // Free (null or anything else)
}

// Feature gates: minimum plan level required
export const FEATURE_GATES = {
  domain:   1,  // Creator+
  payments: 1,  // Creator+
  links:    1,  // Creator+
  boost:    2,  // Boost+
} as const;

export type FeatureKey = keyof typeof FEATURE_GATES;
