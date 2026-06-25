import { createClient } from "@supabase/supabase-js";
import { resolveLockedSqrzFeePct } from "~/lib/proposal-pricing";

export async function action({ request }: { request: Request }) {
  const { booking_id, proposal_id, invite_token } = await request.json();

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Verify token is valid for this booking
  const { data: participant } = await adminClient
    .from("booking_participants")
    .select("email, name, invite_token")
    .eq("booking_id", booking_id)
    .eq("invite_token", invite_token)
    .eq("role", "buyer")
    .single();

  if (!participant) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get proposal details including line_items and tax_pct
  const { data: proposal } = await adminClient
    .from("booking_proposals")
    .select("rate, currency, requires_payment, sqrz_fee_pct, stripe_mode, booking_id, line_items, tax_pct, bookings(title, owner_id, profiles(name))")
    .eq("id", proposal_id)
    .eq("booking_id", booking_id)
    .single();

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  const bk = proposal.bookings as unknown as { title: string; owner_id: string; profiles?: { name?: string } | null };

  // 3. Fetch member's Connect account + plan fee percentage
  const { data: ownerProfile } = await adminClient
    .from("profiles")
    .select("stripe_connect_id, stripe_connect_id_test, plan_id, plans(booking_fee_pct)")
    .eq("id", bk.owner_id)
    .single();

  const planId: number | null = (ownerProfile?.plan_id as number | null) ?? null;
  const planFeePct: number = (ownerProfile?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 0;
  const feePct = resolveLockedSqrzFeePct({
    requiresPayment: proposal.requires_payment,
    proposalFeePct: (proposal as { sqrz_fee_pct?: number | null }).sqrz_fee_pct,
    fallbackFeePct: planId === null ? 0 : planFeePct,
  });
  const stripeMode =
    (proposal as { stripe_mode?: string | null }).stripe_mode === "test" ? "test" : "live";
  const connectId: string | null =
    stripeMode === "test"
      ? (ownerProfile?.stripe_connect_id_test ?? null)
      : (ownerProfile?.stripe_connect_id ?? null);

  // Amount calculations (in cents)
  // net = what member quoted; SQRZ fee on net only; tax added on top
  const rate = proposal.rate;
  const taxPct: number = (proposal.tax_pct as number | null) ?? 0;
  const taxAmount = Math.round(rate * taxPct / 100 * 100);
  const feeAmount = Math.round(rate * feePct / 100 * 100);  // fee on net, not on net+tax
  const totalAmount = Math.round(rate * 100) + taxAmount + feeAmount;
  const taxAmountMajor = Math.round(rate * taxPct / 100 * 100) / 100;
  const feeAmountMajor = Math.round(rate * feePct / 100 * 100) / 100;
  const totalAmountMajor = Math.round((rate + taxAmountMajor + feeAmountMajor) * 100) / 100;

  console.log("[accept] feePct:", feePct, "rate:", rate, "total:", totalAmount / 100, "connectId:", connectId);

  {
    // Payment is never collected at proposal acceptance. Accepted proposals go straight
    // to 'confirmed'; invoicing and any Stripe payment link happen post-confirmation on
    // the booking page (Send Invoice / Send Invoice + Payment Link).
    await adminClient
      .from("booking_proposals")
      .update({ status: "accepted" })
      .eq("id", proposal_id);

    await adminClient
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", booking_id);

    // Create wallet + allocations from line_items
    try {
      const ownerProfileId = bk.owner_id;

      const { data: existingWallet } = await adminClient
        .from("booking_wallets")
        .select("id")
        .eq("booking_id", booking_id)
        .maybeSingle();

      let walletId: string | null = existingWallet?.id ?? null;

      if (!walletId) {
        const { data: newWallet } = await adminClient
          .from("booking_wallets")
          .insert({
            booking_id,
            owner_profile_id: ownerProfileId,
            total_budget: totalAmountMajor,
            secured_amount: proposal.rate ?? 0,
            base_rate: proposal.rate ?? 0,
            currency: proposal.currency ?? "EUR",
            stripe_mode: stripeMode,
            sqrz_fee_pct: feePct,
            tax_pct: taxPct || null,
            tax_amount: taxAmountMajor || null,
            status: "open",
            client_paid: false,
            payout_status: "pending",
          })
          .select("id")
          .single();
        walletId = newWallet?.id ?? null;
      } else {
        await adminClient
          .from("booking_wallets")
          .update({
            total_budget: totalAmountMajor,
            secured_amount: proposal.rate ?? 0,
            currency: proposal.currency ?? "EUR",
            stripe_mode: stripeMode,
            sqrz_fee_pct: feePct,
            tax_pct: taxPct || null,
            tax_amount: taxAmountMajor || null,
          })
          .eq("id", walletId);
      }

      const lineItems = proposal.line_items as Array<{ label: string; type: string; amount: number }> | null;
      if (walletId && lineItems?.length) {
        await adminClient.from("wallet_allocations").insert(
          lineItems.map((item) => ({
            wallet_id: walletId,
            allocation_type: item.type,
            label: item.label,
            role: item.label,
            amount: item.amount,
            currency: proposal.currency ?? "EUR",
            status: "pending",
          }))
        );
      }
    } catch (err) {
      console.error("[accept] wallet/allocation creation failed:", err);
    }

    return Response.json({ confirmed: true });
  }
}
