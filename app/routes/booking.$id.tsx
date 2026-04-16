import React, { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/booking.$id";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel } from "~/lib/plans";
import { supabase as browserClient } from "~/lib/supabase.client";
import BookingWallet, { type WalletData } from "~/components/BookingWallet";
import BookingChat from "~/components/BookingChat";

// ─── Types ────────────────────────────────────────────────────────────────────

type Booking = Record<string, unknown>;

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
} | null;

type MemberInfo = {
  name: string | null;
  company_name: string | null;
  legal_form: string | null;
  vat_id: string | null;
  company_address: string | null;
  responsible_person: string | null;
} | null;


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
      ([p.first_name, p.last_name].filter(Boolean).join(" ") || null) ||
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
    const proposalFeePct: number = ownerPlanId === null ? 0 : ((ownerPlan?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 8);
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
        const { data: existingWallet } = await admin
          .from("booking_wallets")
          .select("*")
          .eq("booking_id", booking.id)
          .maybeSingle();

        let baseWallet = existingWallet;
        if (!baseWallet) {
          const firstProposal = (booking.booking_proposals ?? [])[0];
          const { data: newWallet } = await admin
            .from("booking_wallets")
            .insert({
              booking_id: booking.id,
              owner_profile_id: profile!.id,
              total_budget: firstProposal?.rate ?? 0,
              currency: firstProposal?.currency ?? "EUR",
              sqrz_fee_pct: 10,
              status: "pending",
            })
            .select("*")
            .single();
          baseWallet = newWallet ?? null;
        }
        if (baseWallet) {
          const { data: allocations } = await admin
            .from("wallet_allocations")
            .select("id, label, role, allocation_type, amount, currency, status, stripe_payment_link_url, paid_at, boost_campaign_id")
            .eq("wallet_id", baseWallet.id);
          wallet = { ...(baseWallet as WalletData), allocations: allocations ?? [] };
        }
      }
    } else {
      wallet = tokenWallet as WalletData | null;
    }

    const sortedProposals = ((booking.booking_proposals ?? []) as Array<NonNullable<Proposal>>)
      .slice()
      .sort((a: any, b: any) => ((b.version ?? 0) - (a.version ?? 0)));
    const proposal = sortedProposals[0] ?? null;

    // Load invoice + buyer participant for owner
    let tokenInvoice: Record<string, unknown> | null = null;
    let tokenBuyerParticipant: { name: string | null; email: string | null } | null = null;
    if (isOwner) {
      const profileId = profile!.id as string;
      const [{ data: inv }, { data: buyerP }] = await Promise.all([
        admin
          .from("invoices")
          .select("id, invoice_number, invoice_date, recipient_name, gross_amount, currency, status, pdf_source, pdf_url")
          .eq("booking_id", params.id)
          .eq("issuer_profile_id", profileId)
          .maybeSingle(),
        admin
          .from("booking_participants")
          .select("name, email")
          .eq("booking_id", params.id)
          .eq("role", "buyer")
          .maybeSingle(),
      ]);
      tokenInvoice = (inv as Record<string, unknown> | null) ?? null;
      tokenBuyerParticipant = buyerP ? { name: buyerP.name as string | null, email: buyerP.email as string | null } : null;
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
        profileId: (profile?.id as string) ?? null,
        planId: (profile?.plan_id as number | null) ?? null,
        isBeta: (profile?.is_beta as boolean) ?? false,
        proposalFeePct,
        memberInfo,
        stripeConnectId: (profile?.stripe_connect_id as string | null) ?? null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        memberEmail: (ownerPlan?.email as string | null) ?? null,
        invoice: tokenInvoice,
        buyerParticipant: tokenBuyerParticipant,
      },
      { headers }
    );
  }

  // ── TOKEN ONLY (no session) ────────────────────────────────────────────────
  if (tokenRow) {
    const booking = tokenRow.bookings as Booking;
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
    const proposalFeePct: number = ownerPlanId === null ? 0 : ((ownerPlan?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 8);
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
        profileId: null,
        planId: null,
        isBeta: false,
        senderName,
        memberEmail: (ownerPlan?.email as string | null) ?? null,
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

    if (!isOwner) {
      const isParticipant = (booking.booking_participants ?? []).some(
        (p: { user_id: string | null }) => p.user_id === user.id
      );
      if (!isParticipant) return Response.json({ accessType: "no_access" }, { headers });
    }

    // Wallet + allocations for owner on bookable statuses
    let wallet: WalletData | null = null;
    const showPaymentsTab = ["pending", "confirmed", "completed"].includes(booking.status);
    if (isOwner && showPaymentsTab) {
      const { data: existingWallet } = await admin
        .from("booking_wallets")
        .select("*")
        .eq("booking_id", booking.id)
        .maybeSingle();

      let baseWallet = existingWallet;
      if (!baseWallet) {
        const firstProposal = (booking.booking_proposals ?? [])[0];
        const { data: newWallet } = await admin
          .from("booking_wallets")
          .insert({
            booking_id: booking.id,
            owner_profile_id: profile!.id,
            total_budget: firstProposal?.rate ?? 0,
            currency: firstProposal?.currency ?? "EUR",
            sqrz_fee_pct: 10,
            status: "pending",
          })
          .select("*")
          .single();
        baseWallet = newWallet ?? null;
      }

      if (baseWallet) {
        const { data: allocations } = await admin
          .from("wallet_allocations")
          .select("id, label, role, allocation_type, amount, currency, status, stripe_payment_link_url, paid_at, boost_campaign_id")
          .eq("wallet_id", baseWallet.id);
        wallet = { ...(baseWallet as WalletData), allocations: allocations ?? [] };
      }
    }

    const sortedProposals = ((booking.booking_proposals ?? []) as Array<NonNullable<Proposal>>)
      .slice()
      .sort((a: any, b: any) => ((b.version ?? 0) - (a.version ?? 0)));
    const proposal = sortedProposals[0] ?? null;

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
      sessionProposalFeePct = ownerPlanIdSess === null ? 0 : ((ownerPlanSess?.plans as { booking_fee_pct?: number } | null)?.booking_fee_pct ?? 8);
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

    // Load invoice + buyer participant for owner
    let sessionInvoice: Record<string, unknown> | null = null;
    let sessionBuyerParticipant: { name: string | null; email: string | null } | null = null;
    if (isOwner && profile) {
      const profileId = profile.id as string;
      const [{ data: inv }, { data: buyerP }] = await Promise.all([
        admin
          .from("invoices")
          .select("id, invoice_number, invoice_date, recipient_name, gross_amount, currency, status, pdf_source, pdf_url")
          .eq("booking_id", params.id)
          .eq("issuer_profile_id", profileId)
          .maybeSingle(),
        admin
          .from("booking_participants")
          .select("name, email")
          .eq("booking_id", params.id)
          .eq("role", "buyer")
          .maybeSingle(),
      ]);
      sessionInvoice = (inv as Record<string, unknown> | null) ?? null;
      sessionBuyerParticipant = buyerP ? { name: buyerP.name as string | null, email: buyerP.email as string | null } : null;
    }

    return Response.json(
      {
        accessType: "authenticated",
        booking,
        participant: null,
        role: isOwner ? "owner" : "member",
        userEmail: (profile?.email as string) ?? user.email ?? "",
        isOwner,
        proposal: proposal ?? null,
        bookingToken: null,
        wallet,
        profileId: (profile?.id as string) ?? null,
        planId: (profile?.plan_id as number | null) ?? null,
        isBeta: (profile?.is_beta as boolean) ?? false,
        proposalFeePct: sessionProposalFeePct,
        memberInfo: sessionMemberInfo,
        memberEmail: sessionMemberEmail,
        stripeConnectId: (profile?.stripe_connect_id as string | null) ?? null,
        senderName: profileSenderName(profile as Record<string, unknown> | null),
        invoice: sessionInvoice,
        buyerParticipant: sessionBuyerParticipant,
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
  const bookingToken = formData.get("bookingToken") as string | null;

  // Token-based: guest confirm / decline
  if ((intent === "confirm_booking" || intent === "decline_booking") && bookingToken) {
    const admin = createSupabaseAdminClient();
    const { data: participant } = await admin
      .from("booking_participants")
      .select("role")
      .eq("booking_id", params.id)
      .eq("invite_token", bookingToken)
      .maybeSingle();

    if (!participant) return Response.json({ error: "Unauthorized" }, { headers, status: 403 });

    const newStatus = intent === "confirm_booking" ? "confirmed" : "archived";
    const { error } = await admin.from("bookings").update({ status: newStatus }).eq("id", params.id);
    return Response.json({ ok: !error }, { headers });
  }

  // Session-based: all member / owner intents
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { headers, status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  // Session confirm / decline (no token)
  if (intent === "confirm_booking" || intent === "decline_booking") {
    const newStatus = intent === "confirm_booking" ? "confirmed" : "requested";
    const { error } = await supabase.from("bookings").update({ status: newStatus }).eq("id", params.id);
    return Response.json({ ok: !error }, { headers });
  }

  // All intents below require ownership
  const { data: bkCheck } = await supabase
    .from("bookings")
    .select("owner_id")
    .eq("id", params.id)
    .single();

  if (!bkCheck || bkCheck.owner_id !== profile.id) {
    return Response.json({ error: "Unauthorized" }, { headers, status: 403 });
  }

  if (intent === "update_status") {
    const status = formData.get("status") as string;
    await supabase.from("bookings").update({ status }).eq("id", params.id).eq("owner_id", profile.id as string);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "update_show_label") {
    const { error } = await supabase
      .from("bookings")
      .update({ show_label: formData.get("show_label") === "true" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "send_proposal") {
    const rateRaw = parseFloat(formData.get("rate") as string) || null;
    const currency = (formData.get("currency") as string) || "EUR";
    const message = (formData.get("message") as string) || "";
    const requireHotel = formData.get("require_hotel") === "true";
    const requireTravel = formData.get("require_travel") === "true";
    const requireFood = formData.get("require_food") === "true";
    const requiresPayment = formData.get("requires_payment") === "true";
    const existingProposalId = (formData.get("existing_proposal_id") as string) || null;
    const lineItemsRaw = (formData.get("line_items") as string) || null;
    const taxPctRaw = formData.get("tax_pct") as string | null;
    const taxPct = taxPctRaw ? (parseFloat(taxPctRaw) || null) : null;

    let lineItems: LineItem[] | null = null;
    const rate = rateRaw;
    try {
      if (lineItemsRaw) {
        lineItems = JSON.parse(lineItemsRaw) as LineItem[];
      }
    } catch { /* ignore parse error */ }

    const admin = createSupabaseAdminClient();

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

    const { data: insertData, error: insertError } = await admin
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
      })
      .select();

    console.log("[proposal insert] error:", insertError);
    console.log("[proposal insert] data:", insertData);

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

  if (intent === "invite_team_member") {
    const name  = ((formData.get("name")  as string) ?? "").trim();
    const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
    const role  = ((formData.get("role")  as string) ?? "").trim();
    const pay   = parseFloat(formData.get("pay") as string) || null;

    if (!email.includes("@")) return Response.json({ error: "Invalid email" }, { status: 400, headers });

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    let guestProfileId: string | null = existing?.id ?? null;
    if (!guestProfileId) {
      const { data: newProfile } = await supabase
        .from("profiles")
        .insert({ email, name, user_type: "guest", is_published: false, created_by: "team_invite" })
        .select("id")
        .single();
      guestProfileId = newProfile?.id ?? null;
    }

    const inviteToken = crypto.randomUUID();
    const { data: participant, error: participantError } = await supabase
      .from("booking_participants")
      .insert({ booking_id: params.id, user_id: null, name, email, role, pay, is_admin: false, invite_token: inviteToken })
      .select()
      .single();

    if (participantError) return Response.json({ error: participantError.message }, { status: 500, headers });
    console.log("[invite] participant:", participant?.id);

    try {
      const admin = createSupabaseAdminClient();
      const next = encodeURIComponent(`/booking/${params.id}?token=${inviteToken}`);
      const redirectTo = `https://dashboard.sqrz.com/auth/callback?next=${next}`;
      const { data: linkData } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: email,
        subject: "You've been invited to a booking",
        html: `<p>Hi ${name},</p><p>You've been invited to collaborate on a booking.</p><p><a href="${linkData?.properties?.action_link}">Click here to access the booking</a></p><p>The SQRZ Team</p>`,
      });
    } catch (err) {
      console.error("[invite] email send failed:", err);
    }

    return Response.json({ ok: true, invited: email }, { headers });
  }

  if (intent === "mark_as_paid") {
    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
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
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_save_costs") {
    const transport = parseFloat(formData.get("transport") as string) || 0;
    const hotel     = parseFloat(formData.get("hotel")     as string) || 0;
    const food      = parseFloat(formData.get("food")      as string) || 0;
    const admin = createSupabaseAdminClient();
    await admin
      .from("booking_wallets")
      .update({ notes: JSON.stringify({ transport, hotel, food }) })
      .eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "wallet_mark_paid") {
    const admin = createSupabaseAdminClient();
    await admin.from("booking_wallets").update({ client_paid: true }).eq("booking_id", params.id);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_expense") {
    const walletId  = formData.get("wallet_id") as string;
    const expLabel  = formData.get("expense_label") as string;
    const expAmount = parseFloat(formData.get("expense_amount") as string) || 0;
    const currency  = formData.get("currency") as string;
    const admin = createSupabaseAdminClient();
    await admin.from("wallet_allocations").insert({
      wallet_id: walletId,
      participant_id: null,
      role: expLabel,
      amount: expAmount,
      currency,
      status: "pending",
    });
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_wallet_allocation") {
    const walletId       = formData.get("wallet_id") as string;
    const allocationType = formData.get("allocation_type") as string;
    const allocLabel     = formData.get("label") as string;
    const allocAmount    = parseFloat(formData.get("amount") as string) || 0;
    const currency       = formData.get("currency") as string;
    const admin = createSupabaseAdminClient();
    await admin.from("wallet_allocations").insert({
      wallet_id: walletId,
      allocation_type: allocationType,
      label: allocLabel,
      role: allocLabel,
      amount: allocAmount,
      currency,
      status: "pending",
    });
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

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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
      success_url: `https://dashboard.sqrz.com/booking/${params.id}?payment=success`,
      cancel_url: `https://dashboard.sqrz.com/booking/${params.id}?token=${buyer.invite_token ?? ""}`,
      customer_email: buyer.email,
      metadata: {
        booking_id: params.id,
        wallet_allocation_id: allocationId,
        booking_type: "allocation_payment",
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
  requested: { bg: "rgba(245,166,35,0.12)", text: ACCENT },
  pending:   { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed: { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
  archived:  { bg: "var(--surface-muted)",  text: "var(--text-muted)" },
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

function DetailsSection({ booking, memberInfo }: { booking: Booking; memberInfo?: MemberInfo }) {
  const b = booking;

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: b.service ? 14 : 0 }}>
          <StatusBadge status={(b.status as string) ?? "pending"} />
        </div>
        {b.service && (
          <div>
            <p style={lbl}>Service</p>
            <p style={val}>{b.service as string}</p>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <p style={lbl}>Start date</p>
            <p style={val}>{formatDate(b.date_start as string | null)}</p>
          </div>
          {b.date_end && b.date_end !== b.date_start && (
            <div>
              <p style={lbl}>End date</p>
              <p style={val}>{formatDate(b.date_end as string | null)}</p>
            </div>
          )}
        </div>
      </div>

      {(b.city || b.venue || b.address) && (
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: b.address ? 14 : 0 }}>
            {b.venue && (
              <div>
                <p style={lbl}>Venue</p>
                <p style={val}>{b.venue as string}</p>
              </div>
            )}
            {b.city && (
              <div>
                <p style={lbl}>City</p>
                <p style={val}>{b.city as string}</p>
              </div>
            )}
          </div>
          {b.address && (
            <div>
              <p style={lbl}>Address</p>
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{b.address as string}</p>
            </div>
          )}
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
  planLevel,
  stripeConnectId,
  proposalFeePct,
}: {
  booking: Booking;
  planLevel: number;
  stripeConnectId: string | null;
  proposalFeePct?: number | null;
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
    require_travel: latestProposal?.require_travel ?? false,
    require_hotel: latestProposal?.require_hotel ?? false,
    require_food: latestProposal?.require_food ?? false,
    requires_payment: latestProposal?.requires_payment ?? (planLevel >= 1 && !!stripeConnectId),
  });

  const [taxEnabled, setTaxEnabled] = useState(!!(latestProposal?.tax_pct));
  const [taxPct, setTaxPct] = useState(String(latestProposal?.tax_pct ?? ""));

  const [lineItems, setLineItems] = useState<LineItem[]>(() => {
    const existing = latestProposal?.line_items;
    if (existing?.length) return existing;
    return [{ label: "", amount: 0 }];
  });

  const sent = fetcher.state === "idle" && fetcher.data?.ok;
  const canUseStripe = planLevel >= 1;
  const hasConnect = !!stripeConnectId;
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
                const feePct2 = proposalFeePct ?? 8;
                const feeAmt2 = Math.round(net * feePct2 / 100 * 100) / 100;
                const bookerPays2 = Math.round((net + tAmt + feeAmt2) * 100) / 100;
                // You receive gross = net + tax - SQRZ fee (tax collected from buyer, remitted to authority)
                const youReceiveGross2 = Math.round((net + tAmt - feeAmt2) * 100) / 100;
                const yourNetIncome2 = Math.round((net - feeAmt2) * 100) / 100;
                const symP = currencySym(p.currency);
                const lineItemsP = p.line_items ?? [];
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
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>SQRZ fee ({feePct2}% of net)</span>
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>+{symP}{feeAmt2.toLocaleString()}</span>
                      </div>
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
                    {lineItemsP.length > 0 && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                        <p style={{ ...lbl, marginBottom: 6 }}>Breakdown (for transparency)</p>
                        {lineItemsP.map((item, idx) => (
                          <div key={idx} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{item.label}</span>
                            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{symP}{(item.amount || 0).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {p.message && (
                      <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: "12px 0 0", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                        {p.message}
                      </p>
                    )}
                    {[p.require_hotel && "Hotel", p.require_travel && "Travel", p.require_food && "Catering"].filter(Boolean).length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        {[p.require_hotel && "Hotel", p.require_travel && "Travel", p.require_food && "Catering"].filter(Boolean).map((r) => (
                          <div key={r as string} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{r}</span>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Required</span>
                          </div>
                        ))}
                      </div>
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

              {/* Tax toggle */}
              <div style={{ marginBottom: 14 }}>
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
              </div>

              <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 14px", lineHeight: 1.5 }}>
                Enter the flat fee. Use the breakdown below to show how the budget is allocated — for transparency only.
              </p>

              {/* Fee Breakdown */}
              <div style={{ marginBottom: 16 }}>
                <p style={{ ...lbl, marginBottom: 8 }}>Breakdown (optional)</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {lineItems.map((item, idx) => (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 90px 32px", gap: 7, alignItems: "center" }}>
                      <input
                        type="text"
                        value={item.label}
                        onChange={(e) => {
                          const next = [...lineItems];
                          next[idx] = { ...item, label: e.target.value };
                          setLineItems(next);
                        }}
                        placeholder="e.g. Artist fee, Transport, Crew, Tax…"
                        style={{ ...inputStyle, padding: "8px 10px" }}
                      />
                      <input
                        type="number"
                        min={0}
                        value={item.amount || ""}
                        onChange={(e) => {
                          const next = [...lineItems];
                          next[idx] = { ...item, amount: parseFloat(e.target.value) || 0 };
                          setLineItems(next);
                        }}
                        placeholder="0"
                        style={{ ...inputStyle, padding: "8px 10px", textAlign: "right" as const }}
                      />
                      <button
                        type="button"
                        onClick={() => setLineItems(lineItems.filter((_, i) => i !== idx))}
                        style={{
                          background: "none",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          color: "var(--text-muted)",
                          fontSize: 14,
                          cursor: "pointer",
                          padding: "6px 8px",
                          lineHeight: 1,
                          fontFamily: FONT_BODY,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setLineItems([...lineItems, { label: "", amount: 0 }])}
                  style={{
                    marginTop: 7,
                    background: "none",
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                    color: "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "7px 12px",
                    fontFamily: FONT_BODY,
                    width: "100%",
                  }}
                >
                  + Add Line Item
                </button>
                <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "8px 0 0", lineHeight: 1.5 }}>
                  These are shown to the client for transparency. You are responsible for all crew and expense payments.
                </p>
                {form.rate && parseFloat(form.rate) > 0 && (
                  <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--bg)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                    {(() => {
                      const rate = parseFloat(form.rate) || 0;
                      const breakdownTotal = lineItems.reduce((s, i) => s + (i.amount || 0), 0);
                      const unallocated = rate - breakdownTotal;
                      const symLive = currencySym(form.currency);
                      return (
                        <>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Total budget</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{symLive}{rate.toLocaleString()}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Breakdown total</span>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{symLive}{breakdownTotal.toLocaleString()}</span>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Unallocated</span>
                            <span style={{ fontSize: 12, color: unallocated < 0 ? "#ef4444" : "var(--text-muted)" }}>{symLive}{Math.abs(unallocated).toLocaleString()}</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Fee preview */}
              {form.rate && parseFloat(form.rate) > 0 && (
                (() => {
                  const net = parseFloat(form.rate) || 0;
                  const taxRate = taxEnabled ? (parseFloat(taxPct) || 0) : 0;
                  const taxAmt = Math.round(net * taxRate / 100 * 100) / 100;
                  const symLive = currencySym(form.currency);
                  // We don't know feePct here (server side), use a placeholder if not available
                  // We'll show the breakdown with SQRZ fee only if we have a plan level >= 1
                  const feeAmt = canUseStripe ? Math.round(net * 8 / 100 * 100) / 100 : 0;
                  const bookerPays = Math.round((net + taxAmt + feeAmt) * 100) / 100;
                  // Gross received = net + tax - SQRZ fee (tax collected, not kept)
                  const youReceiveGross = Math.round((net + taxAmt - feeAmt) * 100) / 100;
                  const yourNetIncome = Math.round((net - feeAmt) * 100) / 100;
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
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Tax ({taxRate}%)</span>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>+{symLive}{taxAmt.toLocaleString()}</span>
                          </div>
                        )}
                        {canUseStripe && (
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>SQRZ fee (8% of net)</span>
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>+{symLive}{feeAmt.toLocaleString()}</span>
                          </div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Booker pays</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{symLive}{bookerPays.toLocaleString()}</span>
                        </div>
                        {canUseStripe && (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", borderTop: taxAmt > 0 ? "none" : undefined }}>
                              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>You receive gross (before Stripe fees)</span>
                              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{symLive}{youReceiveGross.toLocaleString()}</span>
                            </div>
                            {taxAmt > 0 && (
                              <>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>of which tax ({taxRate}%) — remit to authority</span>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>−{symLive}{taxAmt.toLocaleString()}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Your net income</span>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{symLive}{yourNetIncome.toLocaleString()}</span>
                                </div>
                              </>
                            )}
                          </>
                        )}
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

              {/* Rider checkboxes */}
              <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                {(
                  [
                    { key: "require_travel", label: "Require Travel" },
                    { key: "require_hotel", label: "Require Hotel" },
                    { key: "require_food", label: "Require Food" },
                  ] as const
                ).map(({ key, label: lbl2 }) => (
                  <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                      style={{ accentColor: ACCENT, width: 15, height: 15 }}
                    />
                    {lbl2}
                  </label>
                ))}
              </div>

              {/* Payment toggle */}
              {canUseStripe && hasConnect ? (
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!form.requires_payment}
                      onChange={(e) => setForm((f) => ({ ...f, requires_payment: !e.target.checked }))}
                      style={{ accentColor: ACCENT, width: 15, height: 15, marginTop: 2, flexShrink: 0 }}
                    />
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Handle payment manually instead</p>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>Buyer won't receive a Stripe payment link</p>
                    </div>
                  </label>
                  {!form.requires_payment && (
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, marginLeft: 25, background: "var(--surface-muted)", borderRadius: 8, padding: "8px 10px" }}>
                      ⚠️ Manual payments are not covered by SQRZ wallet protection. Funds won't be held in escrow.
                    </p>
                  )}
                </div>
              ) : !canUseStripe ? (
                <>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px", lineHeight: 1.55 }}>
                    After your client accepts, share your email or payment details with them directly. SQRZ does not process payments on free plans.
                  </p>
                  <div style={{ background: "rgba(245,166,35,0.08)", border: "1px solid rgba(245,166,35,0.3)", borderRadius: 10, padding: "12px 14px", marginBottom: 20 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: "0 0 4px" }}>💳 Get paid directly through SQRZ</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 10px" }}>Collect payment securely via Stripe — funds held in escrow until delivery.</p>
                    <a href="https://dashboard.sqrz.com/account?upgrade=true" style={{ fontSize: 12, fontWeight: 600, color: ACCENT, textDecoration: "none" }}>Upgrade to Creator →</a>
                  </div>
                </>
              ) : null}

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
                    fd.append("require_hotel", String(form.require_hotel));
                    fd.append("require_travel", String(form.require_travel));
                    fd.append("require_food", String(form.require_food));
                    fd.append("requires_payment", String(form.requires_payment));
                    fd.append("line_items", JSON.stringify(lineItems.filter((i) => i.label && i.amount > 0)));
                    if (taxEnabled && taxPct) fd.append("tax_pct", taxPct);
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
              fd.append("intent", "update_status");
              fd.append("status", "archived");
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

function ActionsSection({ booking, wallet }: { booking: Booking; wallet?: WalletData | null }) {
  const fetcher = useFetcher();

  function submitStatus(status: string) {
    const fd = new FormData();
    fd.append("intent", "update_status");
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  function submitMarkDelivered() {
    const fd = new FormData();
    fd.append("intent", "mark_as_delivered");
    fetcher.submit(fd, { method: "post" });
  }

  const isRequested = booking.status === "requested";
  const isConfirmed = booking.status === "confirmed";
  const clientPaid = wallet?.client_paid === true;

  const actionLink: React.CSSProperties = {
    background: "none",
    border: "none",
    color: ACCENT,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "10px 0",
    fontFamily: FONT_BODY,
    textAlign: "left",
    display: "block",
    width: "100%",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <section id="actions" style={{ paddingBottom: 80 }}>
      <SectionHeading>Actions</SectionHeading>
      <div style={card}>
        {isRequested ? (
          <>
            <button
              style={actionLink}
              onClick={() => {
                const el = document.getElementById("proposal");
                if (!el) return;
                const top = el.getBoundingClientRect().top + window.scrollY - 120;
                window.scrollTo({ top, behavior: "smooth" });
              }}
            >
              Send Proposal →
            </button>
            <button
              style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
              onClick={() => submitStatus("archived")}
              disabled={fetcher.state !== "idle"}
            >
              Decline Request
            </button>
          </>
        ) : (
          <>
            {isConfirmed && clientPaid && (
              <button
                style={actionLink}
                onClick={submitMarkDelivered}
                disabled={fetcher.state !== "idle"}
              >
                Mark as Delivered ✓
              </button>
            )}
            {booking.status !== "confirmed" && (
              <button style={actionLink} onClick={() => submitStatus("confirmed")} disabled={fetcher.state !== "idle"}>
                Mark Confirmed
              </button>
            )}
            {booking.status !== "completed" && !(isConfirmed && clientPaid) && (
              <button
                style={{ ...actionLink, borderBottom: booking.status !== "archived" ? undefined : "none" }}
                onClick={() => submitStatus("completed")}
                disabled={fetcher.state !== "idle"}
              >
                Mark Completed
              </button>
            )}
            {booking.status !== "archived" && (
              <button
                style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
                onClick={() => submitStatus("archived")}
                disabled={fetcher.state !== "idle"}
              >
                Archive
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ─── Guest view components ────────────────────────────────────────────────────

function GuestDetailsCard({ b }: { b: Booking }) {
  return (
    <div style={card}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {(b.service as string) && (
          <div><p style={guestMetaLabel}>Service</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.service as string}</p></div>
        )}
        {(b.venue as string) && (
          <div><p style={guestMetaLabel}>Venue</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.venue as string}</p></div>
        )}
        {(b.city as string) && (
          <div><p style={guestMetaLabel}>City</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.city as string}</p></div>
        )}
        {(b.address as string) && (
          <div><p style={guestMetaLabel}>Address</p><p style={{ color: "var(--text)", fontSize: 14, margin: 0 }}>{b.address as string}</p></div>
        )}
      </div>
      {(b.description as string | null) && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <p style={guestMetaLabel}>Message</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: 0 }}>{b.description as string}</p>
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

  // Fee: prefer wallet-locked pct (post-payment), then plan pct (pre-payment)
  const feePct: number | null = walletFeePct ?? proposalFeePct ?? null;
  const net = proposal.rate ?? 0;
  const taxRate = proposal.tax_pct ?? 0;
  const taxAmt = taxRate > 0 ? Math.round(net * taxRate / 100 * 100) / 100 : 0;
  // SQRZ fee is calculated on NET only (before tax)
  const sqrzFee = feePct != null ? Math.round(net * (feePct / 100) * 100) / 100 : null;
  const totalCharged = sqrzFee != null ? Math.round((net + taxAmt + sqrzFee) * 100) / 100 : null;

  const proposalLineItems = proposal.line_items ?? [];
  const hasBreakdown = proposalLineItems.length > 0;

  const showActions = !isAccepted &&
    proposal.sent_by !== "buyer" &&
    (proposal.status === "sent" || proposal.status === "countered");

  async function handleAccept() {
    setLoading("accept");
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
      }
    } catch (err) {
      console.error("[accept]", err);
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
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Tax ({taxRate}%)</span>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>+{sym}{taxAmt.toLocaleString()}</span>
              </div>
            )}

            {proposal.requires_payment && feePct != null && feePct > 0 && sqrzFee != null && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>SQRZ fee ({feePct}% of net)</span>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>+{sym}{sqrzFee.toLocaleString()}</span>
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
            onClick={handleAccept}
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
              : proposal.requires_payment
                ? totalCharged != null
                  ? `Accept & Pay ${sym}${totalCharged.toLocaleString()}`
                  : "Accept & Pay"
                : net > 0
                  ? `Accept — ${sym}${net.toLocaleString()} ${proposal.currency ?? "EUR"}`
                  : "Accept"}
          </button>

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

function GuestActionsCard({ bookingToken, status }: { bookingId: string; bookingToken: string | null; status: string }) {
  const fetcher = useFetcher();
  const isPending = fetcher.state !== "idle";
  const withdrawn = (fetcher.data as { ok?: boolean } | undefined)?.ok &&
    fetcher.formData?.get("intent") === "decline_booking";

  if (withdrawn || status === "archived") {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>Your booking request has been withdrawn.</p>
      </div>
    );
  }

  if (status !== "requested") {
    return (
      <div style={card}>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
          No actions available at this stage.
        </p>
      </div>
    );
  }

  return (
    <div style={card}>
      <fetcher.Form method="post">
        <input type="hidden" name="bookingToken" value={bookingToken ?? ""} />
        <button
          name="intent"
          value="decline_booking"
          disabled={isPending}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 13,
            cursor: isPending ? "default" : "pointer",
            padding: 0,
            fontFamily: FONT_BODY,
          }}
        >
          {isPending ? "Withdrawing…" : "Withdraw request"}
        </button>
      </fetcher.Form>
    </div>
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

// ─── Invoice section ──────────────────────────────────────────────────────────

type InvoiceRecord = {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  recipient_name: string | null;
  gross_amount: number | null;
  currency: string | null;
  status: string | null;
  pdf_source: string | null;
  pdf_url: string | null;
};

type BuyerParticipant = { name: string | null; email: string | null } | null;

const INVOICE_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft:   { bg: "var(--surface-muted)", text: "var(--text-muted)" },
  sent:    { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  paid:    { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  void:    { bg: "rgba(239,68,68,0.10)", text: "#f87171" },
};

function InvoiceStatusBadge({ status }: { status: string | null }) {
  const s = status ?? "draft";
  const c = INVOICE_STATUS_COLORS[s] ?? INVOICE_STATUS_COLORS.draft;
  return (
    <span style={{
      display: "inline-block", padding: "2px 9px", borderRadius: 6,
      fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const,
      letterSpacing: "0.05em", background: c.bg, color: c.text,
    }}>
      {s}
    </span>
  );
}

// Slide-over overlay wrapper
function SlideOver({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", justifyContent: "flex-end" }}>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }}
      />
      {/* Panel */}
      <div style={{
        position: "relative",
        width: "100%",
        maxWidth: 440,
        height: "100%",
        background: "var(--surface)",
        boxShadow: "-4px 0 32px rgba(0,0,0,0.3)",
        overflowY: "auto" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontFamily: FONT_BODY,
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 20px", borderBottom: "1px solid var(--border)",
          position: "sticky", top: 0, background: "var(--surface)", zIndex: 10,
        }}>
          <h3 style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 800, color: ACCENT, textTransform: "uppercase" as const, margin: 0, letterSpacing: "0.04em" }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: "0 2px" }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "20px", flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function GenerateInvoiceSlideOver({
  open,
  onClose,
  bookingId,
  planId,
  buyerParticipant,
}: {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  planId: number | null;
  buyerParticipant: BuyerParticipant;
}) {
  const isPaidUser = planId === 1 || planId === 5;
  const today = new Date().toISOString().split("T")[0];

  const [form, setForm] = useState({
    invoice_number: "",
    invoice_date: today,
    due_date: "",
    recipient_name: buyerParticipant?.name ?? "",
    recipient_email: buyerParticipant?.email ?? "",
    recipient_address: "",
    recipient_city: "",
    recipient_country: "",
    recipient_vat_id: "",
    notes: "",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stripe payment state for free users
  const [paymentStep, setPaymentStep] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeInstance, setStripeInstance] = useState<Record<string, unknown> | null>(null);
  const [cardElement, setCardElement] = useState<Record<string, unknown> | null>(null);
  const [cardMounted, setCardMounted] = useState(false);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);

  // Mount Stripe card element when entering payment step
  useEffect(() => {
    if (!paymentStep || !clientSecret || !cardRef.current || cardMounted) return;
    const stripeKey = (
      typeof window !== "undefined"
        ? (window as unknown as Record<string, string>).__STRIPE_PK__ ?? ""
        : ""
    );
    if (!stripeKey || typeof (window as unknown as Record<string, unknown>).Stripe !== "function") return;

    const strp = (window as unknown as Record<string, unknown>).Stripe as (key: string) => Record<string, unknown>;
    const instance = strp(stripeKey);
    setStripeInstance(instance);

    const elements = (instance.elements as (opts: Record<string, unknown>) => Record<string, unknown>)({ clientSecret });
    const card = (elements.create as (type: string, opts: Record<string, unknown>) => Record<string, unknown>)("card", {
      style: {
        base: { fontSize: "15px", color: "var(--text)", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
      },
    });
    (card.mount as (el: HTMLDivElement) => void)(cardRef.current);
    setCardElement(card);
    setCardMounted(true);

    return () => {
      (card.unmount as () => void)();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentStep, clientSecret, cardMounted]);

  async function handleFreeUserSubmit() {
    if (!isPaidUser && !paymentStep) {
      // Step 1: create payment intent
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/invoices/payment-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ booking_id: bookingId }),
        });
        const json = (await res.json()) as { client_secret?: string; error?: string };
        if (!res.ok || !json.client_secret) throw new Error(json.error ?? "Payment setup failed");

        // Extract PI id from client_secret: "pi_xxx_secret_yyy" → "pi_xxx"
        const piId = json.client_secret.split("_secret_")[0];
        setClientSecret(json.client_secret);
        setPaymentIntentId(piId);
        setPaymentStep(true);
        setCardMounted(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!isPaidUser && paymentStep) {
      // Step 2: confirm card payment
      if (!stripeInstance || !cardElement || !clientSecret) {
        setError("Stripe not initialized");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await (stripeInstance.confirmCardPayment as (secret: string, opts: Record<string, unknown>) => Promise<{ error?: { message: string }; paymentIntent?: { status: string } }>)(clientSecret, {
          payment_method: { card: cardElement },
        });
        if (result.error) throw new Error(result.error.message);
        if (result.paymentIntent?.status !== "succeeded") throw new Error("Payment did not succeed");
        // Payment succeeded — submit the form
        await submitInvoiceForm(paymentIntentId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Payment failed");
        setLoading(false);
      }
      return;
    }

    // Paid user — submit directly
    await submitInvoiceForm(null);
  }

  async function submitInvoiceForm(piId: string | null) {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("booking_id", bookingId);
      if (form.invoice_number) fd.append("invoice_number", form.invoice_number);
      fd.append("invoice_date", form.invoice_date);
      if (form.due_date) fd.append("due_date", form.due_date);
      fd.append("recipient_name", form.recipient_name);
      if (form.recipient_email) fd.append("recipient_email", form.recipient_email);
      if (form.recipient_address) fd.append("recipient_address", form.recipient_address);
      if (form.recipient_city) fd.append("recipient_city", form.recipient_city);
      if (form.recipient_country) fd.append("recipient_country", form.recipient_country);
      if (form.recipient_vat_id) fd.append("recipient_vat_id", form.recipient_vat_id);
      if (form.notes) fd.append("notes", form.notes);
      if (piId) fd.append("stripe_payment_intent", piId);

      const res = await fetch("/api/invoices/create", { method: "POST", body: fd });
      const json = (await res.json()) as { signed_url?: string; invoice_number?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to generate invoice");

      if (json.signed_url) window.open(json.signed_url, "_blank");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }

  const inputSty: React.CSSProperties = {
    width: "100%",
    padding: "9px 11px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
    fontFamily: FONT_BODY,
    marginBottom: 10,
  };

  const fieldLbl: React.CSSProperties = { ...lbl, marginBottom: 4, display: "block" };

  return (
    <SlideOver open={open} onClose={onClose} title="Generate Invoice">
      {!isPaidUser && (
        <div style={{
          background: "rgba(245,166,35,0.08)", border: "1px solid rgba(245,166,35,0.3)",
          borderRadius: 10, padding: "12px 14px", marginBottom: 16,
        }}>
          <p style={{ color: ACCENT, fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>
            Invoice generation costs $1.50
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 10px", lineHeight: 1.6 }}>
            Your PDF will download immediately after payment.
          </p>
          <a
            href="/account"
            style={{ color: ACCENT, fontSize: 12, fontWeight: 700, textDecoration: "underline" }}
          >
            Upgrade to Creator to generate invoices for free →
          </a>
        </div>
      )}

      {paymentStep && !isPaidUser && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ ...fieldLbl, marginBottom: 8 }}>Card details</p>
          <div
            ref={cardRef}
            style={{
              padding: "11px 13px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--surface)",
              minHeight: 42,
            }}
          />
        </div>
      )}

      {(!paymentStep || isPaidUser) && (
        <>
          <p style={{ ...lbl, marginBottom: 12, fontSize: 12 }}>Recipient</p>
          <label style={fieldLbl}>Name *</label>
          <input
            style={inputSty}
            value={form.recipient_name}
            onChange={(e) => setForm((f) => ({ ...f, recipient_name: e.target.value }))}
            placeholder="Client or company name"
          />
          <label style={fieldLbl}>Email</label>
          <input
            type="email"
            style={inputSty}
            value={form.recipient_email}
            onChange={(e) => setForm((f) => ({ ...f, recipient_email: e.target.value }))}
            placeholder="client@email.com"
          />
          <label style={fieldLbl}>Address</label>
          <input
            style={inputSty}
            value={form.recipient_address}
            onChange={(e) => setForm((f) => ({ ...f, recipient_address: e.target.value }))}
            placeholder="Street address"
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={fieldLbl}>City</label>
              <input
                style={inputSty}
                value={form.recipient_city}
                onChange={(e) => setForm((f) => ({ ...f, recipient_city: e.target.value }))}
                placeholder="City"
              />
            </div>
            <div>
              <label style={fieldLbl}>Country</label>
              <input
                style={inputSty}
                value={form.recipient_country}
                onChange={(e) => setForm((f) => ({ ...f, recipient_country: e.target.value }))}
                placeholder="DE / US / FR"
              />
            </div>
          </div>
          <label style={fieldLbl}>VAT ID</label>
          <input
            style={inputSty}
            value={form.recipient_vat_id}
            onChange={(e) => setForm((f) => ({ ...f, recipient_vat_id: e.target.value }))}
            placeholder="e.g. DE123456789"
          />

          <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0" }} />
          <p style={{ ...lbl, marginBottom: 12, fontSize: 12 }}>Invoice details</p>

          <label style={fieldLbl}>Invoice number (auto if blank)</label>
          <input
            style={inputSty}
            value={form.invoice_number}
            onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
            placeholder="INV-2026-001"
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={fieldLbl}>Invoice date *</label>
              <input
                type="date"
                style={inputSty}
                value={form.invoice_date}
                onChange={(e) => setForm((f) => ({ ...f, invoice_date: e.target.value }))}
              />
            </div>
            <div>
              <label style={fieldLbl}>Due date</label>
              <input
                type="date"
                style={inputSty}
                value={form.due_date}
                onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
              />
            </div>
          </div>

          <label style={fieldLbl}>Notes</label>
          <textarea
            style={{ ...inputSty, minHeight: 72, resize: "vertical" as const }}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Any additional notes on the invoice…"
          />
        </>
      )}

      {error && (
        <p style={{ color: "#f87171", fontSize: 13, margin: "8px 0" }}>{error}</p>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          onClick={handleFreeUserSubmit}
          disabled={loading || (!form.recipient_name && !paymentStep)}
          style={{
            flex: 1,
            padding: "12px",
            background: ACCENT,
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            fontFamily: FONT_BODY,
          }}
        >
          {loading
            ? "Processing…"
            : !isPaidUser && !paymentStep
            ? "Next: Pay $1.50 →"
            : !isPaidUser && paymentStep
            ? "Pay & Generate PDF"
            : "Generate & Download PDF"}
        </button>
        <button
          onClick={onClose}
          disabled={loading}
          style={{
            padding: "12px 16px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 10,
            color: "var(--text-muted)",
            fontSize: 14,
            cursor: "pointer",
            fontFamily: FONT_BODY,
          }}
        >
          Cancel
        </button>
      </div>
    </SlideOver>
  );
}

function UploadInvoiceSlideOver({
  open,
  onClose,
  bookingId,
  buyerParticipant,
}: {
  open: boolean;
  onClose: () => void;
  bookingId: string;
  buyerParticipant: BuyerParticipant;
}) {
  const today = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({
    invoice_number: "",
    invoice_date: today,
    recipient_name: buyerParticipant?.name ?? "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload() {
    if (!file) { setError("Please select a PDF file."); return; }
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("booking_id", bookingId);
      fd.append("invoice_number", form.invoice_number);
      fd.append("invoice_date", form.invoice_date);
      fd.append("recipient_name", form.recipient_name);
      fd.append("pdf", file);

      const res = await fetch("/api/invoices/upload", { method: "POST", body: fd });
      const json = (await res.json()) as { signed_url?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Upload failed");

      if (json.signed_url) window.open(json.signed_url, "_blank");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }

  const inputSty: React.CSSProperties = {
    width: "100%",
    padding: "9px 11px",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
    fontFamily: FONT_BODY,
    marginBottom: 10,
  };
  const fieldLbl: React.CSSProperties = { ...lbl, marginBottom: 4, display: "block" };

  return (
    <SlideOver open={open} onClose={onClose} title="Upload Invoice">
      <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
        Upload your own PDF invoice. It will be saved and linked to this booking.
      </p>

      <label style={fieldLbl}>Recipient name</label>
      <input
        style={inputSty}
        value={form.recipient_name}
        onChange={(e) => setForm((f) => ({ ...f, recipient_name: e.target.value }))}
        placeholder="Client or company name"
      />
      <label style={fieldLbl}>Invoice number</label>
      <input
        style={inputSty}
        value={form.invoice_number}
        onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
        placeholder="INV-2026-001"
      />
      <label style={fieldLbl}>Invoice date</label>
      <input
        type="date"
        style={inputSty}
        value={form.invoice_date}
        onChange={(e) => setForm((f) => ({ ...f, invoice_date: e.target.value }))}
      />

      <label style={fieldLbl}>PDF file (max 5 MB)</label>
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        style={{ ...inputSty, padding: "7px 0", border: "none", background: "none", cursor: "pointer" }}
      />
      {file && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "-4px 0 10px" }}>
          {file.name} ({(file.size / 1024).toFixed(0)} KB)
        </p>
      )}

      {error && <p style={{ color: "#f87171", fontSize: 13, margin: "4px 0 10px" }}>{error}</p>}

      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          onClick={handleUpload}
          disabled={loading || !file}
          style={{
            flex: 1,
            padding: "12px",
            background: ACCENT,
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: loading || !file ? "not-allowed" : "pointer",
            opacity: loading || !file ? 0.7 : 1,
            fontFamily: FONT_BODY,
          }}
        >
          {loading ? "Uploading…" : "Upload Invoice"}
        </button>
        <button
          onClick={onClose}
          disabled={loading}
          style={{
            padding: "12px 16px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 10,
            color: "var(--text-muted)",
            fontSize: 14,
            cursor: "pointer",
            fontFamily: FONT_BODY,
          }}
        >
          Cancel
        </button>
      </div>
    </SlideOver>
  );
}

function InvoiceSection({
  booking,
  invoice,
  buyerParticipant,
  planId,
}: {
  booking: Booking;
  invoice: InvoiceRecord | null;
  buyerParticipant: BuyerParticipant;
  planId: number | null;
}) {
  const bookingId = booking.id as string;
  const bookingStatus = booking.status as string;

  const [generateOpen, setGenerateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [voidLoading, setVoidLoading] = useState(false);

  async function handleDownload() {
    if (!invoice) return;
    setDownloading(true);
    try {
      const res = await fetch("/api/invoices/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invoice.id }),
      });
      const json = (await res.json()) as { signed_url?: string; error?: string };
      if (json.signed_url) window.open(json.signed_url, "_blank");
    } catch (err) {
      console.error("[invoice] download error:", err);
    } finally {
      setDownloading(false);
    }
  }

  async function handleVoid() {
    if (!invoice) return;
    setVoidLoading(true);
    try {
      await fetch("/api/invoices/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invoice.id }),
      });
    } catch (err) {
      console.error("[invoice] void error:", err);
    } finally {
      setVoidLoading(false);
      setShowVoidConfirm(false);
      window.location.reload();
    }
  }

  const isBookable = ["confirmed", "completed"].includes(bookingStatus) || bookingStatus === "pending";

  if (!isBookable) return null;

  const sym = currencySym(invoice?.currency ?? null);

  return (
    <section id="invoice" style={{ paddingBottom: 40 }}>
      <SectionHeading>Invoice</SectionHeading>

      {invoice && invoice.status !== "void" ? (
        <div style={{
          background: "var(--surface)",
          border: "1px solid rgba(245,166,35,0.28)",
          borderRadius: 16,
          padding: "20px 22px",
        }}>
          {/* Invoice meta row */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
            <div>
              <p style={{ ...lbl, marginBottom: 4 }}>Invoice</p>
              <p style={{ color: "var(--text)", fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>
                {invoice.invoice_number ?? "—"}
              </p>
              {invoice.invoice_date && (
                <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
                  {new Date(invoice.invoice_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                </p>
              )}
            </div>
            <div style={{ textAlign: "right" as const }}>
              <InvoiceStatusBadge status={invoice.status} />
              {invoice.gross_amount != null && invoice.gross_amount > 0 && (
                <p style={{ color: "var(--text)", fontSize: 18, fontWeight: 700, margin: "8px 0 0" }}>
                  {sym}{Number(invoice.gross_amount).toLocaleString()} {(invoice.currency ?? "EUR").toUpperCase()}
                </p>
              )}
            </div>
          </div>

          {invoice.recipient_name && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 14px" }}>
              Billed to: <span style={{ color: "var(--text)", fontWeight: 600 }}>{invoice.recipient_name}</span>
            </p>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, marginTop: 4 }}>
            <button
              onClick={handleDownload}
              disabled={downloading}
              style={{
                padding: "9px 18px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 9,
                fontSize: 13,
                fontWeight: 700,
                cursor: downloading ? "not-allowed" : "pointer",
                opacity: downloading ? 0.7 : 1,
                fontFamily: FONT_BODY,
              }}
            >
              {downloading ? "Opening…" : "↓ Download PDF"}
            </button>

            {showVoidConfirm ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Void this invoice?</span>
                <button
                  onClick={handleVoid}
                  disabled={voidLoading}
                  style={{ padding: "7px 14px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
                >
                  {voidLoading ? "Voiding…" : "Confirm Void"}
                </button>
                <button
                  onClick={() => setShowVoidConfirm(false)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: FONT_BODY }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowVoidConfirm(true)}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text-muted)", fontSize: 13, padding: "9px 14px", cursor: "pointer", fontFamily: FONT_BODY }}
              >
                Void
              </button>
            )}
          </div>
        </div>
      ) : invoice?.status === "void" ? (
        <div style={{
          background: "var(--surface)",
          border: "1px solid rgba(245,166,35,0.2)",
          borderRadius: 16,
          padding: "20px 22px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <InvoiceStatusBadge status="void" />
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
              Invoice {invoice.invoice_number} was voided.
            </p>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            You can create a new invoice below.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" as const }}>
            <button
              onClick={() => setGenerateOpen(true)}
              style={{ padding: "9px 18px", background: ACCENT, color: "#111", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
            >
              Generate Invoice
            </button>
            <button
              onClick={() => setUploadOpen(true)}
              style={{ padding: "9px 18px", background: "none", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT_BODY }}
            >
              Upload PDF
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          background: "var(--surface)",
          border: "1px solid rgba(245,166,35,0.2)",
          borderRadius: 16,
          padding: "20px 22px",
        }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 14px", lineHeight: 1.6 }}>
            No invoice has been created for this booking yet. Generate one from your accepted proposal, or upload your own PDF.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
            <button
              onClick={() => setGenerateOpen(true)}
              style={{ padding: "9px 18px", background: ACCENT, color: "#111", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
            >
              Generate Invoice
            </button>
            <button
              onClick={() => setUploadOpen(true)}
              style={{ padding: "9px 18px", background: "none", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT_BODY }}
            >
              Upload PDF
            </button>
          </div>
        </div>
      )}

      <GenerateInvoiceSlideOver
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        bookingId={bookingId}
        planId={planId}
        buyerParticipant={buyerParticipant}
      />
      <UploadInvoiceSlideOver
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        bookingId={bookingId}
        buyerParticipant={buyerParticipant}
      />
    </section>
  );
}

// ─── Member view wrapper ──────────────────────────────────────────────────────

function MemberView({
  booking,
  wallet,
  planLevel,
  planId,
  userEmail,
  senderName,
  stripeConnectId,
  memberInfo,
  proposalFeePct,
  invoice,
  buyerParticipant,
}: {
  booking: Booking;
  wallet: WalletData | null;
  planLevel: number;
  planId: number | null;
  userEmail: string;
  senderName: string | null;
  stripeConnectId: string | null;
  memberInfo?: MemberInfo;
  proposalFeePct?: number | null;
  invoice: InvoiceRecord | null;
  buyerParticipant: BuyerParticipant;
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

        <DetailsSection booking={b} memberInfo={memberInfo} />

        {showProposal && <ProposalSection booking={b} planLevel={planLevel} stripeConnectId={stripeConnectId} proposalFeePct={proposalFeePct} />}

        {showPayments && wallet && (
          <BookingWallet wallet={wallet} bookingStatus={b.status as string} stripeConnectId={stripeConnectId} />
        )}

        <InvoiceSection
          booking={b}
          invoice={invoice}
          buyerParticipant={buyerParticipant}
          planId={planId}
        />
      </div>

      <BookingChat
        bookingId={b.id as string}
        currentUserEmail={userEmail}
        isOwner={true}
        senderName={senderName ?? undefined}
      />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingAccessPage() {
  const data = useLoaderData<typeof loader>() as Record<string, unknown>;
  console.log('[booking page] loader data proposal:', data.proposal);

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
    accessType,
    role,
    proposal,
    bookingToken,
    wallet,
    planId,
    isBeta,
    proposalFeePct,
    memberInfo,
    stripeConnectId,
    senderName,
    memberEmail,
    invoice,
    buyerParticipant,
  } = data as {
    booking: Booking;
    userEmail: string;
    isOwner: boolean;
    accessType: string;
    role: string;
    proposal: Proposal;
    bookingToken: string | null;
    wallet: WalletData | null;
    planId: number | null;
    isBeta: boolean;
    proposalFeePct?: number | null;
    memberInfo?: MemberInfo;
    stripeConnectId?: string | null;
    senderName: string | null;
    memberEmail?: string | null;
    invoice?: InvoiceRecord | null;
    buyerParticipant?: BuyerParticipant;
  };

  const b = booking;
  const planLevel = getPlanLevel(planId, isBeta);

  // ── Owner / authenticated member — full rich UI ────────────────────────────
  if (isOwner) {
    return (
      <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
        <PaymentSuccessBanner />
        <MemberView
          booking={b}
          wallet={wallet}
          planLevel={planLevel}
          planId={planId}
          userEmail={userEmail}
          senderName={senderName}
          stripeConnectId={stripeConnectId ?? null}
          memberInfo={memberInfo}
          proposalFeePct={proposalFeePct}
          invoice={invoice ?? null}
          buyerParticipant={buyerParticipant ?? null}
        />
      </div>
    );
  }

  // ── Guest / participant — single scrollable page ───────────────────────────
  const isBuyer = role === "buyer";
  const bStatus = b.status as string;
  const isConfirmedOrCompleted = bStatus === "confirmed" || bStatus === "completed";

  function handleBuyerChatSend(message: string) {
    // Notify the booking owner — fire and forget
    fetch("/api/notify-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: b.id as string,
        buyerEmail: userEmail,
        message,
      }),
    }).catch(() => { /* non-fatal */ });
  }

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", fontFamily: FONT_BODY, color: "var(--text)" }}>
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

            {/* 2. Booking details card */}
            <GuestDetailsCard b={b} />

            {/* Seller Information */}
            {memberInfo && (memberInfo.company_name || memberInfo.legal_form || memberInfo.vat_id || memberInfo.responsible_person) && (
              <div style={{ ...card, marginTop: 8 }}>
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
        senderName={senderName ?? undefined}
        onAfterSend={handleBuyerChatSend}
      />
    </div>
  );
}
