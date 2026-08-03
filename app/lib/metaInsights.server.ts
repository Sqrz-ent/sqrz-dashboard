// Meta Graph API insights-fetch, shared by the on-demand single-campaign
// refresh (api/campaigns/refresh-stats.tsx). Deliberately mirrors — not
// imports — supabase/functions/meta-insights-sync/index.ts's fetch/parse
// logic: the scheduled job runs as a Deno edge function and this runs in the
// Node dashboard server, so there's no cross-runtime module to share. Keep
// both in sync by hand if Meta's API shape or field selection ever changes.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const DATE_PRESET = process.env.META_DATE_PRESET ?? "last_30d";

// Meta returns every numeric metric as a STRING — always cast before writing.
const toInt = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Math.round(Number(v));
const toNum = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

export type MetaInsights = {
  impressions: number | null;
  reach: number | null;
  link_clicks: number | null;
  cpc: number | null;
  cpm: number | null;
  spend: number | null;
};

export type MetaAdAccountToken = {
  ad_account_id: string;
  system_user_token: string;
};

async function metaGet(
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Token in the Authorization header (not the query string) so it never lands
  // in any URL log.
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | undefined;
  if (!res.ok || err) {
    throw new Error(`Meta ${path} → ${res.status}${err?.message ? ` ${err.message}` : ""}`);
  }
  return body;
}

// Throws when the token can't access the campaign (caller tries the next
// account's token); returns null when it CAN access the campaign but there
// was no delivery in the window — matches meta-insights-sync's fetchInsights.
async function fetchInsights(metaCampaignId: string, token: string): Promise<MetaInsights | null> {
  // stat_link_clicks ← inline_link_clicks (link clicks specifically, not all
  // clicks); stat_cost_per_click ← Meta's cpc.
  const body = await metaGet(`${metaCampaignId}/insights`, token, {
    fields: "impressions,reach,inline_link_clicks,cpc,cpm,spend",
    date_preset: DATE_PRESET,
  });
  const row = (body.data as Record<string, unknown>[] | undefined)?.[0];
  if (!row) return null;
  return {
    impressions: toInt(row.impressions),
    reach: toInt(row.reach),
    link_clicks: toInt(row.inline_link_clicks),
    cpc: toNum(row.cpc),
    cpm: toNum(row.cpm),
    spend: toNum(row.spend),
  };
}

/**
 * Resolves which active ad account owns `metaCampaignId` by ATTEMPTING the
 * insights call with each account's token until one succeeds — the same
 * approach the scheduled sync uses (see meta-insights-sync's module doc
 * comment). Listing campaigns per-account is NOT used for this: it omits
 * paused campaigns by default and can bury a target behind hundreds of
 * archived rows, while `/{campaign_id}/insights` works regardless of status.
 *
 * `owned: false` means no active account's token could access the campaign
 * (matches the scheduled job's "unresolved" case) — not an error, just
 * nothing to write.
 */
export async function fetchInsightsResolvingAccount(
  metaCampaignId: string,
  accounts: MetaAdAccountToken[],
): Promise<{ owned: boolean; insights: MetaInsights | null }> {
  for (const acct of accounts) {
    try {
      const insights = await fetchInsights(metaCampaignId, acct.system_user_token);
      return { owned: true, insights };
    } catch {
      // This token can't access the campaign — try the next account.
    }
  }
  return { owned: false, insights: null };
}
