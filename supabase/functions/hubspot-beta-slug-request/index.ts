import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public-facing (verify_jwt: false) — invoked directly from the marketing
// site's (sqrz-cast) beta-request popup, an anonymous browser with no
// Supabase session and no profiles row to enrich from. This is why it's a
// new lightweight function rather than triggering hubspot-sync-contact:
// that one is wired to profile_hubspot_enrichment (a view over profiles) and
// writes back profiles.hubspot_contact_id — neither exists for a visitor who
// hasn't signed up. The HubSpot auth/create/dedup approach below is the same
// one hubspot-sync-contact already uses (HUBSPOT_TOKEN bearer, create ->
// on 409 duplicate-email search+patch instead), not a second connection
// method.
//
// No custom `sqrz_*` contact properties — same constraint already documented
// for hubspot-sync-contact/hubspot-sync-deal (this HubSpot plan 400s on
// PROPERTY_DOESNT_EXIST for anything custom, confirmed twice before, not
// re-attempted here). The slug + advertising-budget answer are folded into
// the standard `message` property instead (HubSpot's own default "message
// or comments a contact may want to leave on a form" field) rather than the
// literal `beta_slug_requested`/`advertising_budget` property names that
// would 400 on this plan.

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  let body: { slug?: string; email?: string; ad_budget?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, code: "invalid_json" }, 400);
  }

  const slug = (body.slug ?? "").trim().toLowerCase();
  const email = (body.email ?? "").trim();
  const adBudget = (body.ad_budget ?? "").trim();

  if (!slug) return json({ ok: false, code: "missing_slug", message: "A slug is required." }, 400);
  if (!email || !EMAIL_RE.test(email)) {
    return json({ ok: false, code: "invalid_email", message: "A valid email is required." }, 400);
  }

  // ── HubSpot: create, or on a duplicate-email 409, find + patch instead ──
  // Same approach as hubspot-sync-contact — no profile-specific fields here,
  // just email + the free-text message property (see the file-header note on
  // why not custom properties).
  const messageLines = [`Beta slug requested: ${slug}`];
  if (adBudget) messageLines.push(`Advertising budget: ${adBudget}`);
  const properties: Record<string, string> = {
    email,
    message: messageLines.join(" | "),
  };

  let hsRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  let hubspotContactId: string | null = null;

  if (hsRes.status === 409) {
    // Duplicate email — find the existing contact and update it instead.
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["id"],
        limit: 1,
      }),
    });
    const searchData = await searchRes.json();
    const foundId = searchData?.results?.[0]?.id;
    if (foundId) {
      hubspotContactId = foundId;
      hsRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${foundId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      });
    }
  }

  if (!hsRes.ok) {
    const err = await hsRes.text();
    console.error("HubSpot contact error:", hsRes.status, err);
    return json({ ok: false, code: "hubspot_error", message: "Something went wrong — please try again." }, 502);
  }

  if (!hubspotContactId) {
    const hsData = await hsRes.json();
    hubspotContactId = hsData.id;
  }

  // ── Insert the slug hold (service role — beta_slug_holds has no public
  // write policy). A duplicate still-unclaimed slug hits the table's
  // unique(slug) constraint (23505); surfaced as a clean 409 the popup can
  // render as "already reserved" instead of a raw DB error. ──
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { error: insertError } = await supabase
    .from("beta_slug_holds")
    .insert({ slug, hubspot_contact_id: hubspotContactId });

  if (insertError) {
    if (insertError.code === "23505") {
      return json(
        { ok: false, code: "slug_taken", message: "This name is already reserved." },
        409
      );
    }
    console.error("beta_slug_holds insert error:", insertError);
    return json({ ok: false, code: "db_error", message: "Something went wrong — please try again." }, 500);
  }

  return json({ ok: true, hubspot_contact_id: hubspotContactId });
});
