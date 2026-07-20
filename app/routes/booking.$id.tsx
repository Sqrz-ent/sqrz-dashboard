import { useEffect, useState } from "react";
import { useLoaderData, useFetcher, useSearchParams, redirect } from "react-router";
import type { Route } from "./+types/booking.$id";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { canManageBookingBilling } from "~/lib/delegate.server";
import { normalizeTaxPresets, type TaxPreset } from "~/lib/tax-presets";
import { resolveMessagingProviderForBooking } from "~/lib/messaging/provider-resolver.server";
import type { MessagingProvider } from "~/lib/messaging/types";
import { getPlanLevel } from "~/lib/plans";
import { handleBookingReferral } from "~/lib/booking-referral.server";
import {
  resolveLockedSqrzFeePct,
  roundCurrency,
} from "~/lib/proposal-pricing";
import { getStripeClient } from "~/lib/stripe-mode.server";
import { supabase as browserClient } from "~/lib/supabase.client";
import BookingWallet, { type WalletData } from "~/components/BookingWallet";
import BookingChat from "~/components/BookingChat";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = Record<string, unknown>;
type ProposalStripeMode = "live" | "test";

export type LineItem = {
  label: string;
  amount: number;
};

type GuestParticipant = {
  id: string;
  booking_id: string;
  email: string | null;
  role: string;
  invite_token: string;
  user_id: string | null;
};

type Proposal = {
  id: string;
  booking_id: string;
  rate: number | null;
  currency: string | null;
  message: string | null;
  status: string | null;
  require_hotel: boolean | null;
  require_travel: boolean | null;
  require_food: boolean | null;
  payment_method?: string | null;
  version?: number | null;
  sent_by?: string | null;
  parent_proposal_id?: string | null;
  requires_payment?: boolean | null;
  line_items?: LineItem[] | null;
  tax_pct?: number | null;
  tax_label?: string | null;
  sqrz_fee_pct?: number | null;
  stripe_mode?: ProposalStripeMode | null;
} | null;

type MemberInfo = {
  name: string | null;
  company_name: string | null;
  legal_form: string | null;
  vat_id: string | null;
  company_address: string | null;
  responsible_person: string | null;
} | null;

type BookingMessagingProvider = MessagingProvider;

function getLatestProposalRecord(proposals: unknown): NonNullable<Proposal> | null {
  if (!Array.isArray(proposals)) return null;
  return (proposals as Array<NonNullable<Proposal>>)
    .slice()
    .sort((a, b) => ((b.version ?? 0) - (a.version ?? 0)))[0] ?? null;
}

async function syncWalletFromProposal(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  walletId: string;
  proposal: NonNullable<Proposal> | null;
  clientPaid?: boolean | null;
}) {
  const { admin, walletId, proposal, clientPaid } = input;
  if (!proposal || !walletId) return;

  // ── Data-integrity guards: never clobber real wallet figures ─────────────────
  // 1. Only an ACCEPTED proposal may drive wallet amounts. A draft/sent/countered
  //    proposal must never overwrite the wallet.
  if (proposal.status !== "accepted") return;
  // 2. Once a wallet is funded by a real Stripe payment it is the source of truth —
  //    never overwrite its amounts.
  if (clientPaid === true) return;

  const proposalNet = Number(proposal.rate ?? 0);
  const proposalTaxPct = Number(proposal.tax_pct ?? 0);
  const proposalTaxAmount = proposalTaxPct > 0 ? roundCurrency(proposalNet * proposalTaxPct / 100) : 0;
  const proposalFeePct = resolveLockedSqrzFeePct({
    requiresPayment: proposal.requires_payment,
    proposalFeePct: proposal.sqrz_fee_pct,
    fallbackFeePct: 0,
  });
  const proposalFeeAmount = roundCurrency(proposalNet * proposalFeePct / 100);
  const proposalTotal = roundCurrency(proposalNet + proposalTaxAmount + proposalFeeAmount);

  await admin
    .from("booking_wallets")
    .update({
      secured_amount: proposalNet,
      total_budget: proposalTotal,
      currency: proposal.currency ?? "EUR",
      stripe_mode: proposal.requires_payment && proposal.stripe_mode === "test" ? "test" : "live",
      sqrz_fee_pct: proposalFeePct,
      tax_pct: proposalTaxPct || null,
      tax_amount: proposalTaxAmount || null,
      tax_label: (proposal as { tax_label?: string | null }).tax_label ?? null,
    })
    .eq("id", walletId);
}

// Single source of truth for loading the owner's wallet on a bookable status.
// Creates the wallet from the latest proposal if missing, otherwise syncs it,
// and returns the fresh row. Replaces the duplicated create/sync blocks that
// previously lived inline in each loader branch.
async function getOrCreateBookingWallet(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  booking: { id: string; owner_id: string; booking_proposals?: unknown };
}): Promise<WalletData | null> {
  const { admin, booking } = input;

  const { data: existingWallet } = await admin
    .from("booking_wallets")
    .select("*")
    .eq("booking_id", booking.id)
    .maybeSingle();

  if (!existingWallet) {
    const latestProposal = getLatestProposalRecord(booking.booking_proposals);
    const proposalNet = Number(latestProposal?.rate ?? 0);
    const proposalTaxPct = Number(latestProposal?.tax_pct ?? 0);
    const proposalTaxAmount = proposalTaxPct > 0 ? roundCurrency(proposalNet * proposalTaxPct / 100) : 0;
    const lockedFeePct = resolveLockedSqrzFeePct({
      requiresPayment: latestProposal?.requires_payment,
      proposalFeePct: latestProposal?.sqrz_fee_pct,
      fallbackFeePct: 0,
    });
    const proposalFeeAmount = roundCurrency(proposalNet * lockedFeePct / 100);
    const { data: newWallet } = await admin
      .from("booking_wallets")
      .insert({
        booking_id: booking.id,
        owner_profile_id: booking.owner_id,
        total_budget: roundCurrency(proposalNet + proposalTaxAmount + proposalFeeAmount),
        secured_amount: proposalNet,
        currency: latestProposal?.currency ?? "EUR",
        sqrz_fee_pct: lockedFeePct,
        tax_pct: proposalTaxPct || null,
        tax_amount: proposalTaxAmount || null,
        tax_label: (latestProposal as { tax_label?: string | null } | null)?.tax_label ?? null,
        status: "pending",
      })
      .select("*")
      .single();
    return (newWallet as WalletData | null) ?? null;
  }

  const latestProposal = getLatestProposalRecord(booking.booking_proposals);
  await syncWalletFromProposal({
    admin,
    walletId: (existingWallet as { id: string }).id,
    proposal: latestProposal,
    clientPaid: (existingWallet as { client_paid?: boolean | null }).client_paid,
  });
  const { data: refreshedWallet } = await admin
    .from("booking_wallets")
    .select("*")
    .eq("id", (existingWallet as { id: string }).id)
    .maybeSingle();
  return ((refreshedWallet ?? existingWallet) as WalletData | null) ?? null;
}


// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const url = new URL(request.url);

  // PKCE code exchange — magic link callback
  const code = url.searchParams.get("code");
  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  const admin = createSupabaseAdminClient();
  const token = url.searchParams.get("token");

  // Always check session upfront — needed for token+session merge path
  const { data: { user } } = await supabase.auth.getUser();

  // Helper: compute a display name from a profile — never exposes email domain
  function profileSenderName(p: Record<string, unknown> | null): string | null {
    if (!p) return null;
    return (p.brand_name as string | null) ||
      (p.name as string | null) ||
      ((p.email as string | null)?.split("@")[0] ?? null);
  }

  // ── VALIDATE TOKEN (when present) ─────────────────────────────────────────
  let tokenRow: Record<string, unknown> | null = null;
  if (token) {
    const { data: row } = await admin
      .from("booking_participants")
      .select("id, booking_id, email, name, role, invite_token, user_id, bookings(*)")
      .eq("booking_id", params.id)
      .eq("invite_token", token)
      .limit(1)
      .maybeSingle();

    if (!row) return Response.json({ accessType: "invalid_token" }, { headers });
    tokenRow = row as Record<string, unknown>;

    // Link participant to auth user if session exists and not already linked
    if (user && !tokenRow.user_id) {
      await admin
        .from("booking_participants")
        .update({ user_id: user.id })
        .eq("id", tokenRow.id as string);
    }
  }

  // ── TOKEN + SESSION: full authenticated experience ─────────────────────────
  if (tokenRow && user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking } = await admin
      .from("bookings")
      .select("*, booking_participants(*), booking_proposals(*)")
      .eq("id", params.id)
      .maybeSingle();

    if (!booking) return Response.json({ accessType: "invalid_token" }, { headers });

    const isOwner = !!(profile && booking.owner_id === profile.id);
    const messagingProvider = await resolveMessagingProviderForBooking({
      admin,
      bookingId: params.id!,
    });

    const [{ data: tokenWallet }, { data: ownerPlan }] = await Promise.all([
      admin
        .from("booking_wallets")
        .select("id, sqrz_fee_pct, tax_pct, tax_amount, client_paid, payout_status, total_budget, currency")
        .eq("booking_id", params.id)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("plan_id, email, name, brand_name, company_name, legal_form, vat_id, company_address, responsible_person, plans(booking_fee_pct)")
        .eq("id", booking.owner_id)
        .maybeSingle(),
    ]);
    const ownerPlanId = (ownerPlan?.plan_id as number | null) ?? null;
    const proposalFeePct: number = ownerPlanId === null ? 0 : ((ownerPlan?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 0);
    const memberInfo: MemberInfo = ownerPlan ? {
      name: (ownerPlan.brand_name as string | null) ?? (ownerPlan.name as string | null) ?? null,
      company_name: (ownerPlan.company_name as string | null) ?? null,
      legal_form: (ownerPlan.legal_form as string | null) ?? null,
      vat_id: (ownerPlan.vat_id as string | null) ?? null,
      company_address: (ownerPlan.company_address as string | null) ?? null,
      responsible_person: (ownerPlan.responsible_person as string | null) ?? null,
    } : null;

    let wallet: WalletData | null = null;
    if (isOwner) {
      const showPaymentsTab = ["pending", "confirmed", "completed"].includes(booking.status);
      if (showPaymentsTab) {
        wallet = await getOrCreateBookingWallet({ admin, booking });
      }
    } else {
      wallet = tokenWallet as WalletData | null;
    }

    const proposal = getLatestProposalRecord(booking.booking_proposals);

    // Load buyer participant for owner
    let tokenBuyerParticipant: BuyerParticipant = null;
    if (isOwner) {
      const { data: buyerP } = await admin
        .from("booking_participants")
        .select("name, email, phone, billing_company, billing_address, billing_city, billing_country, billing_vat_id, billing_confirmed")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();
      tokenBuyerParticipant = buyerP ? {
        name: buyerP.name as string | null,
        email: buyerP.email as string | null,
        phone: (buyerP as Record<string, unknown>).phone as string | null ?? null,
        billing_company: (buyerP as Record<string, unknown>).billing_company as string | null ?? null,
        billing_address: (buyerP as Record<string, unknown>).billing_address as string | null ?? null,
        billing_city: (buyerP as Record<string, unknown>).billing_city as string | null ?? null,
        billing_country: (buyerP as Record<string, unknown>).billing_country as string | null ?? null,
        billing_vat_id: (buyerP as Record<string, unknown>).billing_vat_id as string | null ?? null,
        billing_confirmed: (buyerP as Record<string, unknown>).billing_confirmed as boolean | null ?? null,
      } : null;
    }

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : (tokenRow.role as string),
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        bookingToken: token,   // keep so buyer actions still work via token path
        wallet,
        planId: (profile?.plan_id as number | null) ?? null,
        proposalFeePct,
        memberInfo,
        stripeConnectId: (profile?.stripe_connect_id as string | null) ?? null,
        stripeConnectStatus: (profile?.stripe_connect_status as string | null) ?? null,
        stripeConnectIdTest: (profile?.stripe_connect_id_test as string | null) ?? null,
        stripeConnectStatusTest: (profile?.stripe_connect_status_test as string | null) ?? null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        memberEmail: (ownerPlan?.email as string | null) ?? null,
        buyerParticipant: tokenBuyerParticipant,
        messagingProvider,
      },
      { headers }
    );
  }

  // ── TOKEN ONLY (no session) ────────────────────────────────────────────────
  if (tokenRow) {
    const booking = tokenRow.bookings as Booking;
    const messagingProvider = await resolveMessagingProviderForBooking({
      admin,
      bookingId: params.id!,
    });
    const participant: GuestParticipant = {
      id: tokenRow.id as string,
      booking_id: tokenRow.booking_id as string,
      email: tokenRow.email as string | null,
      role: tokenRow.role as string,
      invite_token: tokenRow.invite_token as string,
      user_id: tokenRow.user_id as string | null,
    };

    const [{ data: proposal }, { data: tokenWallet }, { data: ownerPlan }] = await Promise.all([
      admin
        .from("booking_proposals")
        .select("*")
        .eq("booking_id", params.id)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("booking_wallets")
        .select("id, sqrz_fee_pct, tax_pct, tax_amount, client_paid, payout_status, total_budget, currency")
        .eq("booking_id", params.id)
        .maybeSingle(),
      admin
        .from("profiles")
        .select("plan_id, email, name, brand_name, company_name, legal_form, vat_id, company_address, responsible_person, plans(booking_fee_pct)")
        .eq("id", (booking as any).owner_id)
        .maybeSingle(),
    ]);
    const ownerPlanId = (ownerPlan?.plan_id as number | null) ?? null;
    const proposalFeePct: number = ownerPlanId === null ? 0 : ((ownerPlan?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 0);
    const memberInfoToken: MemberInfo = ownerPlan ? {
      name: (ownerPlan.brand_name as string | null) ?? (ownerPlan.name as string | null) ?? null,
      company_name: (ownerPlan.company_name as string | null) ?? null,
      legal_form: (ownerPlan.legal_form as string | null) ?? null,
      vat_id: (ownerPlan.vat_id as string | null) ?? null,
      company_address: (ownerPlan.company_address as string | null) ?? null,
      responsible_person: (ownerPlan.responsible_person as string | null) ?? null,
    } : null;

    // Sender name: use participant name field; fall back to email prefix (no domain)
    const senderName = (tokenRow.name as string | null) ||
      ((tokenRow.email as string | null)?.split("@")[0] ?? null);

    return Response.json(
      {
        accessType: "token",
        booking,
        participant,
        role: tokenRow.role as string,
        userEmail: (tokenRow.email as string) ?? "",
        isOwner: false,
        proposal: proposal ?? null,
        bookingToken: token,
        wallet: tokenWallet ?? null,
        proposalFeePct,
        memberInfo: memberInfoToken,
        planId: null,
        senderName,
        memberEmail: (ownerPlan?.email as string | null) ?? null,
        messagingProvider,
      },
      { headers }
    );
  }

  // ── SESSION ONLY (no token) ────────────────────────────────────────────────
  if (user) {
    const profile = await getCurrentProfile(supabase, user.id);

    const { data: booking } = await admin
      .from("bookings")
      .select("*, booking_participants(*), booking_proposals(*)")
      .eq("id", params.id)
      .maybeSingle();

    if (!booking) return Response.json({ accessType: "invalid_token" }, { headers });

    const isOwner = !!(profile && booking.owner_id === profile.id);
    // Booking access + wallet management is granted to the owner OR an active agent
    // delegate of the owner, acting on the owner's behalf.
    const canManageBilling = profile
      ? await canManageBookingBilling(admin, profile.id as string, booking.owner_id as string)
      : false;
    const messagingProvider = await resolveMessagingProviderForBooking({
      admin,
      bookingId: params.id!,
    });

    if (!isOwner) {
      const isParticipant = (booking.booking_participants ?? []).some(
        (p: { user_id: string | null }) => p.user_id === user.id
      );
      if (!isParticipant && !canManageBilling) return Response.json({ accessType: "no_access" }, { headers });
    }

    // Wallet for the owner (or a billing delegate) on bookable statuses
    let wallet: WalletData | null = null;
    const showPaymentsTab = ["pending", "confirmed", "completed"].includes(booking.status);
    if (canManageBilling && showPaymentsTab) {
      wallet = await getOrCreateBookingWallet({ admin, booking });
    }

    const proposal = getLatestProposalRecord(booking.booking_proposals);

    // Fetch owner's plan + business info (for non-owner participants; owner uses their own profile)
    let sessionProposalFeePct: number | null = null;
    let sessionMemberInfo: MemberInfo = null;
    let sessionMemberEmail: string | null = null;
    if (!isOwner || true) {
      // Always fetch — member wants to see their own biz info too
      const ownerId = isOwner ? profile!.id : booking.owner_id;
      const { data: ownerPlanSess } = await admin
        .from("profiles")
        .select("plan_id, email, name, brand_name, company_name, legal_form, vat_id, company_address, responsible_person, plans(booking_fee_pct)")
        .eq("id", ownerId)
        .maybeSingle();
      const ownerPlanIdSess = (ownerPlanSess?.plan_id as number | null) ?? null;
      sessionProposalFeePct = ownerPlanIdSess === null ? 0 : ((ownerPlanSess?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 0);
      sessionMemberEmail = (ownerPlanSess?.email as string | null) ?? null;
      sessionMemberInfo = ownerPlanSess ? {
        name: (ownerPlanSess.brand_name as string | null) ?? (ownerPlanSess.name as string | null) ?? null,
        company_name: (ownerPlanSess.company_name as string | null) ?? null,
        legal_form: (ownerPlanSess.legal_form as string | null) ?? null,
        vat_id: (ownerPlanSess.vat_id as string | null) ?? null,
        company_address: (ownerPlanSess.company_address as string | null) ?? null,
        responsible_person: (ownerPlanSess.responsible_person as string | null) ?? null,
      } : null;
    }

    // Load buyer participant for owner
    let sessionBuyerParticipant: BuyerParticipant = null;
    if (isOwner && profile) {
      const { data: buyerP } = await admin
        .from("booking_participants")
        .select("name, email, phone, billing_company, billing_address, billing_city, billing_country, billing_vat_id, billing_confirmed")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();
      sessionBuyerParticipant = buyerP ? {
        name: buyerP.name as string | null,
        email: buyerP.email as string | null,
        phone: (buyerP as Record<string, unknown>).phone as string | null ?? null,
        billing_company: (buyerP as Record<string, unknown>).billing_company as string | null ?? null,
        billing_address: (buyerP as Record<string, unknown>).billing_address as string | null ?? null,
        billing_city: (buyerP as Record<string, unknown>).billing_city as string | null ?? null,
        billing_country: (buyerP as Record<string, unknown>).billing_country as string | null ?? null,
        billing_vat_id: (buyerP as Record<string, unknown>).billing_vat_id as string | null ?? null,
        billing_confirmed: (buyerP as Record<string, unknown>).billing_confirmed as boolean | null ?? null,
      } : null;
    }

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : "member",
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        canManageBilling,
        proposal: proposal ?? null,
        bookingToken: null,
        wallet,
        planId: (profile?.plan_id as number | null) ?? null,
        taxPresets: normalizeTaxPresets((profile as Record<string, unknown> | null)?.tax_presets),
        proposalFeePct: sessionProposalFeePct,
        memberInfo: sessionMemberInfo,
        memberEmail: sessionMemberEmail,
        stripeConnectId: (profile?.stripe_connect_id as string | null) ?? null,
        stripeConnectStatus: (profile?.stripe_connect_status as string | null) ?? null,
        stripeConnectIdTest: (profile?.stripe_connect_id_test as string | null) ?? null,
        stripeConnectStatusTest: (profile?.stripe_connect_status_test as string | null) ?? null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        buyerParticipant: sessionBuyerParticipant,
        messagingProvider,
      },
      { headers }
    );
  }

  // ── NO TOKEN, NO SESSION ──────────────────────────────────────────────────
  return Response.json({ accessType: "reauth", bookingId: params.id }, { headers });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Session-based: all member / owner intents
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { headers, status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  // All intents below require ownership
  const { data: bkCheck } = await supabase
    .from("bookings")
    .select("owner_id")
    .eq("id", params.id)
    .single();

  if (!bkCheck || bkCheck.owner_id !== profile.id) {
    return Response.json({ error: "Unauthorized" }, { headers, status: 403 });
  }

  if (intent === "decline_request") {
    await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return redirect("/office", { headers });
  }

  if (intent === "send_proposal") {
    const rateRaw = parseFloat(formData.get("rate") as string) || null;
    const currency = (formData.get("currency") as string) || "EUR";
    const message = (formData.get("message") as string) || "";
    const requireHotel = formData.get("require_hotel") === "true";
    const requireTravel = formData.get("require_travel") === "true";
    const requireFood = formData.get("require_food") === "true";
    // Payment is never collected at the proposal stage. Proposals are always non-payment;
    // invoicing and any Stripe payment link happen post-confirmation on the booking page.
    const requiresPayment = false;
    const existingProposalId = (formData.get("existing_proposal_id") as string) || null;
    const lineItemsRaw = (formData.get("line_items") as string) || null;
    const taxPctRaw = formData.get("tax_pct") as string | null;
    const taxPct = taxPctRaw ? (parseFloat(taxPctRaw) || null) : null;
    const taxLabel = ((formData.get("tax_label") as string) || "").trim() || null;

    let lineItems: LineItem[] | null = null;
    const rate = rateRaw;
    try {
      if (lineItemsRaw) {
        lineItems = JSON.parse(lineItemsRaw) as LineItem[];
      }
    } catch { /* ignore parse error */ }

    const admin = createSupabaseAdminClient();
    // Payment is never collected at the proposal stage, so the SQRZ fee is always 0
    // and no Stripe account/mode gating applies here.
    const lockedFeePct = resolveLockedSqrzFeePct({ requiresPayment });
    const normalizedRate = Number(rate ?? 0);
    const normalizedTaxPct = taxPct ?? 0;
    const normalizedTaxAmount = normalizedTaxPct > 0 ? roundCurrency(normalizedRate * normalizedTaxPct / 100) : 0;
    const normalizedFeeAmount = roundCurrency(normalizedRate * lockedFeePct / 100);
    const { error: bookingError } = await supabase
      .from("bookings")
      .update({ status: "pending" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);

    if (bookingError) return Response.json({ error: bookingError.message }, { status: 500, headers });

    // Versioning: if revising an existing proposal, increment version and mark old as countered
    let newVersion = 1;
    let parentProposalId: string | null = null;

    if (existingProposalId) {
      const { data: prev } = await admin
        .from("booking_proposals")
        .select("version")
        .eq("id", existingProposalId)
        .single();

      newVersion = (prev?.version ?? 1) + 1;
      parentProposalId = existingProposalId;

      await admin
        .from("booking_proposals")
        .update({ status: "countered" })
        .eq("id", existingProposalId);
    }

    const { error: insertError } = await admin
      .from("booking_proposals")
      .insert({
        booking_id: params.id,
        rate,
        currency,
        require_hotel: requireHotel,
        require_travel: requireTravel,
        require_food: requireFood,
        requires_payment: requiresPayment,
        message: message || null,
        status: "sent",
        sent_by: "member",
        version: newVersion,
        parent_proposal_id: parentProposalId,
        line_items: lineItems ?? null,
        tax_pct: taxPct,
        tax_label: taxLabel,
        sqrz_fee_pct: lockedFeePct,
        stripe_mode: "live",
      })
      .select();

    if (insertError) {
      console.error("[proposal insert] error:", insertError);
    }

    await admin
      .from("booking_wallets")
      .update({
        secured_amount: normalizedRate,
        total_budget: roundCurrency(normalizedRate + normalizedTaxAmount + normalizedFeeAmount),
        currency,
        stripe_mode: "live",
        sqrz_fee_pct: lockedFeePct,
        tax_pct: normalizedTaxPct || null,
        tax_amount: normalizedTaxAmount || null,
        tax_label: taxLabel,
      })
      .eq("booking_id", params.id);

    try {
      const { data: bkData } = await supabase
        .from("bookings")
        .select("service, date_start, city, venue")
        .eq("id", params.id)
        .maybeSingle();

      const { data: buyer } = await admin
        .from("booking_participants")
        .select("email, name, user_id, invite_token")
        .eq("booking_id", params.id)
        .eq("role", "buyer")
        .maybeSingle();

      const guestEmail = buyer?.email;
      const guestName = buyer?.name;

      if (!guestEmail) {
        console.error("[proposal] no buyer found for booking", params.id);
        return Response.json({ error: "No requester found for this booking" }, { status: 422, headers });
      }

      const ownerName =
        (profile.name as string | null) ??
        (profile.first_name as string | null) ??
        "Your booking partner";
      const accessUrl = buyer?.invite_token
        ? `https://dashboard.sqrz.com/booking/${params.id}?token=${buyer.invite_token}`
        : `https://dashboard.sqrz.com/booking/${params.id}`;

      const riderItems = [
        requireHotel && "🏨 Hotel",
        requireTravel && "✈️ Travel",
        requireFood && "🍽️ Catering",
      ]
        .filter(Boolean)
        .join(" · ");

      const emailHtml = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#0a0a0a;padding:32px;text-align:center;">
      <img src="https://sqrz.com/brand/sqrz_logo.png" alt="SQRZ" style="height:32px;" />
    </div>
    <div style="padding:32px;">
      <p style="color:#666;font-size:14px;margin:0 0 8px;">Hi ${guestName ?? "there"},</p>
      <h1 style="font-size:24px;font-weight:700;margin:0 0 24px;color:#0a0a0a;">
        You have a proposal from ${ownerName}
      </h1>
      <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;">
        ${bkData?.service ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Service</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${bkData.service}</p></div>` : ""}
        ${bkData?.date_start ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Date</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${new Date(bkData.date_start).toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p></div>` : ""}
        ${bkData?.city ? `<div style="margin-bottom:12px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Location</span><p style="margin:4px 0 0;font-weight:600;color:#0a0a0a;">${bkData.venue ? `${bkData.venue}, ` : ""}${bkData.city}</p></div>` : ""}
        <div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;">
          <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Proposed Rate</span>
          <p style="margin:4px 0 0;font-size:28px;font-weight:700;color:#0a0a0a;">${currency.toUpperCase()} ${rate}</p>
        </div>
        ${riderItems ? `<div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Rider</span><p style="margin:4px 0 0;color:#0a0a0a;">${riderItems}</p></div>` : ""}
        ${message ? `<div style="border-top:1px solid #eee;margin-top:16px;padding-top:16px;"><span style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#999;">Note from ${ownerName}</span><p style="margin:4px 0 0;color:#0a0a0a;">${message}</p></div>` : ""}
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="${accessUrl}" style="background:#F3B130;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
          View Full Proposal →
        </a>
      </div>
      <p style="color:#999;font-size:12px;text-align:center;">
        This link gives you direct access to your booking — no login needed.
      </p>
    </div>
    <div style="padding:20px 32px;border-top:1px solid #eee;text-align:center;">
      <p style="color:#ccc;font-size:11px;margin:0;">Powered by <a href="https://sqrz.com" style="color:#F3B130;text-decoration:none;">SQRZ</a></p>
    </div>
  </div>
</body>
</html>`;

      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: guestEmail,
        subject: `${ownerName} sent you a proposal on SQRZ`,
        html: emailHtml,
      });
    } catch (err) {
      console.error("[proposal] email send failed:", err);
    }

    return Response.json({ ok: true }, { headers });
  }

  if (intent === "mark_as_delivered") {
    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    const admin = createSupabaseAdminClient();
    await admin
      .from("booking_wallets")
      .update({
        payout_status: "approved",
        delivery_confirmed_at: new Date().toISOString(),
        auto_release_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      })
      .eq("booking_id", params.id);
    try {
      const { data: wallet } = await admin
        .from("booking_wallets")
        .select("secured_amount, stripe_mode")
        .eq("booking_id", params.id)
        .maybeSingle();
      if (wallet?.secured_amount) {
        await handleBookingReferral({
          supabase: admin,
          bookingId: params.id!,
          bookingValue: Number(wallet.secured_amount),
          stripeMode: (wallet.stripe_mode as ProposalStripeMode | null) ?? "live",
        });
      }
    } catch (err) {
      console.error("[mark_as_delivered] referral commission failed:", err);
    }
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_mark_paid") {
    const admin = createSupabaseAdminClient();
    await admin.from("booking_wallets").update({ client_paid: true, client_payment_method: "manual" }).eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_wallet_allocation") {
    const walletId       = formData.get("wallet_id") as string;
    const allocationType = formData.get("allocation_type") as string;
    const allocLabel     = formData.get("label") as string;
    const allocAmount    = parseFloat(formData.get("amount") as string) || 0;
    const currency       = formData.get("currency") as string;
    const billableToClient = formData.get("billable_to_client") === "true";
    const admin = createSupabaseAdminClient();
    await admin.from("wallet_allocations").insert({
      wallet_id: walletId,
      allocation_type: allocationType,
      label: allocLabel,
      role: allocLabel,
      amount: allocAmount,
      currency,
      status: "pending",
      billable_to_client: billableToClient,
    });

    // Recompute wallet totals. base_rate is frozen at creation; secured_amount =
    // base_rate + sum of income allocations. tax tracks secured_amount.
    // (billable expense → V2; crew/promo → no effect on totals.)
    // SQRZ fee removed — total = secured + tax only.
    const { data: w } = await admin
      .from("booking_wallets")
      .select("base_rate, tax_pct")
      .eq("id", walletId)
      .maybeSingle();

    if (w) {
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

      const baseRate = Number(w.base_rate ?? 0);
      const taxPct   = Number(w.tax_pct ?? 0);

      const newSecured = roundCurrency(baseRate + incomeTotal);
      const newTax     = roundCurrency(newSecured * taxPct / 100);
      const newTotal   = roundCurrency(newSecured + newTax);

      await admin
        .from("booking_wallets")
        .update({
          secured_amount: newSecured,
          tax_amount: newTax,
          total_budget: newTotal,
        })
        .eq("id", walletId);
    }

    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_request_payment") {
    const allocationId = formData.get("allocation_id") as string;
    const amount       = parseFloat(formData.get("amount") as string) || 0;
    const currency     = (formData.get("currency") as string) || "EUR";

    const admin = createSupabaseAdminClient();

    const { data: buyer } = await admin
      .from("booking_participants")
      .select("email, invite_token, name")
      .eq("booking_id", params.id)
      .eq("role", "buyer")
      .maybeSingle();

    if (!buyer?.email) {
      return Response.json({ error: "No buyer found" }, { status: 422, headers });
    }

    const { data: bkMeta } = await admin
      .from("bookings")
      .select("title")
      .eq("id", params.id)
      .maybeSingle();

    const { data: allocation } = await admin
      .from("wallet_allocations")
      .select("wallet_id")
      .eq("id", allocationId)
      .maybeSingle();

    const { data: wallet } = allocation?.wallet_id
      ? await admin
          .from("booking_wallets")
          .select("stripe_mode")
          .eq("id", allocation.wallet_id)
          .maybeSingle()
      : { data: null };

    const stripeMode: ProposalStripeMode = wallet?.stripe_mode === "test" ? "test" : "live";
    const stripe = getStripeClient(stripeMode);
    if (!stripe) {
      return Response.json({ error: `Stripe ${stripeMode} mode is not configured.` }, { status: 500, headers });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: Math.round(amount * 100),
          product_data: { name: bkMeta?.title ?? "Payment Request" },
        },
        quantity: 1,
      }],
      success_url: `https://dashboard.sqrz.com/booking/${params.id}?token=${buyer.invite_token ?? ""}&payment=success`,
      cancel_url: `https://dashboard.sqrz.com/booking/${params.id}?token=${buyer.invite_token ?? ""}`,
      customer_email: buyer.email,
      metadata: {
        booking_id: params.id,
        wallet_allocation_id: allocationId,
        booking_type: "allocation_payment",
        stripe_mode: stripeMode,
      },
    });

    await admin
      .from("wallet_allocations")
      .update({ stripe_payment_link_url: session.url })
      .eq("id", allocationId);

    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const sym2 = currency.toUpperCase() === "EUR" ? "€" : currency.toUpperCase() === "GBP" ? "£" : "$";
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: buyer.email,
        subject: `Payment request: ${sym2}${amount.toLocaleString()}`,
        html: `<p>Hi ${buyer.name ?? "there"},</p><p>A payment of ${sym2}${amount.toLocaleString()} has been requested for booking: ${bkMeta?.title ?? ""}.</p><p><a href="${session.url}">Pay now →</a></p><p>— The SQRZ Team</p>`,
      });
    } catch { /* non-fatal */ }

    return Response.json({ ok: true }, { headers });
  }

  return Response.json({ ok: true }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h === 0 && m === 0) return datePart;
  return `${datePart} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatRate(rate: number | null, currency: string | null): string {
  if (!rate) return "—";
  const sym = currency?.toUpperCase() === "EUR" ? "€" : currency?.toUpperCase() === "GBP" ? "£" : "$";
  return `${sym}${rate.toLocaleString()}`;
}

function currencySym(c: string | null) {
  return c?.toUpperCase() === "EUR" ? "€" : c?.toUpperCase() === "GBP" ? "£" : "$";
}

// ─── Style constants ──────────────────────────────────────────────────────────

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 14,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

const val: React.CSSProperties = {
  color: "var(--text)",
  fontSize: 14,
  margin: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box" as const,
  fontFamily: FONT_BODY,
};

// Guest view label style
const guestMetaLabel: React.CSSProperties = {
  color: "var(--text-muted)", fontSize: 11, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 4px",
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested:       { bg: "rgba(245,166,35,0.12)", text: ACCENT },
  pending:         { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed:       { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed:       { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  archived:        { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  cancelled:       { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
};

// ─── Shared components ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.archived;
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 16px", lineHeight: 1.1 }}>
      {children}
    </h2>
  );
}

// ─── Member view sections ─────────────────────────────────────────────────────

function DetailsSection({ booking, memberInfo, buyerParticipant }: { booking: Booking; memberInfo?: MemberInfo; buyerParticipant?: BuyerParticipant }) {
  const b = booking;

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      {!!buyerParticipant && (
        <div style={card}>
          <p style={lbl}>Buyer</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {buyerParticipant.name && <p style={{ ...val, fontWeight: 600 }}>{buyerParticipant.name}</p>}
            {buyerParticipant.email && <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{buyerParticipant.email}</p>}
            {buyerParticipant.phone && <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{buyerParticipant.phone}</p>}
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: b.service ? 14 : 0 }}>
          <StatusBadge status={(b.status as string) ?? "pending"} />
        </div>
        {!!b.service && (
          <div>
            <p style={lbl}>Service</p>
            <p style={val}>{b.service as string}</p>
          </div>
        )}
      </div>

      <div style={card}>
        {!!(b.date_end && b.date_end !== b.date_start) ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <p style={lbl}>Start</p>
              <p style={val}>{formatDateTime(b.date_start as string | null)}</p>
            </div>
            <div style={{ textAlign: "right" }}>
              <p style={{ ...lbl, textAlign: "right" }}>End</p>
              <p style={{ ...val, textAlign: "right" }}>{formatDateTime(b.date_end as string | null)}</p>
            </div>
          </div>
        ) : (
          <div>
            <p style={lbl}>Date</p>
            <p style={val}>{formatDateTime(b.date_start as string | null)}</p>
          </div>
        )}
      </div>

      {!!(b.venue_address || b.venue_city || b.venue_zip || b.venue_country) && (
        <div style={card}>
          <p style={{ ...lbl, marginBottom: 14 }}>Location</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 16px" }}>
            {!!b.venue_address && (
              <div>
                <p style={lbl}>Street</p>
                <p style={val}>{b.venue_address as string}</p>
              </div>
            )}
            {!!b.venue_city && (
              <div>
                <p style={lbl}>City</p>
                <p style={val}>{b.venue_city as string}</p>
              </div>
            )}
            {!!b.venue_zip && (
              <div>
                <p style={lbl}>ZIP</p>
                <p style={val}>{b.venue_zip as string}</p>
              </div>
            )}
            {!!b.venue_country && (
              <div>
                <p style={lbl}>Country</p>
                <p style={val}>{b.venue_country as string}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rate is shown in full detail in the Proposal section — not duplicated here */}

      {(booking as { description?: string | null }).description && (
        <div style={card}>
          <p style={lbl}>Message from requester</p>
          <p style={{ ...val, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65 }}>
            {(booking as { description: string }).description}
          </p>
        </div>
      )}

      {memberInfo && (memberInfo.company_name || memberInfo.legal_form || memberInfo.vat_id || memberInfo.responsible_person) && (
        <div style={card}>
          <p style={lbl}>Seller Information</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {(memberInfo.company_name || memberInfo.name) && (
              <p style={{ ...val, fontWeight: 600 }}>{memberInfo.company_name ?? memberInfo.name}</p>
            )}
            {memberInfo.legal_form && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{memberInfo.legal_form}</p>
            )}
            {memberInfo.company_address && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{memberInfo.company_address}</p>
            )}
            {memberInfo.vat_id && (
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>VAT: {memberInfo.vat_id}</p>
            )}
          </div>
        </div>
      )}

    </section>
  );
}

function ProposalSection({
  booking,
  taxPresets = [],
}: {
  booking: Booking;
  taxPresets?: TaxPreset[];
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const declineFetcher = useFetcher<{ ok?: boolean }>();

  // All proposals sorted by version desc — latest first
  const allProposals = ((booking as { booking_proposals?: Array<NonNullable<Proposal>> }).booking_proposals ?? [])
    .slice()
    .sort((a, b) => ((b.version ?? 0) - (a.version ?? 0)));
  const latestProposal = allProposals[0] ?? null;
  const buyerCounted = latestProposal?.sent_by === "buyer";
  const memberSentAndWaiting = latestProposal?.sent_by === "member" && latestProposal?.status === "sent";
  const isRevise = !!latestProposal;

  // Hide form when member is waiting for buyer response, or buyer has countered
  const [showForm, setShowForm] = useState(!buyerCounted && !memberSentAndWaiting);
  const [showHistory, setShowHistory] = useState(false);

  const [form, setForm] = useState({
    rate: String(latestProposal?.rate ?? ""),
    currency: latestProposal?.currency ?? "EUR",
    message: "",
  });

  // Tax: preset dropdown when the profile has tax_presets, else free-text fallback.
  const hasTaxPresets = taxPresets.length > 0;
  const defaultTaxIdx = taxPresets.findIndex((p) => p.is_default);
  const [selectedTaxIdx, setSelectedTaxIdx] = useState<number | null>(() => {
    const lp = latestProposal;
    if (lp && (lp.tax_pct ?? 0) > 0) {
      const byLabel = lp.tax_label ? taxPresets.findIndex((p) => p.label === lp.tax_label) : -1;
      if (byLabel >= 0) return byLabel;
      const byRate = taxPresets.findIndex((p) => p.rate === lp.tax_pct);
      if (byRate >= 0) return byRate;
      return null; // had tax but no matching preset
    }
    if (lp) return null; // existing proposal, no tax
    return defaultTaxIdx >= 0 ? defaultTaxIdx : null; // new proposal → default preset
  });
  // Free-text fallback (only used when the profile has no presets).
  const [taxEnabled, setTaxEnabled] = useState(!hasTaxPresets && !!(latestProposal?.tax_pct));
  const [taxPct, setTaxPct] = useState(String(latestProposal?.tax_pct ?? ""));

  const selectedPreset = selectedTaxIdx != null ? (taxPresets[selectedTaxIdx] ?? null) : null;
  const effectiveTaxPct = hasTaxPresets
    ? (selectedPreset?.rate ?? 0)
    : (taxEnabled ? (parseFloat(taxPct) || 0) : 0);
  const effectiveTaxLabel = hasTaxPresets ? (selectedPreset?.label ?? null) : null;

  const sent = fetcher.state === "idle" && fetcher.data?.ok;
  const sym = currencySym(latestProposal?.currency ?? "EUR");

  return (
    <section id="proposal" style={{ paddingBottom: 40 }}>
      <SectionHeading>
        {buyerCounted ? "Counter Offer" : (showForm && isRevise) ? "Revise Proposal" : "Proposal"}
      </SectionHeading>

      {sent ? (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)" }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
            ✓ {isRevise ? "Revised proposal sent." : "Proposal sent — booking is now pending."}
          </p>
        </div>
      ) : (
        <>
          {/* Member sent proposal — waiting for buyer response */}
          {memberSentAndWaiting && !showForm && (
            <>
              {/* Sent proposal — full breakdown (read-only) */}
              {latestProposal!.rate != null && (() => {
                const p = latestProposal!;
                const net = p.rate ?? 0;
                const tPct = p.tax_pct ?? 0;
                const tAmt = tPct > 0 ? Math.round(net * tPct / 100 * 100) / 100 : 0;
                const bookerPays2 = Math.round((net + tAmt) * 100) / 100;
                const youReceiveGross2 = Math.round((net + tAmt) * 100) / 100;
                const yourNetIncome2 = net;
                const symP = currencySym(p.currency);
                return (
                  <div style={card}>
                    <p style={{ ...lbl, marginBottom: 10 }}>Sent Proposal</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>Rate (net)</span>
                        <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 700 }}>{symP}{net.toLocaleString()} <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{p.currency ?? "EUR"}</span></span>
                      </div>
                      {tAmt > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Tax ({tPct}%)</span>
                          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>+{symP}{tAmt.toLocaleString()}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Booker pays</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{symP}{bookerPays2.toLocaleString()}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: tAmt > 0 ? "1px solid var(--border)" : "none" }}>
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>You receive gross (before Stripe fees)</span>
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{symP}{youReceiveGross2.toLocaleString()}</span>
                      </div>
                      {tAmt > 0 && (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                            <span style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>of which tax ({tPct}%) — remit to authority</span>
                            <span style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>−{symP}{tAmt.toLocaleString()}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Your net income</span>
                            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{symP}{yourNetIncome2.toLocaleString()}</span>
                          </div>
                        </>
                      )}
                    </div>
                    {p.message && (
                      <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: "12px 0 0", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        {p.message}
                      </p>
                    )}
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "12px 0 0", lineHeight: 1.55 }}>
                      You are responsible for invoicing and local tax compliance. SQRZ does not collect or remit taxes on your behalf.
                    </p>
                  </div>
                );
              })()}

              {/* Waiting banner */}
              <div style={{ ...card, background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.2)" }}>
                <p style={{ color: ACCENT, fontSize: 14, margin: 0, fontWeight: 600 }}>
                  Proposal sent — waiting for buyer response
                </p>
              </div>

              {/* Revise button */}
              <button
                onClick={() => setShowForm(true)}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: "10px 18px",
                  fontFamily: FONT_BODY,
                  marginTop: 4,
                }}
              >
                Revise Proposal
              </button>
            </>
          )}

          {/* Buyer counter banner */}
          {buyerCounted && (
            <div style={{ ...card, background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.25)", marginBottom: 4 }}>
              <p style={{ color: "#60a5fa", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", margin: "0 0 6px" }}>
                Buyer countered
              </p>
              <p style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>
                {sym}{(latestProposal!.rate ?? 0).toLocaleString()}
                <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
                  {latestProposal!.currency ?? "EUR"}
                </span>
              </p>
              {latestProposal?.message && (
                <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                  "{latestProposal.message}"
                </p>
              )}
            </div>
          )}

          {/* Revise button — shown when buyer countered and form is collapsed */}
          {buyerCounted && !showForm && (
            <button
              onClick={() => setShowForm(true)}
              style={{
                width: "100%",
                padding: "13px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT_BODY,
                marginBottom: 12,
              }}
            >
              Revise Proposal
            </button>
          )}

          {/* Proposal form */}
          {showForm && (
            <div style={card}>
              {/* Rate + Currency */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 12, marginBottom: 6 }}>
                <div>
                  <p style={{ ...lbl, marginBottom: 6 }}>Total Budget (what the booker pays)</p>
                  <input
                    type="number"
                    style={inputStyle}
                    value={form.rate}
                    onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                    placeholder="1500"
                  />
                </div>
                <div>
                  <p style={{ ...lbl, marginBottom: 6 }}>Currency</p>
                  <select
                    style={{ ...inputStyle }}
                    value={form.currency}
                    onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>

              {/* Tax */}
              <div style={{ marginBottom: 14 }}>
                <p style={{ ...lbl, marginBottom: 6 }}>Tax</p>
                {hasTaxPresets ? (
                  <select
                    style={inputStyle}
                    value={selectedTaxIdx == null ? "" : String(selectedTaxIdx)}
                    onChange={(e) => setSelectedTaxIdx(e.target.value === "" ? null : Number(e.target.value))}
                  >
                    <option value="">No tax</option>
                    {taxPresets.map((p, i) => (
                      <option key={i} value={String(i)}>
                        {p.label} ({p.rate}%)
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: taxEnabled ? 10 : 0 }}>
                      <input
                        type="checkbox"
                        checked={taxEnabled}
                        onChange={(e) => {
                          setTaxEnabled(e.target.checked);
                          if (!e.target.checked) setTaxPct("");
                        }}
                        style={{ accentColor: ACCENT, width: 15, height: 15 }}
                      />
                      <span style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: FONT_BODY }}>Add Tax</span>
                    </label>
                    {taxEnabled && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 23 }}>
                        <p style={{ ...lbl, marginBottom: 0, whiteSpace: "nowrap" }}>Tax rate</p>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="any"
                          style={{ ...inputStyle, width: 80, padding: "8px 10px", textAlign: "right" as const }}
                          value={taxPct}
                          onChange={(e) => setTaxPct(e.target.value)}
                          placeholder="e.g. 19 (VAT/USt/IVA/GST)"
                        />
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>%</span>
                      </div>
                    )}
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
                      Add tax presets in your profile settings to pick from a dropdown.
                    </p>
                  </>
                )}
              </div>

              <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 14px", lineHeight: 1.5 }}>
                Enter the flat fee. Use the breakdown below to show how the budget is allocated — for transparency only.
              </p>

              {/* Fee preview */}
              {form.rate && parseFloat(form.rate) > 0 && (
                (() => {
                  const net = parseFloat(form.rate) || 0;
                  const taxRate = effectiveTaxPct;
                  const taxRowLabel = effectiveTaxLabel ?? "Tax";
                  const taxAmt = Math.round(net * taxRate / 100 * 100) / 100;
                  const symLive = currencySym(form.currency);
                  const bookerPays = Math.round((net + taxAmt) * 100) / 100;
                  return (
                    <div style={{ marginBottom: 16, padding: "12px 14px", background: "var(--bg)", borderRadius: 8 }}>
                      <p style={{ ...lbl, marginBottom: 8 }}>Fee Preview</p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Total budget (net)</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{symLive}{net.toLocaleString()}</span>
                        </div>
                        {taxAmt > 0 && (
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{taxRowLabel} ({taxRate}%)</span>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>+{symLive}{taxAmt.toLocaleString()}</span>
                          </div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Booker pays</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{symLive}{bookerPays.toLocaleString()}</span>
                        </div>
                      </div>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0", lineHeight: 1.55 }}>
                        You are responsible for invoicing and local tax compliance. SQRZ does not collect or remit taxes on your behalf.
                      </p>
                    </div>
                  );
                })()
              )}

              {/* Message */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ ...lbl, marginBottom: 6 }}>Message (optional)</p>
                <textarea
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical" }}
                  value={form.message}
                  onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                  placeholder="Add a note to your proposal…"
                />
              </div>

              {fetcher.data?.error && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{fetcher.data.error}</p>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => {
                    const fd = new FormData();
                    fd.append("intent", "send_proposal");
                    fd.append("rate", form.rate);
                    fd.append("currency", form.currency);
                    fd.append("message", form.message);
                    if (effectiveTaxPct > 0) {
                      fd.append("tax_pct", String(effectiveTaxPct));
                      if (effectiveTaxLabel) fd.append("tax_label", effectiveTaxLabel);
                    }
                    if (latestProposal?.id) fd.append("existing_proposal_id", latestProposal.id);
                    fetcher.submit(fd, { method: "post" });
                  }}
                  disabled={fetcher.state !== "idle"}
                  style={{
                    flex: 1,
                    padding: "13px",
                    background: ACCENT,
                    color: "#111",
                    border: "none",
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: fetcher.state !== "idle" ? "default" : "pointer",
                    opacity: fetcher.state !== "idle" ? 0.7 : 1,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {fetcher.state !== "idle" ? "Sending…" : isRevise ? "Send Revised Proposal" : "Send Proposal"}
                </button>
                {isRevise && (
                  <button
                    onClick={() => setShowForm(false)}
                    style={{
                      padding: "13px 16px",
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      color: "var(--text-muted)",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: FONT_BODY,
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Decline request — only shown for member when status is still requested */}
      {(booking.status as string) === "requested" && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button
            onClick={() => {
              if (!window.confirm("Decline this booking request?")) return;
              const fd = new FormData();
              fd.append("intent", "decline_request");
              declineFetcher.submit(fd, { method: "post" });
            }}
            disabled={declineFetcher.state !== "idle"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: FONT_BODY, padding: "4px 0" }}
          >
            Decline Request
          </button>
        </div>
      )}

      {/* Negotiation history toggle — only shown when multiple versions exist */}
      {allProposals.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowHistory((h) => !h)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
              fontFamily: FONT_BODY,
            }}
          >
            {showHistory
              ? "Hide negotiation history ▲"
              : `View negotiation history (${allProposals.length} versions) ▼`}
          </button>
          {showHistory && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {allProposals.map((p) => (
                <div
                  key={p.id}
                  style={{
                    ...card,
                    marginBottom: 0,
                    borderColor: p.sent_by === "buyer" ? "rgba(96,165,250,0.25)" : "var(--border)",
                    background: p.sent_by === "buyer" ? "rgba(96,165,250,0.04)" : "var(--surface)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: p.sent_by === "buyer" ? "#60a5fa" : ACCENT, marginRight: 8 }}>
                        v{p.version ?? 1} · {p.sent_by === "buyer" ? "Buyer" : "You"}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                        {currencySym(p.currency)}{(p.rate ?? 0).toLocaleString()} {p.currency}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "capitalize" as const }}>
                      {p.status}
                    </span>
                  </div>
                  {p.message && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0", lineHeight: 1.5 }}>
                      {p.message}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}


// ─── Payment success banner ───────────────────────────────────────────────────

function PaymentSuccessBanner() {
  const [searchParams] = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || searchParams.get("payment") !== "success") return null;

  return (
    <div
      style={{
        background: "rgba(74,222,128,0.12)",
        border: "1px solid rgba(74,222,128,0.4)",
        borderRadius: 10,
        margin: "12px 24px",
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: FONT_BODY,
      }}
    >
      <span style={{ color: "#4ade80", fontSize: 14, fontWeight: 600 }}>
        ✓ Payment received — booking confirmed
      </span>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: "none", border: "none", color: "#4ade80", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 0 }}
      >
        ✕
      </button>
    </div>
  );
}

// ─── Guest view components ────────────────────────────────────────────────────

function GuestDetailsCard({ b, memberInfo }: { b: Booking; memberInfo?: MemberInfo }) {
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {(b.service as string) && (
          <div><p style={guestMetaLabel}>Service</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p></div>
        )}
        {(b.date_start as string) && !!(b.date_end && b.date_end !== b.date_start) ? (
          <>
            <div><p style={guestMetaLabel}>Start</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_start as string)}</p></div>
            <div><p style={guestMetaLabel}>End</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_end as string)}</p></div>
          </>
        ) : (b.date_start as string) ? (
          <div><p style={guestMetaLabel}>Date</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{formatDateTime(b.date_start as string)}</p></div>
        ) : null}
      </div>
      {!!(b.venue_address || b.venue_city || b.venue_zip || b.venue_country) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={{ ...guestMetaLabel, marginBottom: 14 }}>Location</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 16px" }}>
            {(b.venue_address as string) && (
              <div>
                <p style={guestMetaLabel}>Street</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_address as string}</p>
              </div>
            )}
            {(b.venue_city as string) && (
              <div>
                <p style={guestMetaLabel}>City</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_city as string}</p>
              </div>
            )}
            {(b.venue_zip as string) && (
              <div>
                <p style={guestMetaLabel}>ZIP</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_zip as string}</p>
              </div>
            )}
            {(b.venue_country as string) && (
              <div>
                <p style={guestMetaLabel}>Country</p>
                <p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue_country as string}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {(b.description as string | null) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{b.description as string}</p>
        </div>
      )}
      {memberInfo && (memberInfo.company_name || memberInfo.legal_form || memberInfo.vat_id || memberInfo.responsible_person) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Seller Information</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
            {(memberInfo.company_name || memberInfo.name) && (
              <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: 0 }}>{memberInfo.company_name ?? memberInfo.name}</p>
            )}
            {memberInfo.legal_form && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{memberInfo.legal_form}</p>
            )}
            {memberInfo.company_address && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{memberInfo.company_address}</p>
            )}
            {memberInfo.vat_id && (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>VAT: {memberInfo.vat_id}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GuestProposalCard({ proposal }: { proposal: Proposal }) {
  if (!proposal) {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No proposal has been sent yet.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: proposal.message ? 18 : 0 }}>
        {proposal.rate != null && (
          <div>
            <p style={guestMetaLabel}>Rate</p>
            <p style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: 0 }}>
              {proposal.rate} {proposal.currency ?? "EUR"}
            </p>
          </div>
        )}
        <div>
          <p style={guestMetaLabel}>Requirements</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            {[
              proposal.require_travel && "Travel",
              proposal.require_hotel && "Hotel",
              proposal.require_food && "Catering",
            ].filter(Boolean).join(" · ") || "None"}
          </p>
        </div>
      </div>
      {proposal.message && (
        <div style={{ paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message from artist</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{proposal.message}</p>
        </div>
      )}
    </div>
  );
}

function GuestBuyerProposalCard({
  proposal,
  bookingId,
  bookingToken,
  walletFeePct,
  proposalFeePct,
  memberEmail,
}: {
  proposal: Proposal;
  bookingId: string;
  bookingToken: string | null;
  walletFeePct?: number | null;
  proposalFeePct?: number | null;
  memberEmail?: string | null;
}) {
  const [loading, setLoading] = useState<"accept" | "counter" | "decline" | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterRate, setCounterRate] = useState(String(proposal?.rate ?? ""));
  const [counterCurrency, setCounterCurrency] = useState(proposal?.currency ?? "EUR");
  const [counterMessage, setCounterMessage] = useState("");
  const [declined, setDeclined] = useState(false);
  const [bookingConfirmed, setBookingConfirmed] = useState(false);

  if (!proposal) {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No proposal has been sent yet.</p>
      </div>
    );
  }

  if (declined || proposal.status === "declined") {
    return (
      <div style={{ ...card, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)" }}>
        <p style={{ color: "#ef4444", fontSize: 14, margin: 0, fontWeight: 600 }}>You declined this proposal.</p>
      </div>
    );
  }

  const isAccepted = bookingConfirmed || proposal.status === "accepted";
  const version = proposal.version ?? 1;
  const sym = currencySym(proposal.currency);
  const riderItems = [
    proposal.require_hotel && "Hotel",
    proposal.require_travel && "Travel",
    proposal.require_food && "Catering",
  ].filter(Boolean) as string[];

  const net = proposal.rate ?? 0;
  const taxRate = proposal.tax_pct ?? 0;
  const taxRowLabel = proposal.tax_label ?? "Tax";
  const taxAmt = taxRate > 0 ? Math.round(net * taxRate / 100 * 100) / 100 : 0;
  // SQRZ fee removed — total = net + tax.
  const totalCharged = Math.round((net + taxAmt) * 100) / 100;

  const proposalLineItems = proposal.line_items ?? [];
  const hasBreakdown = proposalLineItems.length > 0;

  const showActions = !isAccepted &&
    proposal.sent_by !== "buyer" &&
    (proposal.status === "sent" || proposal.status === "countered");

  async function proceedWithAccept() {
    setLoading("accept");
    setAcceptError(null);
    try {
      const res = await fetch("/api/proposal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, proposal_id: proposal!.id, invite_token: bookingToken }),
      });
      const json = await res.json();
      if (json.checkout_url) {
        window.location.href = json.checkout_url;
      } else if (json.confirmed) {
        setBookingConfirmed(true);
        setLoading(null);
        window.location.reload();
      } else {
        setAcceptError(json.error ?? "Something went wrong. Please try again.");
        setLoading(null);
      }
    } catch (err) {
      console.error("[accept]", err);
      setAcceptError("Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  async function handleCounter() {
    setLoading("counter");
    try {
      await fetch("/api/proposal/counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          proposal_id: proposal!.id,
          invite_token: bookingToken,
          rate: parseFloat(counterRate) || 0,
          currency: counterCurrency,
          message: counterMessage,
        }),
      });
      window.location.reload();
    } catch (err) {
      console.error("[counter]", err);
      setLoading(null);
    }
  }

  async function handleDecline() {
    if (!window.confirm("Are you sure? This will cancel the booking request.")) return;
    setLoading("decline");
    try {
      await fetch("/api/proposal/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, invite_token: bookingToken }),
      });
      setDeclined(true);
    } catch (err) {
      console.error("[decline]", err);
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      {/* Confirmed banner — shown without hiding the details below */}
      {isAccepted && proposal.requires_payment && (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)", marginBottom: 8 }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
            ✓ Payment received — booking confirmed
          </p>
        </div>
      )}
      {isAccepted && !proposal.requires_payment && (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)", marginBottom: 8 }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: "0 0 14px", fontWeight: 600 }}>✓ Booking accepted</p>
          <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 8px" }}>Payment information</p>
          <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 10px", lineHeight: 1.55 }}>
            This booking uses manual payment — not processed through SQRZ.<br />
            Contact the seller directly to arrange payment:
          </p>
          {memberEmail && (
            <a href={`mailto:${memberEmail}`} style={{ fontSize: 13, fontWeight: 600, color: ACCENT, textDecoration: "none", wordBreak: "break-all" }}>
              {memberEmail}
            </a>
          )}
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
            SQRZ is not responsible for payment disputes on manually managed bookings.
          </p>
        </div>
      )}

      {/* Proposal details card */}
      <div style={card}>
        {/* Rate breakdown */}
        {proposal.rate != null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>Your rate (net)</span>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
                {sym}{net.toLocaleString()}
                <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 5 }}>{proposal.currency ?? "EUR"}</span>
              </span>
            </div>

            {taxAmt > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{taxRowLabel} ({taxRate}%)</span>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>+{sym}{taxAmt.toLocaleString()}</span>
              </div>
            )}

            {proposal.requires_payment && totalCharged != null && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0 4px" }}>
                <span style={{ color: "var(--text)", fontSize: 14, fontWeight: 700 }}>Total charged</span>
                <span style={{ color: ACCENT, fontSize: 18, fontWeight: 800 }}>{sym}{totalCharged.toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        {proposal.requires_payment && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 4px", lineHeight: 1.55 }}>
            Stripe payment processing fees (typically 1.5–3%) are deducted from the payout and may vary by card type and country.
          </p>
        )}
        <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "6px 0 4px", lineHeight: 1.55 }}>
          The seller is responsible for invoicing and local tax compliance. SQRZ does not collect or remit taxes on their behalf.
        </p>

        {/* Optional breakdown (for transparency) */}
        {hasBreakdown && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", paddingBottom: 4 }}>
            <p style={{ ...guestMetaLabel, marginBottom: 8 }}>Breakdown (for transparency)</p>
            {proposalLineItems.map((item, idx) => (
              <div key={idx} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text)", fontSize: 13 }}>{item.label}</span>
                <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{sym}{(item.amount || 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}

        {/* FIX 5: Rider requirements as muted text rows */}
        {riderItems.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            {riderItems.map((item) => (
              <div key={item} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{item}</span>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Required</span>
              </div>
            ))}
          </div>
        )}

        {/* Message */}
        {proposal.message && (
          <div style={{ paddingTop: 14, borderTop: "1px solid var(--border)", marginTop: 8 }}>
            <p style={guestMetaLabel}>Message</p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>
              {proposal.message}
            </p>
          </div>
        )}

        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "12px 0 0" }}>
          Proposal v{version}
        </p>
        {proposal.requires_payment && proposal.stripe_mode === "test" && (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "rgba(245,166,35,0.08)", border: "1px solid rgba(245,166,35,0.28)" }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: ACCENT, margin: "0 0 3px" }}>Stripe Test Payment</p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              This acceptance button opens a Stripe sandbox checkout for rehearsal only. Use Stripe test card details.
            </p>
          </div>
        )}
      </div>

      {/* Waiting banner — buyer's own counter is pending */}
      {proposal.sent_by === "buyer" && !isAccepted && (
        <div style={{ ...card, background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.2)" }}>
          <p style={{ color: ACCENT, fontSize: 14, margin: 0, fontWeight: 600 }}>
            Your counter proposal has been sent — waiting for response
          </p>
        </div>
      )}

      {/* FIX 2: Action buttons — Accept button shows exact total */}
      {showActions && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={proceedWithAccept}
            disabled={loading !== null}
            style={{
              width: "100%",
              padding: "14px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: loading !== null ? "default" : "pointer",
              opacity: loading === "accept" ? 0.7 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            {loading === "accept"
              ? "Processing…"
              : net > 0
                ? `Accept — ${sym}${net.toLocaleString()} ${proposal.currency ?? "EUR"}`
                : "Accept"}
          </button>

          {acceptError && (
            <p style={{ fontSize: 13, color: "#ef4444", margin: 0, textAlign: "center" as const }}>
              {acceptError}
            </p>
          )}

          {counterOpen ? (
            <div style={card}>
              <p style={{ ...guestMetaLabel, marginBottom: 12 }}>Counter Proposal</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10, marginBottom: 10 }}>
                <input
                  type="number"
                  style={inputStyle}
                  placeholder="Your rate"
                  value={counterRate}
                  onChange={(e) => setCounterRate(e.target.value)}
                />
                <select
                  style={inputStyle}
                  value={counterCurrency}
                  onChange={(e) => setCounterCurrency(e.target.value)}
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                </select>
              </div>
              <textarea
                rows={3}
                style={{ ...inputStyle, resize: "vertical", marginBottom: 10 }}
                placeholder="Explain your counter offer…"
                value={counterMessage}
                onChange={(e) => setCounterMessage(e.target.value)}
              />
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={handleCounter}
                  disabled={loading !== null || !counterRate}
                  style={{
                    flex: 1,
                    padding: "11px",
                    background: "var(--surface-muted)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: loading !== null || !counterRate ? "default" : "pointer",
                    opacity: loading === "counter" ? 0.7 : 1,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {loading === "counter" ? "Sending…" : "Send Counter"}
                </button>
                <button
                  onClick={() => setCounterOpen(false)}
                  disabled={loading !== null}
                  style={{
                    padding: "11px 16px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    color: "var(--text-muted)",
                    fontSize: 13,
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCounterOpen(true)}
              disabled={loading !== null}
              style={{
                width: "100%",
                padding: "12px",
                background: "transparent",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: loading !== null ? "default" : "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              Counter Proposal
            </button>
          )}

          <button
            onClick={handleDecline}
            disabled={loading !== null}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: loading !== null ? "default" : "pointer",
              padding: "4px 0",
              fontFamily: FONT_BODY,
              opacity: loading === "decline" ? 0.7 : 1,
              textAlign: "center" as const,
            }}
          >
            {loading === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      )}
    </>
  );
}

// ─── Re-auth form ─────────────────────────────────────────────────────────────

function ReauthForm({ bookingId }: { bookingId: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      const { error: otpError } = await browserClient.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `https://dashboard.sqrz.com/booking/${bookingId}`,
        },
      });
      if (otpError) throw otpError;
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "80px auto", padding: "0 24px", textAlign: "center", fontFamily: FONT_BODY }}>
      <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
      <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Access this booking</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 28px", lineHeight: 1.6 }}>
        Enter your email to receive a sign-in link for this booking.
      </p>
      {sent ? (
        <div style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 12, padding: "16px 20px", color: "#4ade80", fontSize: 14 }}>
          Check your email — we sent you a sign-in link.
        </div>
      ) : (
        <form onSubmit={handleSend}>
          <input
            type="email" placeholder="your@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} required
            style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 15, boxSizing: "border-box" as const, marginBottom: 12, fontFamily: FONT_BODY }}
          />
          {error && <p style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 10 }}>{error}</p>}
          <button
            type="submit" disabled={loading}
            style={{ width: "100%", padding: "13px", background: ACCENT, color: "#111", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: FONT_BODY }}
          >
            {loading ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Buyer participant ────────────────────────────────────────────────────────

type BuyerParticipant = {
  name: string | null;
  email: string | null;
  phone: string | null;
  billing_company: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_country: string | null;
  billing_vat_id: string | null;
  billing_confirmed: boolean | null;
} | null;

// ─── Member view wrapper ──────────────────────────────────────────────────────

function MemberView({
  booking,
  wallet,
  planLevel,
  userEmail,
  senderName,
  messagingProvider,
  bookingToken,
  stripeConnectId,
  stripeConnectStatus,
  stripeConnectIdTest,
  stripeConnectStatusTest,
  taxPresets = [],
  memberInfo,
  proposalFeePct,
  proposal,
  buyerParticipant,
  showMobileOfficeBack = false,
  onMobileOfficeBack,
}: {
  booking: Booking;
  wallet: WalletData | null;
  planLevel: number;
  userEmail: string;
  senderName: string | null;
  messagingProvider: BookingMessagingProvider;
  bookingToken?: string | null;
  stripeConnectId: string | null;
  stripeConnectStatus: string | null;
  stripeConnectIdTest: string | null;
  stripeConnectStatusTest: string | null;
  taxPresets?: TaxPreset[];
  memberInfo?: MemberInfo;
  proposalFeePct?: number | null;
  proposal: Proposal | null;
  buyerParticipant: BuyerParticipant;
  showMobileOfficeBack?: boolean;
  onMobileOfficeBack?: () => void;
}) {
  const b = booking;
  const showProposal = ["requested", "pending"].includes(b.status as string);
  const showPayments = ["confirmed", "completed"].includes(b.status as string);

  const sections = [
    { id: "details",  label: "Details" },
    ...(showProposal ? [{ id: "proposal", label: "Proposal" }] : []),
    ...(showPayments ? [{ id: "payments", label: "Payments" }] : []),
  ];

  const [activeSection, setActiveSection] = useState(sections[0].id);

  useEffect(() => {
    const OFFSET = 120;
    function onScroll() {
      let current = sections[0].id;
      for (const { id } of sections) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= OFFSET) current = id;
      }
      setActiveSection(current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [b.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 116;
    window.scrollTo({ top, behavior: "smooth" });
  }

  return (
    <>
      {/* Sticky tab nav — first element, nothing above it */}
      <div style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--surface)",
        borderBottom: "0.5px solid var(--border)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 8,
        padding: "0 24px",
      }}>
        {showMobileOfficeBack && (
          <button
            onClick={onMobileOfficeBack}
            aria-label="Back to Office"
            style={{
              position: "absolute",
              left: 18,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              lineHeight: "22px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "14px 0",
              fontFamily: FONT_BODY,
            }}
          >
            ← Office
          </button>
        )}
        {sections.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => scrollToSection(id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeSection === id ? `2px solid ${ACCENT}` : "2px solid transparent",
              color: activeSection === id ? ACCENT : "var(--text-muted)",
              fontSize: 13,
              fontWeight: activeSection === id ? 700 : 500,
              padding: "14px 14px",
              cursor: "pointer",
              transition: "color 0.15s",
              fontFamily: FONT_BODY,
              lineHeight: "22px",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content — title + sections */}
      <div style={{ padding: "24px 24px 0", maxWidth: 720, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px", lineHeight: 1.3 }}>
            {(b.title as string) ?? (b.service as string) ?? "Booking"}
          </h1>
          {(b.title as string) && (b.service as string) && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 10px" }}>
              {b.service as string}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
            <StatusBadge status={(b.status as string) ?? "pending"} />
            {(b.city as string) && (
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city as string}</span>
            )}
            {(b.date_start as string) && (
              <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
                {new Date(b.date_start as string).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
          </div>
        </div>

        <DetailsSection booking={b} memberInfo={memberInfo} buyerParticipant={buyerParticipant} />

        {(b.status as string) === "cancelled" && (
          <div style={{ ...card, marginBottom: 16 }}>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>This booking was declined.</p>
          </div>
        )}

        {showProposal && (
          <ProposalSection
            booking={b}
            taxPresets={taxPresets}
          />
        )}

        {showPayments && wallet && (
          <BookingWallet
            wallet={wallet}
            bookingStatus={b.status as string}
            requiresPayment={proposal?.requires_payment ?? null}
          />
        )}
      </div>

      <BookingChat
        bookingId={b.id as string}
        currentUserEmail={userEmail}
        isOwner={true}
        messagingProvider={messagingProvider}
        bookingToken={bookingToken}
        senderName={senderName ?? undefined}
        participantName={buyerParticipant?.name ?? buyerParticipant?.email?.split("@")[0] ?? undefined}
      />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;
  const [searchParams] = useSearchParams();
  const fromOffice = searchParams.get("from") === "office";
  const [isStandalonePwa, setIsStandalonePwa] = useState(false);
  const [isMobileBookingNav, setIsMobileBookingNav] = useState(false);

  useEffect(() => {
    const compute = () => {
      const standalone = typeof window !== "undefined" && (
        window.matchMedia?.("(display-mode: standalone)")?.matches ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      );
      setIsStandalonePwa(Boolean(standalone));
    };

    compute();
    const media = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(display-mode: standalone)")
      : null;
    media?.addEventListener?.("change", compute);

    return () => {
      media?.removeEventListener?.("change", compute);
    };
  }, []);

  useEffect(() => {
    const media = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 767px)")
      : null;
    const compute = () => setIsMobileBookingNav(Boolean(media?.matches));

    compute();
    media?.addEventListener?.("change", compute);

    return () => {
      media?.removeEventListener?.("change", compute);
    };
  }, []);

  function goBackToOffice() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.href = "/office";
  }

  // ── Dark mode (mirrors _app.tsx — same key, same class) ────────────────────
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const saved = localStorage.getItem("sqrz_theme") as "dark" | "light" | null;
    const initial = saved ?? "dark";
    setTheme(initial);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(initial);
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sqrz_theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
  }
  const themeToggle = (
    <>
      {fromOffice && isStandalonePwa && !isMobileBookingNav && (
        <button
          onClick={goBackToOffice}
          aria-label="Back to Office"
          style={{
            position: "fixed",
            top: 16,
            left: 16,
            zIndex: 9999,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 999,
            boxShadow: "0 12px 30px rgba(0,0,0,0.16)",
          }}
        >
          ← Office
        </button>
      )}
      <button
        onClick={toggleTheme}
        aria-label="Toggle theme"
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 9999,
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 18,
          cursor: "pointer",
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          padding: 6,
        }}
      >
        {theme === "dark" ? "☀️" : "🌙"}
      </button>
    </>
  );

  // ── Invalid token ──────────────────────────────────────────────────────────
  if (data.accessType === "invalid_token") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 24px", textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔗</div>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Invalid or expired link</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>This booking link is no longer valid. Check your email for the correct link.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── No access ──────────────────────────────────────────────────────────────
  if (data.accessType === "no_access") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 24px", textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
            <h2 style={{ color: "var(--text)", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>You don't have access to this booking</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>You're signed in but you're not a participant in this booking.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Re-auth ────────────────────────────────────────────────────────────────
  if (data.accessType === "reauth") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: FONT_BODY }}>
        <ReauthForm bookingId={data.bookingId as string} />
      </div>
    );
  }

  const {
    booking,
    userEmail,
    isOwner,
    canManageBilling,
    accessType,
    role,
    proposal,
    bookingToken,
    wallet,
    planId,
    taxPresets,
    proposalFeePct,
    memberInfo,
    stripeConnectId,
    stripeConnectStatus,
    stripeConnectIdTest,
    stripeConnectStatusTest,
    senderName,
    memberEmail,
    buyerParticipant,
    messagingProvider,
  } = data as {
    booking: Booking;
    userEmail: string;
    isOwner: boolean;
    canManageBilling?: boolean;
    accessType: string;
    role: string;
    proposal: Proposal;
    bookingToken: string | null;
    wallet: WalletData | null;
    planId: number | null;
    taxPresets?: TaxPreset[];
    proposalFeePct?: number | null;
    memberInfo?: MemberInfo;
    stripeConnectId?: string | null;
    stripeConnectStatus?: string | null;
    stripeConnectIdTest?: string | null;
    stripeConnectStatusTest?: string | null;
    senderName: string | null;
    memberEmail?: string | null;
    buyerParticipant?: BuyerParticipant;
    messagingProvider: BookingMessagingProvider;
  };

  const b = booking;
  const planLevel = getPlanLevel(planId);

  // ── Owner / authenticated member (or billing delegate) — full rich UI ───────
  if (isOwner || canManageBilling) {
    return (
      <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
        {themeToggle}
        <PaymentSuccessBanner />
        <MemberView
          booking={b}
          wallet={wallet}
          planLevel={planLevel}
          userEmail={userEmail}
          senderName={senderName}
          messagingProvider={messagingProvider}
          bookingToken={bookingToken}
          stripeConnectId={stripeConnectId ?? null}
          stripeConnectStatus={stripeConnectStatus ?? null}
          stripeConnectIdTest={stripeConnectIdTest ?? null}
          stripeConnectStatusTest={stripeConnectStatusTest ?? null}
          taxPresets={taxPresets ?? []}
          memberInfo={memberInfo}
          proposalFeePct={proposalFeePct}
          proposal={proposal ?? null}
          buyerParticipant={buyerParticipant ?? null}
          showMobileOfficeBack={fromOffice && isStandalonePwa && isMobileBookingNav}
          onMobileOfficeBack={goBackToOffice}
        />
      </div>
    );
  }

  // ── Guest / participant — single scrollable page ───────────────────────────
  const isBuyer = role === "buyer";
  const bStatus = b.status as string;
  const isConfirmedOrCompleted = bStatus === "confirmed" || bStatus === "completed";

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
      {themeToggle}
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 24px 80px" }}>
        {!b ? (
          <p style={{ color: "var(--text-muted)", textAlign: "center" }}>Booking not found.</p>
        ) : (
          <>
            {/* 1. Booking header */}
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
                {(b.title as string) ?? (b.service as string) ?? "Booking"}
              </h1>
              {(b.title as string) && (b.service as string) && (
                <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 10px" }}>
                  {b.service as string}
                </p>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
                <StatusBadge status={bStatus ?? "pending"} />
                {(b.date_start as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📅 {formatDate(b.date_start as string)}</span>
                )}
                {(b.city as string) && (
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city as string}{b.venue ? `, ${b.venue as string}` : ""}</span>
                )}
              </div>
            </div>

            {/* 2. Booking details card (includes seller info) */}
            <GuestDetailsCard b={b} memberInfo={memberInfo} />

            {/* 3. Fee details + actions (buyer) */}
            {isBuyer && proposal && (
              <div style={{ marginTop: 8 }}>
                <SectionHeading>Details</SectionHeading>
                <GuestBuyerProposalCard
                  proposal={proposal}
                  bookingId={b.id as string}
                  bookingToken={bookingToken}
                  walletFeePct={(wallet as { sqrz_fee_pct?: number } | null)?.sqrz_fee_pct ?? null}
                  proposalFeePct={proposalFeePct ?? null}
                  memberEmail={memberEmail ?? null}
                />
              </div>
            )}

            {/* Non-buyer crew: read-only proposal */}
            {!isBuyer && proposal && <GuestProposalCard proposal={proposal} />}

            {/* 4. Confirmed status (buyer, when not already shown by GuestBuyerProposalCard) */}
            {isBuyer && isConfirmedOrCompleted && !proposal && (
              <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)", marginTop: 8 }}>
                <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
                  ✓ Your booking is confirmed
                  {(b.date_start as string) ? ` · ${formatDate(b.date_start as string)}` : ""}
                </p>
              </div>
            )}

          </>
        )}
      </div>

      {/* Chat bubble — works for both token buyers (anon) and authenticated participants */}
      <BookingChat
        bookingId={b.id as string}
        currentUserEmail={userEmail}
        isOwner={false}
        messagingProvider={messagingProvider}
        bookingToken={bookingToken}
        senderName={senderName ?? undefined}
        participantName={memberInfo?.company_name ?? memberInfo?.name ?? undefined}
      />
    </div>
  );
}
