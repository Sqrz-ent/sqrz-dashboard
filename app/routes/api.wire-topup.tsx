import type { Route } from "./+types/api.wire-topup";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { proDeniedResponse } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";
import { effectiveStatus, type WireTransferRow } from "~/components/WireTopupPanel";

// Bank-transfer wallet top-up — WEB user side (docs/wallet/wire-topup.md). No wallet logic lives
// here: it forwards to the wire-topup-create edge function with the signed-in user's own session
// (functions.invoke attaches it), and reads the account's own wire_topups rows through RLS.
//
//   GET  → { options, transfers, banks }   options = wire-topup-create "options" (enabled / min / fee / currencies);
//                                   transfers = pending rows + rows received in the last 7 days only
//                                   (newest first) — cancelled and expired are hidden entirely, and a
//                                   received row drops off the list a week after it was credited.
//   POST { action: "quote", currency, amount_cents } → wire-topup-create "quote" — non-committal,
//         writes nothing. Shows the bank details before the user commits to anything.
//   POST { action: "create", currency, amount_cents } → wire-topup-create "create" → { transfer, bank,
//         card_comparison } — the explicit, committing step.
//   POST { action: "cancel", wire_topup_id } → wire-topup-create "cancel" → { transfer } — only the
//         caller's own pending rows can be cancelled.
//         Both POST forms accept ?profile_id= to select the active profile (same convention as
//         /api/wallet/topup); only "create" actually needs it.

async function callWireFn(
  supabase: ReturnType<typeof createSupabaseServerClient>["supabase"],
  body: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const { data, error } = await supabase.functions.invoke("wire-topup-create", { body });
  if (!error) return { status: 200, data };
  // Non-2xx: the function's own { error, code } is in the response body.
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === "function") {
    const payload = await ctx.json().catch(() => null);
    return { status: ctx.status ?? 500, data: payload ?? { error: "Request failed" } };
  }
  return { status: 500, data: { error: "Request failed" } };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Pending (not yet expired) rows, plus received rows from the last 7 days — everything else
// (cancelled, expired, and received-more-than-a-week-ago) is hidden from this list. Filtered here
// rather than in the query because "expired" is a computed state (a pending row past its expires_at
// that nothing has flipped in the DB yet — only wire-topup-admin's "list" action does that lazily).
function visibleTransfers(rows: WireTransferRow[]): WireTransferRow[] {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return rows.filter((t) => {
    const status = effectiveStatus(t);
    if (status === "pending") return true;
    if (status === "received") return !!t.received_at && new Date(t.received_at).getTime() >= cutoff;
    return false; // cancelled, expired
  });
}

async function authed(request: Request) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { denied: Response.json({ error: "Unauthorized" }, { status: 401, headers }) } as const;
  const denied = await proDeniedResponse(supabase, user.id, headers);
  if (denied) return { denied } as const;
  return { supabase, headers, user } as const;
}

export async function loader({ request }: Route.LoaderArgs) {
  const a = await authed(request);
  if ("denied" in a && a.denied) return a.denied;
  const { supabase, headers } = a as Exclude<typeof a, { denied: Response }>;

  const [{ status, data: options }, { data: transfers }, { data: banks }] = await Promise.all([
    callWireFn(supabase, { action: "options" }),
    supabase
      .from("wire_topups")
      .select("id, reference_code, currency, amount_cents, fee_cents, transfer_amount_cents, status, expires_at, created_at, received_at")
      .order("created_at", { ascending: false })
      .limit(30),
    // Active bank details (RLS: signed-in users can read active rows) — lets an existing transfer's
    // instructions be shown again without creating a new one.
    supabase
      .from("wire_accounts")
      .select("currency, account_holder, bank_name, account_number, routing_number, swift_bic, bank_address, notes")
      .eq("is_active", true),
  ]);
  if (status !== 200) return Response.json({ options: { enabled: false }, transfers: [], banks: [] }, { headers });
  return Response.json({ options, transfers: visibleTransfers((transfers ?? []) as WireTransferRow[]), banks: banks ?? [] }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const a = await authed(request);
  if ("denied" in a && a.denied) return a.denied;
  const { supabase, headers, user } = a as Exclude<typeof a, { denied: Response }>;

  let body: { action?: string; currency?: string; amount_cents?: number; wire_topup_id?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  // "create" is the default for back-compat with any caller that doesn't send `action` — in
  // practice WireTopupPanel always sends one of the three explicitly.
  const action = body.action === "quote" || body.action === "cancel" ? body.action : "create";

  if (action === "quote") {
    const { status, data } = await callWireFn(supabase, {
      action: "quote",
      currency: body.currency,
      amount_cents: body.amount_cents,
    });
    return Response.json(data, { status, headers });
  }

  if (action === "cancel") {
    const { status, data } = await callWireFn(supabase, {
      action: "cancel",
      wire_topup_id: body.wire_topup_id,
    });
    return Response.json(data, { status, headers });
  }

  const requestedProfileId = new URL(request.url).searchParams.get("profile_id");
  const profile = await getActiveProfile(request, supabase, user.id, requestedProfileId);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const { status, data } = await callWireFn(supabase, {
    action: "create",
    currency: body.currency,
    amount_cents: body.amount_cents,
    profile_id: profile.id,
    source: "web",
  });
  return Response.json(data, { status, headers });
}
