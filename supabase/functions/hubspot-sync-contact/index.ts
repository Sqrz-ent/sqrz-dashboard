import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: { type: string; record: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { type, record } = payload;

  if (type !== "INSERT" && type !== "UPDATE") {
    return new Response("Ignored", { status: 200 });
  }

  const email = record.email as string | null;
  if (!email) {
    return new Response("No email, skipping", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Enrichment view still carries the default-field values we need
  // (first_name, last_name, city, website_url, hubspot_contact_id).
  const { data: enriched, error } = await supabase
    .from("profile_hubspot_enrichment")
    .select("*")
    .eq("id", record.id as string)
    .single();

  if (error || !enriched) {
    console.error("Enrichment fetch error:", error);
    return new Response("Failed to fetch enriched profile", { status: 500 });
  }

  // Default HubSpot contact properties only. Custom sqrz_* properties are no
  // longer available on the current HubSpot plan (they 400 with
  // PROPERTY_DOESNT_EXIST), so they were removed — same treatment as the deal sync.
  const properties: Record<string, string> = {
    email,
    ...(enriched.first_name ? { firstname: enriched.first_name } : {}),
    ...(enriched.last_name ? { lastname: enriched.last_name } : {}),
    ...(enriched.city ? { city: enriched.city } : {}),
    ...(enriched.website_url ? { website: enriched.website_url } : {}),
  };

  const existingHubspotId = enriched.hubspot_contact_id as string | null;
  let hubspotContactId = existingHubspotId;
  let hsRes: Response;

  if (existingHubspotId) {
    hsRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${existingHubspotId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      }
    );
  } else {
    hsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      }
    );

    if (hsRes.status === 409) {
      // Duplicate email — find the existing contact and update it instead
      // (dedup for pre-SQRZ contacts). Unaffected by the property change.
      const searchRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
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
        }
      );
      const searchData = await searchRes.json();
      const foundId = searchData?.results?.[0]?.id;
      if (foundId) {
        hubspotContactId = foundId;
        hsRes = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${foundId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${HUBSPOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ properties }),
          }
        );
      }
    }
  }

  if (!hsRes!.ok) {
    const err = await hsRes!.text();
    console.error("HubSpot contact error:", hsRes!.status, err);
    return new Response(`HubSpot error: ${err}`, { status: 500 });
  }

  const hsData = await hsRes!.json();
  hubspotContactId = hubspotContactId ?? hsData.id;

  if (hubspotContactId && !existingHubspotId) {
    await supabase
      .from("profiles")
      .update({ hubspot_contact_id: hubspotContactId })
      .eq("id", record.id as string);
  }

  return new Response(JSON.stringify({ ok: true, hubspot_contact_id: hubspotContactId }), {
    headers: { "Content-Type": "application/json" },
  });
});
