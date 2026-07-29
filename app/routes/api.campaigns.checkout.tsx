import { redirect } from "react-router";
import type { Route } from "./+types/api.campaigns.checkout";
import { createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { createCampaignCheckoutSession } from "~/lib/campaignPayments.server";

const APP_URL = process.env.PUBLIC_URL ?? "https://dashboard.sqrz.com";

export async function action({ request }: Route.ActionArgs) {
  // Native callers (sqrz-ios) authenticate with a Bearer access token and expect JSON;
  // the browser flow authenticates via cookies. Body is JSON in both cases.
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
    if (!user) return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  let body: {
    campaign_type?: "boost" | "grow";
    budget_amount?: number;
    campaign_id?: string | null;
    // Grow-only fields for new campaign creation
    promote_type?: string | null;
    promote_link_id?: string | null;
    target_audience?: string | null;
    notes?: string | null;
    goal?: string | null;
    duration?: string | null;
    channels?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400, headers });
  }

  const { campaign_type } = body;
  const budget = Number(body.budget_amount);

  if (!campaign_type || !["boost", "grow"].includes(campaign_type)) {
    return Response.json({ error: "Invalid campaign_type" }, { status: 400, headers });
  }
  if (!budget || budget <= 0) {
    return Response.json({ error: "Invalid budget_amount" }, { status: 400, headers });
  }

  // ── Resolve campaign ID ────────────────────────────────────────────────────
  let campaignId: string;

  if (body.campaign_id) {
    campaignId = body.campaign_id;
  } else if (campaign_type === "grow") {
    // Grow: create campaign row now (no prior action step). Any positive budget
    // is valid — no minimum, no plan-based split.
    const promoteType = body.promote_type ?? "profile";

    // Channels: valid non-empty subset of the Grow options (satisfies the
    // boost_campaigns_channels_check constraint).
    const channels = (Array.isArray(body.channels) ? body.channels : [])
      .filter((c) => c === "meta" || c === "google");
    const growChannels = channels.length ? channels : ["meta"];

    // Optional duration → derive campaign dates (same mapping as Boost).
    const DURATION_DAYS: Record<string, number> = { "1 Week": 7, "2 Weeks": 14, "4 Weeks": 28 };
    let startsAt: string | null = null;
    let endsAt: string | null = null;
    if (body.duration && DURATION_DAYS[body.duration]) {
      const today = new Date();
      const end = new Date(today);
      end.setDate(end.getDate() + DURATION_DAYS[body.duration]);
      startsAt = today.toISOString().split("T")[0];
      endsAt = end.toISOString().split("T")[0];
    }

    const { data: inserted, error: insertError } = await supabase
      .from("boost_campaigns")
      .insert({
        profile_id: profile.id as string,
        promote_type: promoteType,
        promote_link_id: promoteType === "link" && body.promote_link_id ? body.promote_link_id : null,
        target_audience: body.target_audience ?? null,
        budget_amount: budget,
        budget_currency: "USD",
        status: "pending",
        campaign_type: "grow",
        notes: body.notes ?? "grow campaign — awaiting payment",
        goal: body.goal ?? null,
        duration: body.duration ?? null,
        channels: growChannels,
        starts_at: startsAt,
        ends_at: endsAt,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      return Response.json({ error: "Failed to create campaign" }, { status: 500, headers });
    }
    campaignId = inserted.id as string;
  } else {
    return Response.json({ error: "campaign_id required for boost campaigns" }, { status: 400, headers });
  }

  // ── Calculate fee and total ────────────────────────────────────────────────
  // Boost: flat $25 campaign fee, charged alone — the ad budget itself is NOT
  // charged through this checkout (handled separately as ad spend). Grow keeps
  // its unchanged flat 20% management fee on the ad budget, budget + fee both
  // charged together — no activation fee, no minimum, no plan-based split.
  const isBoost = campaign_type === "boost";
  const BOOST_FLAT_FEE = 25;
  const fee = isBoost ? BOOST_FLAT_FEE : Math.round(budget * 0.20 * 100) / 100;
  const total = isBoost ? fee : budget + fee;

  const productName = isBoost
    ? `SQRZ Boost Campaign fee — $${budget} ad budget`
    : `SQRZ Grow Campaign — $${budget} ad budget`;

  const description = isBoost
    ? `Flat $${BOOST_FLAT_FEE} campaign fee. Your $${budget} ad budget is billed separately.`
    : `Includes 20% SQRZ fee ($${Math.round(budget * 0.20)})`;

  // ── Checkout session (Stripe today; see campaignPayments.server.ts) ────────
  const { checkoutUrl } = await createCampaignCheckoutSession({
    amountCents: Math.round(total * 100),
    productName,
    description,
    successUrl: `${APP_URL}/boost?campaign_paid=true`,
    cancelUrl: `${APP_URL}/boost`,
    clientReferenceId: campaignId,
    customerEmail: (profile.email as string) ?? undefined,
    metadata: {
      profile_id: profile.id as string,
      campaign_id: campaignId,
      campaign_type,
      budget_amount: String(budget),
      fee: String(fee),
      total: String(total),
    },
  });

  return Response.json({ checkout_url: checkoutUrl }, { headers });
}
