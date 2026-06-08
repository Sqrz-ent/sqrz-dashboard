import { createClient } from "jsr:@supabase/supabase-js@2";

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function extractDomain(url: string): string | null {
  if (!url) return null;
  try {
    if (!url.startsWith("http")) url = "https://" + url;
    const domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return domain || null;
  } catch {
    return null;
  }
}

async function fetchAllHubspotCompanies(): Promise<Map<string, string>> {
  const domainMap = new Map<string, string>();
  let after: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      limit: "100",
      properties: "domain,website",
      ...(after ? { after } : {}),
    });

    const resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/companies?${params}`,
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    if (!resp.ok) throw new Error(`HubSpot error: ${resp.status}`);
    const data = await resp.json();

    for (const company of data.results) {
      const domain =
        company.properties.domain ||
        extractDomain(company.properties.website || "");
      if (domain) domainMap.set(domain, company.id);
    }

    after = data.paging?.next?.after;
    if (!after) break;
  }

  return domainMap;
}

Deno.serve(async () => {
  try {
    console.log("Fetching HubSpot companies...");
    const domainMap = await fetchAllHubspotCompanies();
    console.log(`Fetched ${domainMap.size} HubSpot companies`);

    let matched = 0;
    let unmatched = 0;
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data: rows, error } = await supabase
        .table("venues")
        .select("id, site")
        .is("hubspot_company_id", null)
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      if (!rows || rows.length === 0) break;

      const updates: { id: string; hubspot_company_id: string }[] = [];

      for (const row of rows) {
        const domain = extractDomain(row.site || "");
        if (!domain) { unmatched++; continue; }
        const hsId = domainMap.get(domain);
        if (hsId) {
          updates.push({ id: row.id, hubspot_company_id: hsId });
          matched++;
        } else {
          unmatched++;
        }
      }

      if (updates.length > 0) {
        const { error: upsertError } = await supabase
          .table("venues")
          .upsert(updates);
        if (upsertError) throw upsertError;
      }

      console.log(`Batch offset=${offset}: matched ${updates.length}`);
      offset += pageSize;
      if (rows.length < pageSize) break;
    }

    return Response.json({ success: true, matched, unmatched });
  } catch (err) {
    console.error(err);
    return Response.json({ success: false, error: String(err) }, { status: 500 });
  }
});