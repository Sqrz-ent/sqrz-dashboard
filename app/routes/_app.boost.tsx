import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.boost";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { transitionBoostCampaign, loadBoostSectionData, type BoostSectionData } from "~/lib/boost.server";
import BoostSection from "~/components/BoostSection";

const DURATION_DAYS: Record<string, number> = {
  "1 Week":  7,
  "2 Weeks": 14,
  "4 Weeks": 28,
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const data = await loadBoostSectionData(supabase, profile);
  return Response.json(data, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = (formData.get("intent") as string) || "create_booking";

  // ── Step 2: Content submission (booked/needs_changes → in_review) ───────────
  // The artist adds creative/targeting/notes after paying, moving to in_review.
  if (intent === "save_content") {
    const campaignId = formData.get("campaign_id") as string;
    if (!campaignId) return Response.json({ ok: false, error: "Missing campaign" }, { headers });

    // Verify ownership + a content-editable state. Status-based, not type-based:
    // Boost and Grow both use the content step at booked/needs_changes/in_review.
    const { data: existing } = await supabase
      .from("boost_campaigns")
      .select("id, status")
      .eq("id", campaignId)
      .eq("profile_id", profile.id as string)
      .single();
    if (!existing) {
      return Response.json({ ok: false, error: "Campaign not found" }, { headers });
    }
    if (!["booked", "needs_changes", "in_review"].includes(existing.status as string)) {
      return Response.json({ ok: false, error: "This campaign can't accept content right now." }, { headers });
    }

    // Post-payment step is creative-only. Targeting, goal, budget, channels and
    // notes were all captured pre-payment during booking.
    const { error: updateError } = await supabase
      .from("boost_campaigns")
      .update({
        creative_asset_url: (formData.get("creative_asset_url") as string) || null,
      })
      .eq("id", campaignId)
      .eq("profile_id", profile.id as string);
    if (updateError) return Response.json({ ok: false, error: updateError.message }, { headers });

    // Transition to in_review. needs_changes → resubmit re-enters review.
    const res = await transitionBoostCampaign({ campaignId, status: "in_review" });
    return Response.json({ ok: res.ok, error: res.error, contentSaved: res.ok }, { headers });
  }

  // ── Step 1: Booking — the single shared creation path for BOTH Boost and Grow.
  // Everything except the creative is collected here, pre-payment (goal, budget,
  // target audience, duration, channels, notes). The only pricing divergence is
  // campaign_type, which the checkout endpoint uses to pick the fee model.
  const campaignType = (formData.get("campaign_type") as string) === "grow" ? "grow" : "boost";
  const promoteType = formData.get("promote_type") as string;
  const promoteLinkId = formData.get("promote_link_id") as string | null;
  const duration = (formData.get("duration") as string) || null;
  const newBudget = parseFloat(formData.get("budget_amount") as string);

  // Grow ad spend has a plan-based minimum — enforce server-side, not just in the UI.
  if (campaignType === "grow") {
    const planId = profile.plan_id as number | null;
    const minBudget = planId === null || planId === 4 ? 100 : 250;
    if (!newBudget || newBudget < minBudget) {
      return Response.json(
        { ok: false, error: `Minimum Grow budget is $${minBudget.toLocaleString()}` },
        { headers }
      );
    }
  }

  // Insert with NULL status = created, awaiting payment. The Stripe webhook sets
  // status='booked' on successful payment; the artist then uploads creative (Step 2).
  const { data: inserted, error } = await supabase
    .from("boost_campaigns")
    .insert({
      profile_id: profile.id as string,
      campaign_type: campaignType,
      promote_type: promoteType,
      promote_link_id: promoteType === "link" && promoteLinkId ? promoteLinkId : null,
      channels: ((formData.get("channels") as string) || "meta")
        .split(",").map((s) => s.trim()).filter(Boolean),
      duration,
      goal: (formData.get("goal") as string) || null,
      target_audience: (formData.get("target_audience") as string) || null,
      notes: (formData.get("notes") as string) || null,
      budget_amount: newBudget,
      budget_currency: "USD",
      status: null,
    })
    .select("id, utm_source, utm_campaign, utm_content")
    .single();

  if (error || !inserted) {
    return Response.json({ ok: false, error: error?.message }, { headers });
  }

  // ── Wire UTM URL + dates ───────────────────────────────────────────────────
  const today = new Date();
  const days = duration ? (DURATION_DAYS[duration] ?? 30) : 30;
  const endsAt = addDays(today, days);

  // Build base URL — always subdomain-based
  let baseUrl = `https://${profile.slug as string}.sqrz.com`;
  if (promoteType === "link" && promoteLinkId) {
    const { data: linkRow } = await supabase
      .from("private_booking_links")
      .select("link_slug")
      .eq("id", promoteLinkId)
      .single();
    if (linkRow?.link_slug) {
      baseUrl = `https://${profile.slug as string}.sqrz.com/${linkRow.link_slug}`;
    }
  }

  // Build UTM URL from trigger-populated fields
  let utmUrl: string | null = null;
  if (inserted.utm_source) {
    const params = new URLSearchParams({
      utm_source: inserted.utm_source,
      utm_medium: "paid",
      ...(inserted.utm_campaign ? { utm_campaign: inserted.utm_campaign } : {}),
      ...(inserted.utm_content ? { utm_content: inserted.utm_content } : {}),
    });
    utmUrl = `${baseUrl}?${params.toString()}`;
  }

  await supabase
    .from("boost_campaigns")
    .update({
      starts_at: toDateString(today),
      ends_at: toDateString(endsAt),
      ...(utmUrl ? { utm_url: utmUrl } : {}),
    })
    .eq("id", inserted.id);

  // Return type + budget so the client kicks off checkout with server-truth values
  // (avoids a race with form state that resets on success).
  return Response.json(
    { ok: true, campaignId: inserted.id, campaign_type: campaignType, budget_amount: newBudget },
    { headers }
  );
}

export default function BoostPage() {
  const data = useLoaderData<typeof loader>() as BoostSectionData;
  return <BoostSection {...data} />;
}
