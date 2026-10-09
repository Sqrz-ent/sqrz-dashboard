import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";
import { createHmac } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// delete-account
//
// Input:  { profile_id, auth_user_id, apple_authorization_code } — all three
//         resolved/owns-checked by the forwarder (api.delete-account.tsx)
//         BEFORE invoking this function. Same constraint as profile-advisor:
//         this function cannot verify a Bearer token itself, because the
//         invoke call's Authorization header carries the SERVICE ROLE key,
//         not the caller's own token — the forwarder is the trust boundary.
//
// Decided model (do not hard-delete `profiles`): the profiles row is
// ANONYMIZED IN PLACE, not deleted — wallet_ledger_entries, management_fee_
// charges, and ios_subscriptions hang off it and are financial/subscription
// records that must survive. Only the auth.users row (the login) is deleted.
//
// Order: capture external ids first → money check (abort, mutate nothing, if
// any wallet/budget balance remains) → Apple re-auth verification + token
// revocation (abort on verification failure; revocation itself is best-
// effort) → external cleanup (Meta/Stripe/RevenueCat/Stream/HubSpot/storage,
// each best-effort, logged, never aborts the rest) → database (explicit
// deletes/scrub, since the profile row survives so nothing cascades) → delete
// auth.users last (only possible once profiles.user_id is nulled).
//
// Every external/log-and-continue step is naturally idempotent (deleting an
// already-deleted resource 404s and is treated as success); the Apple
// authorization code is single-use by Apple's own design, so a genuine retry
// requires the client to obtain a fresh one.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Reuses the existing Apple Team ID / bundle id vars (same Apple Team/App as
// apns-push and apple-subscription-webhook) — no new Team ID secret needed.
const APPLE_TEAM_ID = Deno.env.get("APNS_TEAM_ID")!;
const APPLE_BUNDLE_ID = Deno.env.get("APPLE_BUNDLE_ID") ?? "com.sqrz.ios";
// NEW secrets — see the deploy report for exactly what to provision.
const APPLE_SIGNIN_KEY_ID = Deno.env.get("APPLE_SIGNIN_KEY_ID")!;
const APPLE_SIGNIN_PRIVATE_KEY = Deno.env.get("APPLE_SIGNIN_PRIVATE_KEY")!;

const META_GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

type AdminClient = ReturnType<typeof createClient>;

// ─── Audit log ────────────────────────────────────────────────────────────────

async function logStep(
  admin: AdminClient,
  profileId: string,
  step: string,
  status: "ok" | "failed",
  error?: string | null,
): Promise<void> {
  const { error: insertErr } = await admin
    .from("account_deletion_log")
    .insert({ profile_id: profileId, step, status, error: error ?? null });
  if (insertErr) {
    // The log itself failing must never block deletion — just surface it server-side.
    console.error(`[delete-account] failed to write audit log for step "${step}":`, insertErr.message);
  }
}

// Runs a best-effort external step: logs ok/failed, never throws back to the
// caller, and the caller collects which steps failed to report at the end.
async function bestEffort(
  admin: AdminClient,
  profileId: string,
  step: string,
  failedSteps: string[],
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    await logStep(admin, profileId, step, "ok");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[delete-account] step "${step}" failed:`, msg);
    await logStep(admin, profileId, step, "failed", msg);
    failedSteps.push(step);
  }
}

// ─── Apple: client-secret JWT + token exchange + revoke ─────────────────────

async function buildAppleClientSecret(): Promise<string> {
  const key = await importPKCS8(APPLE_SIGNIN_PRIVATE_KEY, "ES256");
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_SIGNIN_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setSubject(APPLE_BUNDLE_ID)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64));
}

// Exchanges the fresh authorizationCode for a refresh_token, and returns the
// `sub` from the id_token Apple returns alongside it. The id_token here is
// NOT independently signature-verified: it just came directly from Apple's
// own /auth/token endpoint over TLS, in direct response to a request WE
// signed and sent — there is no untrusted intermediary in this path (unlike
// a client-supplied token, which this never is).
async function exchangeAppleCode(code: string): Promise<{ sub: string; refreshToken: string }> {
  const clientSecret = await buildAppleClientSecret();
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APPLE_BUNDLE_ID,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error(`apple token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  }
  const payload = decodeJwtPayload(body.id_token);
  if (typeof payload.sub !== "string") throw new Error("apple id_token has no sub");
  return { sub: payload.sub, refreshToken: body.refresh_token };
}

