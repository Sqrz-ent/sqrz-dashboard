// ─── Plan levels ─────────────────────────────────────────────────────────────
// plan_id null / anything else → level 0 (Free)
// plan_id 1                    → level 1 (Creator)
// plan_id 2 (legacy Boost)     → level 1 (treat as Creator)
//
// Boost is no longer a subscription plan — it's a pay-per-campaign feature
// available to all Creator users. grow_qualified activates the Grow form
// within the Boost panel but is not a plan gate.

export function getPlanLevel(plan_id: number | null | undefined): number {
  if (plan_id === 1) return 1;  // Creator
  if (plan_id === 2) return 1;  // legacy Boost users → treat as Creator
  return 0;                      // Free (null or anything else)
}

// Feature gates: minimum plan level required
export const FEATURE_GATES = {
  domain:   1,  // Creator+
  payments: 1,  // Creator+
  links:    1,  // Creator+
} as const;

export type FeatureKey = keyof typeof FEATURE_GATES;
