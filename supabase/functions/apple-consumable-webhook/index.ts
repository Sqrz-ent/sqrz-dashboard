// apple-consumable-webhook — handles App Store Server Notifications for
// campaign-activation consumable products (campaign_activation_products),
// as a SIBLING to apple-subscription-webhook rather than a second
// Apple-facing endpoint (Apple only supports one App Store Server
// Notifications V2 URL per app — a true second webhook URL isn't possible).
// apple-subscription-webhook is still the one real Apple-facing URL; it
// verifies the JWS, logs to apple_webhook_events, and FORWARDS the already-
// verified transaction payload here for exactly four notification types —
// see its own file header for the forwarding guard. This function never
// talks to Apple directly and never re-verifies a JWS.
//
// Deployed verify_jwt:true — the only caller is apple-subscription-webhook,
// invoking with the project's own service-role key (a valid signed JWT),
// which the platform's gateway accepts; no separate shared secret needed.
//
// Handles:
//   • REFUND            — marks the matching campaign_activations row
//                          refunded (refunded_at). Does NOT touch the
//                          campaign or Meta — see the file's own report in
//                          the task write-up for how this would need to
//                          surface to Will/the artist (nothing reads
//                          campaign_activations for display yet).
//   • REFUND_DECLINED    — log only, no state change (Apple's own sibling
//                          outcome to REFUND when a refund request is
//                          denied).
//   • CONSUMPTION_REQUEST — log only. Sent BEFORE Apple decides a refund
//                          request, to optionally let us submit consumption
//                          data via Apple's Send Consumption Information
//                          endpoint — not built here, out of scope; flagged
//                          as a future enhancement, not a gap in this pass.
//   • ONE_TIME_CHARGE    — BACKUP activation path. Sent for every consumable
//                          purchase since May 2025 (confirmed current/live,
//                          not assumed). If verify-campaign-activation
//                          already recorded this transaction, this is a
//                          no-op. If not, this can ONLY auto-resolve the
//                          unambiguous case: appAccountToken → profile_id,
//                          the purchased product_id → its matching
//                          campaign_templates row (via iap_product_id —
//                          2026-10-25, a pure-config table Will edits
//                          directly; campaign_activation_products is
//                          deprecated and superseded), then EXACTLY ONE
//                          campaign for that profile in a draft-like status
//                          ('booked'/'needs_changes') matching that template
//                          (campaign_template, or — legacy rows only — the
//                          equivalent goal, see legacyGoalForTemplate).
//                          Zero or multiple matches are logged and left
//                          alone — never guessed. See the task write-up for
//                          why this ambiguity exists (the primary path's
//                          appAccountToken is profile-scoped, not
//                          campaign-scoped, per spec) and a suggested fix.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function appendEventError(eventId: number | undefined, note: string): Promise<void> {
  if (eventId == null) return;
  const { data: row } = await supabase
    .from("apple_webhook_events")
    .select("error")
    .eq("id", eventId)
    .maybeSingle();
  const prior = row?.error ? `${row.error}; ` : "";
  await supabase
    .from("apple_webhook_events")
    .update({ error: `${prior}${note}`.slice(0, 2000) })
    .eq("id", eventId);
}

// goal is deprecated (2026-10-24) — campaigns are defined by
// campaign_template now. This is ONLY the legacy-compat reverse mapping, so
// the candidate query above can also catch a draft campaign that predates
// campaign_template (NULL). 'audience' has no equivalent template (no
// creation path has ever produced it), so there's no reverse case for it —
// an audience-goal legacy row simply can't be auto-resolved here, same as
// today.
function legacyGoalForTemplate(templateId: string): string | null {
  switch (templateId) {
    case "template_01": return "visibility";
    case "template_02": return "bookings";
    default:            return null;
  }
}