// Best-effort — failure here must never block the rest of deletion (see file header).
async function revokeAppleToken(refreshToken: string): Promise<void> {
  const clientSecret = await buildAppleClientSecret();
  const res = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APPLE_BUNDLE_ID,
      client_secret: clientSecret,
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`apple revoke failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ─── Meta: reuses meta-campaign-create's own metaDelete shape ───────────────

async function metaDelete(id: string, token: string): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // Meta 400s on an id that's already gone — treat as success (idempotent retry).
  if (!res.ok && res.status !== 400 && res.status !== 404) {
    throw new Error(`meta delete ${id} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ─── Stripe ───────────────────────────────────────────────────────────────────

async function deleteStripeCustomer(customerId: string, secretKey: string): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // "No such customer" (already deleted) is idempotent-success.
    if (body?.error?.code !== "resource_missing") {
      throw new Error(`stripe customer delete failed: ${res.status} ${JSON.stringify(body)}`);
    }
  }
}

// ─── RevenueCat ───────────────────────────────────────────────────────────────

async function deleteRevenueCatSubscriber(rcAppUserId: string): Promise<void> {
  const key = Deno.env.get("REVENUECAT_SECRET_API_KEY")!;
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcAppUserId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`revenuecat delete failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ─── Stream (hand-rolled HS256 server JWT — same scheme as this project's own
// app/lib/messaging/stream.server.ts, just translated to Deno) ──────────────

function toBase64Url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function streamServerToken(apiSecret: string): string {
  const header = toBase64Url(JSON.stringify({ typ: "JWT", alg: "HS256" }));
  const payload = toBase64Url(JSON.stringify({ server: true }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", apiSecret).update(unsigned).digest();
  return `${unsigned}.${toBase64Url(signature)}`;
}

// NOT independently verified against a live Stream project in this pass (see
// deploy report) — the REST shape (POST /users/delete, hard-delete user +
// messages) matches Stream's documented async Delete-Users endpoint.
async function deleteStreamUser(streamUserId: string): Promise<void> {
  const apiKey = Deno.env.get("STREAM_API_KEY")!;
  const apiSecret = Deno.env.get("STREAM_API_SECRET")!;
  const token = streamServerToken(apiSecret);
  const res = await fetch(`https://chat.stream-io-api.com/users/delete?api_key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "stream-auth-type": "jwt",
    },
    body: JSON.stringify({
      user_ids: [streamUserId],
      user: "hard",
      messages: "hard",
      conversations: "hard",
    }),
  });
  if (!res.ok) {
    throw new Error(`stream delete failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ─── HubSpot — archive the contact only, deals are deliberately left alone ──

async function archiveHubspotContact(contactId: string): Promise<void> {
  const token = Deno.env.get("HUBSPOT_TOKEN")!;
  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`hubspot archive failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────

async function purgeBucketPrefix(admin: AdminClient, bucket: string, prefix: string): Promise<void> {
  const { data: files, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${bucket}/${prefix} failed: ${error.message}`);
  if (!files || files.length === 0) return;
  const paths = files.map((f) => `${prefix}/${f.name}`);
  const { error: removeErr } = await admin.storage.from(bucket).remove(paths);
  if (removeErr) throw new Error(`remove ${bucket}/${prefix} failed: ${removeErr.message}`);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Identity ─────────────────────────────────────────────────────────────
  // Same constraint as profile-advisor — see file header. The forwarder is
  // the security boundary; this function trusts the three ids it's given.
  let profileId: string;
  let authUserId: string;
  let appleAuthorizationCode: string;
  try {
    const body = await req.json();
    profileId = String(body?.profile_id ?? "");
    authUserId = String(body?.auth_user_id ?? "");
    appleAuthorizationCode = String(body?.apple_authorization_code ?? "");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // TEMP DEBUG LOGGING — remove after the delete-account investigation.
  // Never logs apple_authorization_code.
  console.log(`[delete-account] request received — profile_id=${profileId} auth_user_id=${authUserId}`);

  if (!profileId || !authUserId || !appleAuthorizationCode) {
    return json({ error: "profile_id, auth_user_id, and apple_authorization_code required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // TEMP DEBUG LOGGING — first action taken with the admin client, so we can
  // tell from account_deletion_log alone whether the function was ever
  // invoked, independent of every later step (money check, Apple verify,
  // etc.) that might return early. Remove after the investigation.
  await logStep(admin, profileId, "request_received", "ok");

  // ── Step 0: capture every external identifier BEFORE mutating anything ──
  const { data: callerProfile } = await admin
    .from("profiles")
    .select("id, stripe_customer_id, stripe_customer_id_test, hubspot_contact_id, apns_device_token")
    .eq("id", profileId)
    .maybeSingle();
  if (!callerProfile?.id) {
    return json({ error: "Profile not found" }, 404);
  }

  const { data: campaignRows } = await admin
    .from("boost_campaigns")
    .select("id, meta_campaign_id, meta_adset_id, meta_ad_id")
    .eq("profile_id", profileId);
  const allCampaignIds = (campaignRows ?? []).map((c) => c.id as string);
  const liveMetaCampaignIds = (campaignRows ?? [])
    .map((c) => c.meta_campaign_id as string | null)
    .filter((id): id is string => !!id);

  // ── Step 1: money check — refuse and mutate nothing if any balance remains ──
  const { data: walletRow } = await admin
    .from("ad_spend_wallets")
    .select("balance_cents")
    .eq("profile_id", profileId)
    .maybeSingle();
  const walletBalanceCents = Number(walletRow?.balance_cents ?? 0);

  let unspentAllocatedCents = 0;
  if (allCampaignIds.length) {
    const { data: budgetRows } = await admin
      .from("campaign_budgets")
      .select("allocated_cents, spent_cents")
      .in("campaign_id", allCampaignIds);
    unspentAllocatedCents = (budgetRows ?? []).reduce(
      (sum, r) => sum + (Number(r.allocated_cents ?? 0) - Number(r.spent_cents ?? 0)),
      0,
    );
  }

  // Returned as a plain 200 (not 409) deliberately — admin.functions.invoke()
  // treats any non-2xx as a transport-level error and drops the body, which
  // would lose this structured error for the forwarder/iOS. Same convention
  // profile-advisor's "limited" response already uses.
  const totalCentsInPlay = walletBalanceCents + unspentAllocatedCents;
  if (totalCentsInPlay > 0) {
    return json({ error: "money_in_play", amount_cents: totalCentsInPlay });
  }

  // ── Step 2: Apple — verify same-account, then revoke (best-effort) ──────
  const { data: userResult, error: getUserErr } = await admin.auth.admin.getUserById(authUserId);
  if (getUserErr || !userResult?.user) {
    return json({ error: "User not found" });
  }
  const storedAppleSub = userResult.user.identities?.find((i) => i.provider === "apple")
    ?.identity_data?.sub as string | undefined;
  if (!storedAppleSub) {
    return json({ error: "No Apple identity on this account" });
  }

  // Also returned as plain 200s — see the money-check comment above for why.
  let appleRefreshToken: string;
  try {
    const exchanged = await exchangeAppleCode(appleAuthorizationCode);
    if (exchanged.sub !== storedAppleSub) {
      await logStep(admin, profileId, "apple_verify", "failed", "sub mismatch");
      return json({ error: "apple_verification_failed" });
    }
    appleRefreshToken = exchanged.refreshToken;
    await logStep(admin, profileId, "apple_verify", "ok");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logStep(admin, profileId, "apple_verify", "failed", msg);
    return json({ error: "apple_verification_failed" });
  }

  const failedSteps: string[] = [];

  await bestEffort(admin, profileId, "apple_revoke", failedSteps, () => revokeAppleToken(appleRefreshToken));

  // ── Step 3: external cleanup, best-effort, log-and-continue per step ─────

  if (liveMetaCampaignIds.length) {
    await bestEffort(admin, profileId, "meta_delete_campaigns", failedSteps, async () => {
      const { data: acct } = await admin
        .from("meta_ad_accounts")
        .select("system_user_token")
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!acct?.system_user_token) throw new Error("no active meta_ad_accounts row");
      for (const id of liveMetaCampaignIds) {
        await metaDelete(id, acct.system_user_token as string);
      }
    });
  }

  if (callerProfile.stripe_customer_id) {
    const liveKey = Deno.env.get("STRIPE_SECRET_KEY");
    await bestEffort(admin, profileId, "stripe_delete_customer_live", failedSteps, async () => {
      if (!liveKey) throw new Error("STRIPE_SECRET_KEY not set");
      await deleteStripeCustomer(callerProfile.stripe_customer_id as string, liveKey);
    });
  }
  if (callerProfile.stripe_customer_id_test) {
    const testKey = Deno.env.get("STRIPE_SECRET_KEY_TEST");
    await bestEffort(admin, profileId, "stripe_delete_customer_test", failedSteps, async () => {
      if (!testKey) throw new Error("STRIPE_SECRET_KEY_TEST not set");
      await deleteStripeCustomer(callerProfile.stripe_customer_id_test as string, testKey);
    });
  }

  await bestEffort(admin, profileId, "revenuecat_delete_subscriber", failedSteps, () =>
    deleteRevenueCatSubscriber(authUserId.toLowerCase()));

  await bestEffort(admin, profileId, "stream_delete_user", failedSteps, () =>
    deleteStreamUser(`profile_${profileId}`));

  if (callerProfile.hubspot_contact_id) {
    await bestEffort(admin, profileId, "hubspot_archive_contact", failedSteps, () =>
      archiveHubspotContact(callerProfile.hubspot_contact_id as string));
  }

  await bestEffort(admin, profileId, "storage_purge_profile_pictures", failedSteps, () =>
    purgeBucketPrefix(admin, "profile-pictures", authUserId));
  await bestEffort(admin, profileId, "storage_purge_profile_media", failedSteps, () =>
    purgeBucketPrefix(admin, "profile-media", profileId));
  await bestEffort(admin, profileId, "storage_purge_campaign_creative", failedSteps, () =>
    purgeBucketPrefix(admin, "campaign-creative", profileId));

  // ── Step 4: database ──────────────────────────────────────────────────────

  // 4a. NO-ACTION-constrained children (moot for notifications/boost_campaigns
  // since we never hard-delete profiles/boost_campaigns, but deleted anyway —
  // this content shouldn't survive regardless).
  if (allCampaignIds.length) {
    await admin.from("campaign_advisor_runs").delete().in("boost_campaign_id", allCampaignIds);
  }
  await admin.from("notifications").delete().eq("profile_id", profileId);

  // 4b. Content tables — explicit deletes, since the profile row survives and
  // nothing cascades under this model.
  await admin.from("profile_services").delete().eq("profile_id", profileId);
  await admin.from("profile_videos").delete().eq("profile_id", profileId);
  await admin.from("profile_references").delete().eq("profile_id", profileId);
  await admin.from("private_booking_links").delete().eq("profile_id", profileId);
  await admin.from("leads").delete().eq("profile_id", profileId);
  await admin.from("profile_inquiry_threads").delete().eq("profile_id", profileId);
  await admin.from("profile_views").delete().eq("profile_id", profileId);
  await admin.from("shop_products").delete().eq("profile_id", profileId);
  await admin.from("profile_advisor_runs").delete().eq("profile_id", profileId);

  // 4c. boost_campaigns — VERIFIED: wallet_ledger_entries.campaign_id, leads.
  // campaign_id, profile_views.boost_campaign_id, and jitsu_events.
  // boost_campaign_id are ALL "ON DELETE SET NULL" (not CASCADE, not
  // blocking) — so hard-deleting a campaign row would silently strip its
  // campaign_id off the financial ledger (wallet_ledger_entries), degrading
  // a record that must be retained in full. Per the decided rule: do NOT
  // delete boost_campaigns rows. Scrub content/creative/targeting/Meta ids
  // in place instead; every financial/stat/status column is left untouched.
  if (allCampaignIds.length) {
    await admin
      .from("boost_campaigns")
      .update({
        name: null,
        description: null,
        headline: null,
        primary_text: null,
        creative_asset_url: null,
        creative_format: null,
        cta_type: null,
        notes: null,
        target_audience: null,
        campaign_template: null,
        utm_campaign: null,
        utm_content: null,
        utm_medium: null,
        utm_source: null,
        utm_url: null,
        meta_campaign_id: null,
        meta_adset_id: null,
        meta_ad_id: null,
        meta_creative_id: null,
        meta_sync_status: null,
        meta_sync_error: null,
        meta_delivery_status: null,
        meta_delivery_status_detail: null,
        meta_synced_at: null,
      })
      .eq("profile_id", profileId);
  }

  // 4d. KEEP, untouched: wallet_ledger_entries, management_fee_charges,
  // ios_subscriptions, ad_spend_wallets, invite_codes, invite_code_redemptions,
  // campaign_budgets (CASCADE child of boost_campaigns, which survives).

  // 4e. Scrub the profiles row. Split into two sequential updates — see 4f.
  const placeholderSlug = `deleted-${profileId}`;
  const { error: scrubAErr } = await admin
    .from("profiles")
    .update({
      email: null,
      first_name: null,
      last_name: null,
      name: null,
      brand_name: null,
      bio: null,
      city: null,
      avatar_url: null,
      avatar_focal_x: null,
      avatar_focal_y: null,
      avatar_zoom: null,
      website_url: null,
      social_instagram: null,
      social_youtube: null,
      social_facebook: null,
      social_linkedin: null,
      social_tiktok: null,
      social_twitter: null,
      widget_spotify: null,
      widget_soundcloud: null,
      widget_bandsintown: null,
      widget_mixcloud: null,
      widget_muso: null,
      scheduling_provider: null,
      scheduling_url: null,
      shop_provider: null,
      shop_store_url: null,
      beatstars_url: null,
      external_link_url: null,
      external_link_label: null,
      external_privacy_url: null,
      action_button_source: null,
      action_button_link_id: null,
      company_name: null,
      company_address: null,
      company_city: null,
      company_country: null,
      company_tax_id: null,
      company_zip: null,
      legal_form: null,
      vat_id: null,
      trade_register_court: null,
      trade_register_number: null,
      responsible_person: null,
      regulatory_body: null,
      dpo_email: null,
      pixel_facebook: null,
      pixel_google: null,
      pixel_hubspot: null,
      pixel_linkedin: null,
      pixel_tiktok: null,
      custom_domain: null,
      custom_domain_verified: false,
      location_iso: null,
      referred_by_code: null,
      availability_status: null,
      // Silences generate_claim_token_for_trigger()'s regeneration (it only
      // fires when is_claimed = false AND claim_token IS NULL) — see 4f.
      is_claimed: true,
      // Watched by on_profile_hubspot_sync — see 4f for why this update (A)
      // deliberately still has the REAL hubspot_contact_id in place, and why
      // that id is only nulled afterward, in update B.
      is_published: false,
      slug: placeholderSlug,
    })
    .eq("id", profileId);
  if (scrubAErr) {
    await logStep(admin, profileId, "profile_scrub_a", "failed", scrubAErr.message);
    return json({ error: "Profile scrub failed", failed_steps: failedSteps }, 500);
  }
  await logStep(admin, profileId, "profile_scrub_a", "ok");

  // Update B — identity severance, run AFTER A so on_profile_hubspot_sync (if
  // it fired above) saw the real hubspot_contact_id (harmless PATCH attempt
  // against an already-archived contact — see step 3), not a null one (which
  // would make the sync function CREATE a brand-new contact with scrubbed
  // garbage data). None of these columns are in that trigger's watched list,
  // so this update does not re-fire it.
  const { error: scrubBErr } = await admin
    .from("profiles")
    .update({
      hubspot_contact_id: null,
      hubspot_portal_id: null,
      hubspot_tracking_enabled: false,
      stripe_customer_id: null,
      stripe_customer_id_test: null,
      stripe_connect_id: null,
      stripe_connect_id_test: null,
      stripe_connect_status: null,
      stripe_connect_status_test: null,
      apns_device_token: null,
      claim_token: null,
      user_id: null,
    })
    .eq("id", profileId);
  if (scrubBErr) {
    await logStep(admin, profileId, "profile_scrub_b", "failed", scrubBErr.message);
    return json({ error: "Profile scrub failed", failed_steps: failedSteps }, 500);
  }
  await logStep(admin, profileId, "profile_scrub_b", "ok");

  // ── Step 5: delete the auth user last ─────────────────────────────────────
  // Only possible now that profiles.user_id is NULL — profiles_user_id_fkey
  // has no ON DELETE clause (defaults to NO ACTION), so this would otherwise
  // fail while any profile row still referenced it.
  const { error: delUserErr } = await admin.auth.admin.deleteUser(authUserId);
  if (delUserErr && !/not.*found/i.test(delUserErr.message)) {
    await logStep(admin, profileId, "auth_user_delete", "failed", delUserErr.message);
    failedSteps.push("auth_user_delete");
  } else {
    await logStep(admin, profileId, "auth_user_delete", "ok");
  }

  return json({ ok: true, failed_steps: failedSteps });
});
