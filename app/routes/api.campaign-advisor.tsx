import type { Route } from "./+types/api.campaign-advisor";
import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Thin authenticated forwarder to the `campaign-advisor` edge function.
// Verifies the caller owns the campaign, then invokes the function server-side
// (the ANTHROPIC_API_KEY lives only in the edge function). No caching — the
// advisor is computed live on every manual trigger.
//
// Dual auth: the browser flow authenticates via cookies and submits a form;
// native callers (sqrz-ios) send a Bearer access token + JSON body. Ownership is
// enforced HERE in both cases — the deployed edge function does not re-check
// ownership, so this forwarder is the security boundary. Never invoke the edge
// function without confirming the caller owns the campaign first.
export async function action({ request }: Route.ActionArgs) {
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
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  // campaign_id: JSON body for native callers, form field for the browser.
  let campaignId = "";
  if (isNative) {
    try {
      const body = await request.json();
      campaignId = String(body?.campaign_id ?? "");
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400, headers });
    }
  } else {
    const form = await request.formData();
    campaignId = String(form.get("campaign_id") ?? "");
  }
  if (!campaignId) {
    return Response.json({ error: "campaign_id required" }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();

  // Ownership check — the campaign must belong to the signed-in user's profile.
  const { data: campaign } = await admin
    .from("boost_campaigns")
    .select("id, profile_id")
    .eq("id", campaignId)
    .single();

  if (!campaign || campaign.profile_id !== profile.id) {
    return Response.json({ error: "Not found" }, { status: 404, headers });
  }

  // ── iOS-app entitlement gate ─────────────────────────────────────────────────
  // Access to the iOS app is itself the gate right now (TestFlight, invite-only)
  // — no feature needs its own separate entitlement check on top of that (see
  // root CLAUDE.md). `isNative` is already computed above from the Bearer-vs-
  // cookie auth path, so reusing it here isn't a new check, just a different
  // condition. NEVER gate on ios_subscriptions (the Companion subscription is
  // unrelated) or grow_clients (dropped 2026-07-31, see root CLAUDE.md).
  //
  // A non-native (web) caller gets a structured 200 "locked" response (not a
  // 403 with no context, and no paid LLM call) — today's clients render the
  // summary text; a future UI pass can key off `locked` to show a proper state.
  if (!isNative) {
    return Response.json(
      {
        locked: true,
        health: null,
        summary:
          "Campaign Advisor is available in the SQRZ iOS app.",
        insights: [],
        actions: [],
      },
      { headers },
    );
  }

  const { data, error } = await admin.functions.invoke("campaign-advisor", {
    body: { campaign_id: campaignId },
  });

  if (error || !data) {
    return Response.json({ error: "Advisor unavailable" }, { status: 502, headers });
  }

  return Response.json(data, { headers });
}
