import type { Route } from "./+types/api.wire-topup";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { proDeniedResponse } from "~/lib/pro.server";
import { getActiveProfile } from "~/lib/profile.server";

// Bank-transfer wallet top-up — WEB user side (docs/wallet/wire-topup.md). No wallet logic lives
// here: it forwards to the wire-topup-create edge function with the signed-in user's own session
// (functions.invoke attaches it), and reads the account's own wire_topups rows through RLS.
//
//   GET  → { options, transfers, banks }   options = wire-topup-create "options" (enabled / min / fee / currencies);
//                                   transfers = this account's recent requests (newest first, cancelled hidden)
//   POST { currency, amount_cents } → wire-topup-create "create" → { transfer, bank, card_comparison }
//         ?profile_id= selects the active profile (same convention as /api/wallet/topup)

async function callCreate(
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
    callCreate(supabase, { action: "options" }),
    supabase
      .from("wire_topups")
      .select("id, reference_code, currency, amount_cents, fee_cents, transfer_amount_cents, status, expires_at, created_at, received_at")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(10),
    // Active bank details (RLS: signed-in users can read active rows) — lets an existing transfer's
    // instructions be shown again without creating a new one.
    supabase
      .from("wire_accounts")
      .select("currency, account_holder, bank_name, account_number, routing_number, swift_bic, bank_address, notes")
      .eq("is_active", true),
  ]);
  if (status !== 200) return Response.json({ options: { enabled: false }, transfers: [], banks: [] }, { headers });
  return Response.json({ options, transfers: transfers ?? [], banks: banks ?? [] }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const a = await authed(request);
  if ("denied" in a && a.denied) return a.denied;
  const { supabase, headers, user } = a as Exclude<typeof a, { denied: Response }>;

  let body: { currency?: string; amount_cents?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const requestedProfileId = new URL(request.url).searchParams.get("profile_id");
  const profile = await getActiveProfile(request, supabase, user.id, requestedProfileId);
  if (!profile) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const { status, data } = await callCreate(supabase, {
    action: "create",
    currency: body.currency,
    amount_cents: body.amount_cents,
    profile_id: profile.id,
    source: "web",
  });
  return Response.json(data, { status, headers });
}
