// ─────────────────────────────────────────────────────────────────────────────
// _shared/meta-delivery-status.ts (2026-10-22)
//
// Reads a Meta Campaign's REAL status from the Graph API and resolves whether
// it's currently paused — the single source of truth both meta-insights-sync
// (read-only sync, both its cron sweep and user-triggered refresh paths) and
// meta-campaign-toggle (pre-flight check before writing anything) use, so the
// two functions can never drift on what "paused" means.
//
// Fixes the bug where SQRZ's boost_campaigns.is_paused only ever reflected a
// toggle made through meta-campaign-toggle itself — a campaign paused directly
// in Meta Ads Manager (e.g. "Womex") kept is_paused=false and meta_delivery_
// status=null forever, since nothing ever read Meta's side back.
//
// Meta's Campaign object exposes two different status concepts:
//   - `status` — the CONFIGURED state the object was explicitly set to. For a
//     Campaign this is only ever ACTIVE | PAUSED | DELETED | ARCHIVED.
//   - `effective_status` — the REAL, computed delivery state, which can differ
//     from `status` (e.g. status=ACTIVE but effective_status=PENDING_REVIEW
//     while still in review). CAMPAIGN_PAUSED/ADSET_PAUSED normally surface on
//     a child ad/ad set rather than the campaign object itself, but are kept
//     in the map below for completeness/robustness regardless of which level
//     a caller ends up reading.
//
// effective_status is read first and used whenever it maps to a definite
// answer; the configured `status` is only a fallback when effective_status is
// missing or itself unrecognized.
// ─────────────────────────────────────────────────────────────────────────────

export type MetaCampaignStatus = {
  status: string | null;
  effectiveStatus: string | null;
};

export async function fetchMetaCampaignStatus(
  metaCampaignId: string,
  token: string,
  graphVersion: string,
): Promise<MetaCampaignStatus> {
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${metaCampaignId}`);
  url.searchParams.set("fields", "status,effective_status");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) {
    throw new Error(
      `GET ${metaCampaignId} → ${res.status}${err?.message ? ` ${err.message}` : ""}`,
    );
  }
  return {
    status: typeof body.status === "string" ? body.status.toUpperCase() : null,
    effectiveStatus: typeof body.effective_status === "string"
      ? body.effective_status.toUpperCase()
      : null,
  };
}

// Only genuine pause states resolve to a definite boolean. Every other
// effective_status is deliberately `undefined` ("don't know, don't touch") —
// the same conservative convention meta-status-webhook's own STATUS_MAP
// already uses for the unrelated `status` (SQRZ pipeline) column: an ambiguous
// delivery state (in review, disapproved, billing-blocked, deleted, archived,
// delivering-with-issues) isn't "paused" in the deliberate-stop-intending-to-
// resume sense the Pause/Resume button means — guessing either way would just
// make the button lie in a different direction.
//
// Mapping used (reported per the task's own request):
//   ACTIVE                                  -> false (not paused)
//   PAUSED / CAMPAIGN_PAUSED / ADSET_PAUSED  -> true  (paused)
//   WITH_ISSUES                              -> false (still delivering, just flagged)
//   DISAPPROVED                              -> undefined (rejected, not "paused" —
//                                                that's needs_changes territory)
//   PENDING_REVIEW / IN_PROCESS / PREAPPROVED
//     / PENDING_BILLING_INFO / DELETED / ARCHIVED
//                                            -> undefined (lifecycle/terminal
//                                                states unrelated to a
//                                                deliberate pause; "completed"
//                                                has no effective_status of
//                                                its own — SQRZ's own
//                                                `status='completed'` is a
//                                                separate column entirely,
//                                                see maybeStopForBudgetExhaustion
//                                                in meta-insights-sync)
const EFFECTIVE_STATUS_PAUSE_MAP: Record<string, boolean | undefined> = {
  ACTIVE: false,
  PAUSED: true,
  CAMPAIGN_PAUSED: true,
  ADSET_PAUSED: true,
  WITH_ISSUES: false,
  DISAPPROVED: undefined,
  PENDING_REVIEW: undefined,
  IN_PROCESS: undefined,
  PREAPPROVED: undefined,
  PENDING_BILLING_INFO: undefined,
  DELETED: undefined,
  ARCHIVED: undefined,
};

export function resolveIsPaused(s: MetaCampaignStatus): boolean | undefined {
  // `in` (not just truthiness of the looked-up value) — a RECOGNIZED
  // effective_status is authoritative even when its own mapped answer is
  // `undefined` (DISAPPROVED, PENDING_REVIEW, etc. — a deliberate "don't
  // touch", see the map's own comment). Only fall through to the configured-
  // status fallback below when effective_status is missing entirely OR is a
  // value Meta added that this map doesn't know about yet — NOT whenever the
  // known answer happens to be undefined. (A naive `fromEffective !==
  // undefined` check here was a real bug caught in dry-run testing: it
  // conflated "known, deliberately ambiguous" with "unknown", which silently
  // resolved e.g. DISAPPROVED to `false` whenever the campaign's configured
  // status was still ACTIVE — exactly the guess this map exists to avoid.)
  if (s.effectiveStatus && s.effectiveStatus in EFFECTIVE_STATUS_PAUSE_MAP) {
    return EFFECTIVE_STATUS_PAUSE_MAP[s.effectiveStatus];
  }
  // Fallback — effective_status missing, or a genuinely unrecognized future
  // value. Configured `status` only ever takes ACTIVE/PAUSED/DELETED/ARCHIVED
  // for a Campaign; DELETED/ARCHIVED still resolve to undefined here (not a
  // pause, but not confidently "not paused" either).
  if (s.status === "ACTIVE") return false;
  if (s.status === "PAUSED") return true;
  return undefined;
}
