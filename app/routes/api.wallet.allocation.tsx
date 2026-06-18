import type { Route } from "./+types/api.wallet.allocation";
import {
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { roundCurrency } from "~/lib/proposal-pricing";

// Add a wallet line item (allocation) with server-side recalc of wallet totals.
// Bearer-only (sqrz-ios native) — mirrors the add_wallet_allocation form intent in
// booking.$id.tsx, but accepts JSON + Bearer and runs the full recalc server-side so
// the native client doesn't have to. "charge_client" maps to allocation_type +
// billable_to_client:
//   charge_client true  → income, billable (raises secured_amount + total_budget)
//   charge_client false → crew,   not billable (internal cost, no effect on totals)
export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseBearerClient(bearerToken);
  const { data: { user } } = await supabase.auth.getUser(bearerToken);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Body: JSON { wallet_id, label, amount, charge_client }
  const body = (await request.json().catch(() => ({}))) as {
    wallet_id?: number;
    label?: string;
    amount?: number;
    charge_client?: boolean;
  };

  const walletId = body.wallet_id;
  const label = (body.label ?? "").trim();
  const amount = Number(body.amount ?? 0);
  const chargeClient = body.charge_client === true;

  if (walletId == null) {
    return Response.json({ error: "wallet_id is required" }, { status: 400 });
  }
  if (!label) {
    return Response.json({ error: "label is required" }, { status: 400 });
  }
  if (!(amount > 0)) {
    return Response.json({ error: "amount must be greater than 0" }, { status: 400 });
  }

  const allocationType = chargeClient ? "income" : "crew";
  const billableToClient = chargeClient;

  const admin = createSupabaseAdminClient();

  // Wallet must exist and be owned by the authenticated profile.
  const { data: wallet } = await admin
    .from("booking_wallets")
    .select("id, owner_profile_id, currency, base_rate, tax_pct, sqrz_fee_pct")
    .eq("id", walletId)
    .maybeSingle();

  if (!wallet) {
    return Response.json({ error: "Wallet not found" }, { status: 400 });
  }
  if (wallet.owner_profile_id !== profile.id) {
    return Response.json({ error: "Not authorized for this wallet" }, { status: 401 });
  }

  // Insert the allocation.
  const { data: newAllocation, error: insertError } = await admin
    .from("wallet_allocations")
    .insert({
      wallet_id: walletId,
      allocation_type: allocationType,
      label,
      role: label,
      amount,
      currency: wallet.currency ?? "EUR",
      status: "pending",
      billable_to_client: billableToClient,
    })
    .select("id")
    .single();

  if (insertError || !newAllocation) {
    return Response.json({ error: "Could not add line item" }, { status: 400 });
  }

  // Recalc wallet totals (exact same logic as add_wallet_allocation in booking.$id.tsx).
  // base_rate is frozen at creation; secured_amount = base_rate + sum of income
  // allocations. tax/fee track secured_amount. (billable expense → V2; crew/promo → no
  // effect on totals.)
  const { data: incomeRows } = await admin
    .from("wallet_allocations")
    .select("amount")
    .eq("wallet_id", walletId)
    .eq("allocation_type", "income")
    .neq("status", "void");

  const incomeTotal = (incomeRows ?? []).reduce(
    (sum, r) => sum + Number(r.amount ?? 0),
    0
  );

  const baseRate = Number(wallet.base_rate ?? 0);
  const taxPct   = Number(wallet.tax_pct ?? 0);
  const feePct   = Number(wallet.sqrz_fee_pct ?? 0);

  const newSecured = roundCurrency(baseRate + incomeTotal);
  const newTax     = roundCurrency(newSecured * taxPct / 100);
  const newFee     = roundCurrency(newSecured * feePct / 100);
  const newTotal   = roundCurrency(newSecured + newTax + newFee);

  await admin
    .from("booking_wallets")
    .update({
      secured_amount: newSecured,
      tax_amount: newTax,
      total_budget: newTotal,
    })
    .eq("id", walletId);

  return Response.json({
    ok: true,
    allocation_id: newAllocation.id,
    wallet: {
      secured_amount: newSecured,
      tax_amount: newTax,
      total_budget: newTotal,
    },
  });
}
