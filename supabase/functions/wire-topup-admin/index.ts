import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, bearer, json } from "../_shared/wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// wire-topup-admin — Will's back office for bank-transfer wallet top-ups (iOS "Sandbox" sheet).
//
// !! ACCESS = accounts.is_lab — the SAME check as sandbox-admin: normal JWT verification (deploy
// !! WITHOUT --no-verify-jwt) plus public.caller_account_is_lab() called with the caller's own JWT.
// !! Not lab → 403. There is deliberately no client-side check.
//
// POST { action, params } with Authorization: Bearer <user access token> → { ok, result } | { ok:false, error }
//   list           {}                                  → { transfers } open first (pending, then expired), then the
//                                                        30 most recent received/cancelled. Lazily flips pending rows
//                                                        past expires_at to status 'expired'.
//   mark_received  { id, received_amount_cents }       → credits the wallet via credit_wire_topup (the SAME
//                                                        record_wallet_topup path as the Stripe webhook: ledger entry,
//                                                        management_fee_charges row, balance), links ledger_entry_id,
//                                                        notifies the user. IDEMPOTENT: a transfer is credited once;
//                                                        repeating the call returns { already_credited: true }.
//   cancel         { id }                              → pending/expired → cancelled. A received transfer can't be cancelled.
// received_amount_cents is what actually ARRIVED, in the transfer's currency (cents). Equal to the quote →
// credit exactly the quoted amount; different → pro rata (see credit_wire_topup in the migration).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const fail = (error: string, status: number) => json({ ok: false, error }, status);
const ok = (result: unknown) => json({ ok: true, result });

async function authorize(req: Request): Promise<{ userId: string } | Response> {
  const jwt = bearer(req);
  if (!jwt) return fail("unauthorized", 401);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user) return fail("unauthorized", 401);
  const { data: isLab, error: rpcErr } = await client.rpc("caller_account_is_lab");
  if (rpcErr) {
    console.error("[wire-topup-admin] is_lab check failed:", rpcErr.message);
    return fail("authorization check failed", 500);
  }
  if (isLab !== true) return fail("forbidden", 403);
  return { userId: data.user.id };
}

const COLS =
  "id, account_id, profile_id, currency, amount_cents, fee_cents, fee_pct, fx_rate, transfer_amount_cents, reference_code, status, expires_at, created_at, received_amount_cents, received_at, credited_cents, credited_fee_cents, ledger_entry_id";

type Row = Record<string, unknown>;

function effectiveStatus(r: Row): string {
  if (r.status === "pending" && new Date(r.expires_at as string).getTime() < Date.now()) return "expired";
  return String(r.status);
}

function idParam(p: Record<string, unknown>): string {
  const v = p.id;
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new Error("params.id must be a transfer id");
  return v;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("method not allowed", 405);
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;

  let body: { action?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch { return fail("invalid JSON body", 400); }
  const action = String(body.action ?? "");
  const params = body.params ?? {};
  const admin = adminClient();

  try {
    if (action === "list") {
      // Lazy expiry: keeps stored status honest without a cron job. Idempotent.
      await admin.from("wire_topups").update({ status: "expired" })
        .eq("status", "pending").lt("expires_at", new Date().toISOString());

      const [{ data: open }, { data: recent }] = await Promise.all([
        admin.from("wire_topups").select(COLS).in("status", ["pending", "expired"])
          .order("created_at", { ascending: false }).limit(100),
        admin.from("wire_topups").select(COLS).in("status", ["received", "cancelled"])
          .order("created_at", { ascending: false }).limit(30),
      ]);
      const openRows = ((open ?? []) as Row[]).sort((a, b) => {
        const rank = (r: Row) => (effectiveStatus(r) === "pending" ? 0 : 1);
        return rank(a) - rank(b);
      });
      const rows = [...openRows, ...((recent ?? []) as Row[])];

      const profileIds = [...new Set(rows.map((r) => r.profile_id as string))];
      const { data: profiles } = profileIds.length
        ? await admin.from("profiles").select("id, slug, name, brand_name").in("id", profileIds)
        : { data: [] };
      const byId = new Map<string, Row>((profiles ?? []).map((p: Row) => [p.id as string, p] as [string, Row]));
      return ok({
        transfers: rows.map((r) => {
          const p = byId.get(r.profile_id as string);
          return {
            ...r,
            status: effectiveStatus(r),
            profile_slug: (p?.slug as string) ?? null,
            profile_name: ((p?.brand_name as string) || (p?.name as string) || (p?.slug as string)) ?? null,
          };
        }),
      });
    }

    if (action === "mark_received") {
      const id = idParam(params);
      const received = Number(params.received_amount_cents);
      if (!Number.isInteger(received) || received <= 0) return fail("params.received_amount_cents must be a positive integer (cents)", 400);

      const { data: t } = await admin.from("wire_topups").select(COLS).eq("id", id).maybeSingle();
      if (!t) return fail("transfer not found", 404);
      if ((t as Row).status !== "received" && received > Number((t as Row).transfer_amount_cents) * 10) {
        return fail("received amount is more than 10× the expected amount — check the figure (it is in cents)", 400);
      }

      const { data, error } = await admin.rpc("credit_wire_topup", {
        p_wire_topup_id: id,
        p_received_cents: received,
        p_received_by: auth.userId,
      });
      if (error) {
        console.error("[wire-topup-admin] credit failed:", error.message);
        if (error.message.includes("cancelled")) return fail("this transfer was cancelled", 409);
        if (error.message.includes("too small")) return fail("received amount is too small to credit", 400);
        return fail("couldn't credit the wallet: " + error.message, 500);
      }
      const { data: fresh } = await admin.from("wire_topups").select(COLS).eq("id", id).maybeSingle();
      console.log(`[wire-topup-admin] ${auth.userId} marked ${id} received (${received}) →`, JSON.stringify(data));
      return ok({ ...(data as Row), transfer: fresh ? { ...fresh, status: effectiveStatus(fresh as Row) } : null });
    }

    if (action === "cancel") {
      const id = idParam(params);
      const { data: cancelled } = await admin.from("wire_topups").update({ status: "cancelled" })
        .eq("id", id).in("status", ["pending", "expired"]).select(COLS);
      if (cancelled && cancelled.length) return ok({ transfer: cancelled[0] });
      const { data: t } = await admin.from("wire_topups").select(COLS).eq("id", id).maybeSingle();
      if (!t) return fail("transfer not found", 404);
      if ((t as Row).status === "cancelled") return ok({ transfer: t }); // idempotent
      return fail("this transfer was already credited and can't be cancelled", 409);
    }

    return fail("action must be one of: list, mark_received, cancel", 400);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 400);
  }
});