type ForwardedBody = {
  notificationType?: string;
  subtype?: string;
  environment?: string;
  transaction?: Record<string, unknown>;
  eventId?: number;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: ForwardedBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const notificationType = body.notificationType ?? "";
  const txn = body.transaction ?? {};
  const environment = body.environment === "production" ? "production" : "sandbox";
  const eventId = body.eventId;

  const transactionId = txn.transactionId != null ? String(txn.transactionId) : null;
  const originalTransactionId = txn.originalTransactionId != null
    ? String(txn.originalTransactionId)
    : null;

  switch (notificationType) {
    case "REFUND": {
      if (!transactionId && !originalTransactionId) {
        await appendEventError(eventId, "REFUND: no transactionId/originalTransactionId in payload");
        return json({ ok: true, skipped: "no_transaction_id" });
      }
      const query = supabase
        .from("campaign_activations")
        .select("id, status")
        .eq("status", "active");
      const { data: activation } = transactionId
        ? await query.eq("transaction_id", transactionId).maybeSingle()
        : await query.eq("original_transaction_id", originalTransactionId!).maybeSingle();

      if (!activation) {
        await appendEventError(
          eventId,
          `REFUND: no active campaign_activations row for transaction ${transactionId ?? originalTransactionId}`,
        );
        return json({ ok: true, skipped: "no_matching_activation" });
      }

      await supabase
        .from("campaign_activations")
        .update({ status: "refunded", refunded_at: new Date().toISOString() })
        .eq("id", activation.id);
      return json({ ok: true, refunded_activation_id: activation.id });
    }

    case "REFUND_DECLINED":
    case "CONSUMPTION_REQUEST":
      // Log-only — see file header.
      return json({ ok: true, logged_only: true });

    case "ONE_TIME_CHARGE": {
      const productId = txn.productId != null ? String(txn.productId) : null;
      const appAccountToken = txn.appAccountToken != null ? String(txn.appAccountToken) : null;
      if (!productId || !transactionId) {
        await appendEventError(eventId, "ONE_TIME_CHARGE: missing productId/transactionId in payload");
        return json({ ok: true, skipped: "missing_fields" });
      }

      // Already recorded by the primary (client-initiated) path — no-op.
      const { data: existingActivation } = await supabase
        .from("campaign_activations")
        .select("id")
        .eq("transaction_id", transactionId)
        .maybeSingle();
      if (existingActivation) {
        return json({ ok: true, skipped: "already_recorded" });
      }

      if (!appAccountToken) {
        await appendEventError(eventId, "ONE_TIME_CHARGE: no appAccountToken — cannot resolve profile");
        return json({ ok: true, skipped: "no_app_account_token" });
      }

      // 2026-10-24: keyed on template id, not goal — goal is deprecated.
      // 2026-10-25: resolved via campaign_templates.iap_product_id (a
      // pure-config row Will edits directly) instead of
      // campaign_activation_products, which is deprecated and superseded.
      const { data: template } = await supabase
        .from("campaign_templates")
        .select("id")
        .eq("iap_product_id", productId)
        .maybeSingle();
      if (!template) {
        await appendEventError(eventId, `ONE_TIME_CHARGE: product ${productId} has no campaign_templates mapping`);
        return json({ ok: true, skipped: "unmapped_product" });
      }
      const templateId = template.id as string;

      // Candidates match EITHER a real campaign_template (new rows) OR —
      // only because campaign_template is a recent column — a legacy row
      // that still has campaign_template NULL but the equivalent goal, so
      // an in-flight purchase against an old draft isn't missed just
      // because this pass shipped mid-flight. legacyGoalForTemplate is the
      // ONLY place goal is read in this function now.
      const legacyGoal = legacyGoalForTemplate(templateId);
      const candidatesQuery = supabase
        .from("boost_campaigns")
        .select("id")
        .eq("profile_id", appAccountToken)
        .in("status", ["booked", "needs_changes"]);
      const { data: candidates } = await (legacyGoal
        ? candidatesQuery.or(`campaign_template.eq.${templateId},and(campaign_template.is.null,goal.eq.${legacyGoal})`)
        : candidatesQuery.eq("campaign_template", templateId));

      if (!candidates || candidates.length !== 1) {
        await appendEventError(
          eventId,
          `ONE_TIME_CHARGE: cannot auto-resolve campaign for profile ${appAccountToken} / template ${templateId} — ${candidates?.length ?? 0} draft-like candidate(s), needs manual reconciliation`,
        );
        return json({ ok: true, skipped: "ambiguous_campaign", candidate_count: candidates?.length ?? 0 });
      }

      const campaignId = candidates[0].id as string;
      const purchasedAt = txn.purchaseDate != null
        ? new Date(Number(txn.purchaseDate)).toISOString()
        : new Date().toISOString();

      try {
        const { data: result, error } = await supabase.rpc("record_campaign_activation", {
          p_campaign_id: campaignId,
          p_profile_id: appAccountToken,
          p_product_id: productId,
          p_transaction_id: transactionId,
          p_original_transaction_id: originalTransactionId,
          p_environment: environment,
          p_price: txn.price != null ? Number(txn.price) : null,
          p_currency: txn.currency != null ? String(txn.currency) : null,
          p_purchased_at: purchasedAt,
        });
        if (error) throw error;
        return json({ ok: true, backup_path: true, ...result });
      } catch (err) {
        // A 23505 here means verify-campaign-activation won the race in the
        // meantime — harmless, already handled.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("23505") || msg.includes("duplicate key")) {
          return json({ ok: true, skipped: "already_used_race" });
        }
        await appendEventError(eventId, `ONE_TIME_CHARGE: record_campaign_activation failed: ${msg}`);
        return json({ ok: false, error: msg }, 500);
      }
    }

    default:
      return json({ ok: true, skipped: "unhandled_type" });
  }
});
