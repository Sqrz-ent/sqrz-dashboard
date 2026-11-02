import {
  assertSqrzLandingUrl, cachedToken, checkBudget, checkNumericIds, checkTexts, DRY_RUN_ID,
  fetchAsBlob, httpJson, num, optionalEnv, rejectGeo, requireEnv, resolveDateRange, sleep,
} from "./sandbox-common.ts";
import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult,
  OutletError, type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult,
  type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Advertising (Bing Ads) outlet adapter — SANDBOX ONLY.
//
// Uses the Campaign Management v13 REST (JSON) endpoints, not SOAP.
// Environment: MICROSOFT_ADS_ENV = "sandbox" (default) | "production".
//   sandbox    → campaign.api.sandbox.bingads.microsoft.com (+ the universal
//                sandbox developer token as a fallback if no token is set)
//   production → campaign.api.bingads.microsoft.com
//
// What we create: a SEARCH campaign (PAUSED) → ad group (PAUSED) → Responsive
// Search Ad (PAUSED) with final URL https://<slug>.sqrz.com. No keywords, no
// geo targeting (add them in the UI before enabling anything).
//
// VERIFIED (against Microsoft's reference, via search snippets): REST base
// hosts; AddCampaigns = POST /CampaignManagement/v13/Campaigns with
// { AccountId, Campaigns[] }; QueryByAccountId = POST /Campaigns/QueryByAccountId
// with { AccountId, CampaignType }; performance data comes from the Reporting
// service as CSV (no combined metadata+metrics JSON endpoint); headers
// DeveloperToken / CustomerId / CustomerAccountId + OAuth bearer; the universal
// sandbox developer token.
// UNVERIFIED (written from the SOAP object model, could not be checked): the
// AdGroups / Ads / Media / update paths and HTTP verbs, the AdGroup and
// ResponsiveSearchAd field names, the Reporting REST paths and request/poll
// shape, the zipped-CSV report download, and the OAuth scope string.
// `validate_only: true` sends NOTHING and returns the request bodies built.
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_DEV_TOKEN = "BBD37VB98"; // Microsoft's published universal sandbox developer token

export type MicrosoftConfig = {
  env: "sandbox" | "production";
  developerToken: string;
  clientId: string;
  clientSecret: string; // optional for public clients
  refreshToken: string;
  customerId: string;
  accountId: string;
  defaultCpc: number;
};

export function microsoftConfigFromEnv(): MicrosoftConfig {
  const rawEnv = optionalEnv("MICROSOFT_ADS_ENV", "sandbox").toLowerCase();
  if (rawEnv !== "sandbox" && rawEnv !== "production") {
    throw new ConfigError(`MICROSOFT_ADS_ENV must be "sandbox" or "production", got "${rawEnv}"`);
  }
  const s = requireEnv(["MICROSOFT_ADS_CLIENT_ID", "MICROSOFT_ADS_REFRESH_TOKEN", "MICROSOFT_ADS_CUSTOMER_ID", "MICROSOFT_ADS_ACCOUNT_ID"] as const);
  const devToken = optionalEnv("MICROSOFT_ADS_DEVELOPER_TOKEN") || (rawEnv === "sandbox" ? SANDBOX_DEV_TOKEN : "");
  if (!devToken) throw new ConfigError("missing secrets: MICROSOFT_ADS_DEVELOPER_TOKEN (required for production)");
  return {
    env: rawEnv,
    developerToken: devToken,
    clientId: s.MICROSOFT_ADS_CLIENT_ID,
    clientSecret: optionalEnv("MICROSOFT_ADS_CLIENT_SECRET"),
    refreshToken: s.MICROSOFT_ADS_REFRESH_TOKEN,
    customerId: s.MICROSOFT_ADS_CUSTOMER_ID,
    accountId: s.MICROSOFT_ADS_ACCOUNT_ID,
    defaultCpc: Number(optionalEnv("MICROSOFT_ADS_DEFAULT_CPC", "0.5")),
  };
}

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE = "https://ads.microsoft.com/msads.manage offline_access"; // unverified scope string

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => {
  const parts: string[] = [];
  for (const e of b?.OperationErrors ?? b?.Errors ?? []) parts.push(`${e.Code ?? ""} ${e.Message ?? e.Details ?? ""}`.trim());
  if (b?.Message) parts.push(b.Message);
  if (b?.error_description) parts.push(b.error_description);
  return parts.join(" — ");
};

// deno-lint-ignore no-explicit-any
function partialErrors(label: string, body: any): void {
  const errs = (body?.PartialErrors ?? []).filter(Boolean);
  if (errs.length) {
    // deno-lint-ignore no-explicit-any
    throw new OutletError(`${label} partial errors: ${errs.map((e: any) => `${e.Code ?? ""} ${e.Message ?? ""} ${e.Details ?? ""}`.trim()).join("; ")}`, body);
  }
}

// ── minimal zip reader (Reporting downloads are zipped) ──────────────────────
async function unzipFirst(buf: Uint8Array): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new OutletError("report download is not a zip file");
  const cd = dv.getUint32(eocd + 16, true);
  if (dv.getUint32(cd, true) !== 0x02014b50) throw new OutletError("bad zip central directory");
  const method = dv.getUint16(cd + 10, true);
  const compSize = dv.getUint32(cd + 20, true);
  const localOff = dv.getUint32(cd + 42, true);
  const nameLen = dv.getUint16(localOff + 26, true);
  const extraLen = dv.getUint16(localOff + 28, true);
  const start = localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new OutletError(`unsupported zip compression method ${method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export class MicrosoftAdsAdapter implements OutletAdapter {
  readonly name = "microsoft" as const;
  constructor(private readonly cfg: MicrosoftConfig) {}

  private get campaignBase() {
    return this.cfg.env === "sandbox"
      ? "https://campaign.api.sandbox.bingads.microsoft.com/CampaignManagement/v13"
      : "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";
  }
  private get reportingBase() {
    return this.cfg.env === "sandbox"
      ? "https://reporting.api.sandbox.bingads.microsoft.com/Reporting/v13"
      : "https://reporting.api.bingads.microsoft.com/Reporting/v13";
  }

  private accessToken(): Promise<string> {
    const c = this.cfg;
    return cachedToken(`ms:${c.clientId}:${c.refreshToken}`, async () => {
      const form = new URLSearchParams({ client_id: c.clientId, grant_type: "refresh_token", refresh_token: c.refreshToken, scope: SCOPE });
      if (c.clientSecret) form.set("client_secret", c.clientSecret);
      const b = await httpJson("OAuth refresh", TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
      }, fmtErr);
      if (!b.access_token) throw new OutletError("OAuth refresh returned no access_token", b);
      // NB: Microsoft rotates refresh tokens; b.refresh_token is NOT persisted (no secret writes here).
      return { token: b.access_token, expiresInSec: Number(b.expires_in ?? 3600) };
    });
  }

  // deno-lint-ignore no-explicit-any
  private async call(label: string, base: string, method: string, path: string, body: unknown): Promise<any> {
    const token = await this.accessToken();
    const b = await httpJson(`${method} ${label}`, `${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        DeveloperToken: this.cfg.developerToken,
        CustomerId: this.cfg.customerId,
        CustomerAccountId: this.cfg.accountId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, fmtErr);
    partialErrors(label, b);
    return b;
  }

  async ping(): Promise<PingResult> {
    const b = await this.call("Campaigns/QueryByAccountId", this.campaignBase, "POST", "/Campaigns/QueryByAccountId",
      { AccountId: this.cfg.accountId, CampaignType: "Search" });
    const n = (b.Campaigns ?? []).filter(Boolean).length;
    return { ok: true, detail: `${this.cfg.env}: account ${this.cfg.accountId}, ${n} Search campaign(s) visible`, raw: { env: this.cfg.env, campaigns: n } };
  }

  /** Image media only (Audience/Multimedia ads). Search RSAs need no media. UNVERIFIED shape. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 10 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    if (!/^image\/(png|jpe?g)$/.test(ct)) throw new ParamError("microsoft upload_asset supports png/jpeg images only");
    const data = btoa(String.fromCharCode(...new Uint8Array(await f.blob.arrayBuffer())));
    const b = await this.call("Media", this.campaignBase, "POST", "/Media", {
      AccountId: this.cfg.accountId,
      Media: [{ Type: "Image", MediaType: "Image", Data: data, Name: input.title.slice(0, 100) }],
    });
    const id = String(b.MediaIds?.[0] ?? "");
    if (!id) throw new OutletError("AddMedia returned no MediaIds", b);
    return { externalId: id, visibility: "account-library", objects: [{ objectType: "media", externalId: id, raw: b }], raw: b };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "microsoft");
    assertSqrzLandingUrl(input.landingUrl);
    // Responsive Search Ad limits: 3–15 headlines ≤30, 2–4 descriptions ≤90.
    checkTexts("headlines", input.headlines, { min: 3, max: 30, maxCount: 15 });
    checkTexts("descriptions", input.descriptions, { min: 2, max: 90, maxCount: 4 });
    checkBudget(input.dailyBudgetCents, 1);
    const name = `[SANDBOX] ${input.name}`.slice(0, 128);

    const campaign = {
      AccountId: this.cfg.accountId,
      Campaigns: [{
        Name: name, CampaignType: "Search", Status: "Paused",
        BudgetType: "DailyBudgetStandard", DailyBudget: input.dailyBudgetCents / 100, Languages: ["All"],
      }],
    };
    const adGroup = (campaignId: string) => ({
      CampaignId: campaignId,
      AdGroups: [{ Name: `${name} ad group`.slice(0, 256), Status: "Paused", CpcBid: { Amount: this.cfg.defaultCpc } }],
    });
    const ad = (adGroupId: string) => ({
      AdGroupId: adGroupId,
      Ads: [{
        Type: "ResponsiveSearch", Status: "Paused", FinalUrls: [input.landingUrl],
        Headlines: input.headlines.map((Text) => ({ Text })),
        Descriptions: input.descriptions.map((Text) => ({ Text })),
      }],
    });

    if (input.validateOnly) {
      return {
        status: "PAUSED", campaignId: DRY_RUN_ID, adGroupId: DRY_RUN_ID, adId: DRY_RUN_ID, budgetId: DRY_RUN_ID,
        validateOnly: true, objects: [],
        raw: { dryRun: true, env: this.cfg.env, requests: [
          { POST: "/Campaigns", body: campaign }, { POST: "/AdGroups", body: adGroup("<campaignId>") }, { POST: "/Ads", body: ad("<adGroupId>") },
        ] },
      };
    }

    const objects: OutletObject[] = [];
    try {
      const c = await this.call("Campaigns", this.campaignBase, "POST", "/Campaigns", campaign);
      const campaignId = String(c.CampaignIds?.[0] ?? "");
      if (!campaignId) throw new OutletError("AddCampaigns returned no CampaignIds", c);
      objects.push({ objectType: "campaign", externalId: campaignId, raw: { status: "Paused", landingUrl: input.landingUrl } });

      const g = await this.call("AdGroups", this.campaignBase, "POST", "/AdGroups", adGroup(campaignId));
      const adGroupId = String(g.AdGroupIds?.[0] ?? "");
      if (!adGroupId) throw new OutletError("AddAdGroups returned no AdGroupIds", g);
      objects.push({ objectType: "ad_group", externalId: adGroupId, parentExternalId: campaignId });

      const a = await this.call("Ads", this.campaignBase, "POST", "/Ads", ad(adGroupId));
      const adId = String(a.AdIds?.[0] ?? "");
      if (!adId) throw new OutletError("AddAds returned no AdIds", a);
      objects.push({ objectType: "ad", externalId: adId, parentExternalId: adGroupId });

      // Microsoft has no separate budget entity here — the campaign carries DailyBudget.
      return { status: "PAUSED", campaignId, adGroupId, adId, budgetId: campaignId, validateOnly: false, objects, raw: { c, g, a } };
    } catch (e) {
      // Objects created so far stay (all PAUSED). Surface them so they get logged for manual cleanup.
      throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
    }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const d = (s: string) => { const [Year, Month, Day] = s.split("-").map(Number); return { Day, Month, Year }; };
    const submit = await this.call("GenerateReport/Submit", this.reportingBase, "POST", "/GenerateReport/Submit", {
      ReportRequest: {
        Type: "CampaignPerformanceReportRequest", ReportName: "sqrz-sandbox-insights", Format: "Csv",
        ReturnOnlyCompleteData: false, Aggregation: "Summary", ExcludeReportHeader: true, ExcludeReportFooter: true,
        Scope: { AccountIds: [Number(this.cfg.accountId)] },
        Time: { CustomDateRangeStart: d(from), CustomDateRangeEnd: d(to) },
        Columns: ["CampaignId", "CampaignName", "CampaignStatus", "Spend", "Impressions", "Clicks", "CurrencyCode"],
      },
    });
    const reqId = submit.ReportRequestId;
    if (!reqId) throw new OutletError("GenerateReport/Submit returned no ReportRequestId", submit);

    let url: string | null = null;
    for (let i = 0; i < 20 && !url; i++) {
      await sleep(2000);
      const p = await this.call("GenerateReport/Poll", this.reportingBase, "POST", "/GenerateReport/Poll", { ReportRequestId: reqId });
      const st = p.ReportRequestStatus ?? {};
      if (st.Status === "Error") throw new OutletError("report generation failed", p);
      if (st.Status === "Success") url = st.ReportDownloadUrl ?? "";
    }
    const notes = ["Microsoft Search campaigns have no video views; videoViews is null."];
    if (url === null) return { rows: [], notes: [...notes, `report ${reqId} not ready after 40s; retry later`] };
    if (url === "") return { rows: [], notes: [...notes, "report succeeded with no data (ReportDownloadUrl empty)"] };

    const res = await fetch(url);
    if (!res.ok) throw new OutletError(`report download → ${res.status}`);
    const csv = await unzipFirst(new Uint8Array(await res.arrayBuffer()));
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const hIdx = lines.findIndex((l) => l.includes("CampaignId"));
    if (hIdx < 0) return { rows: [], notes: [...notes, "no CampaignId header in report"] };
    const head = parseCsvLine(lines[hIdx]).map((h) => h.trim());
    const col = (r: string[], n: string) => r[head.indexOf(n)] ?? "";
    const rows: InsightRow[] = [];
    for (const l of lines.slice(hIdx + 1)) {
      const r = parseCsvLine(l);
      const id = col(r, "CampaignId");
      if (!/^\d+$/.test(id)) continue; // skip footer lines
      if (query.campaignIds?.length && !query.campaignIds.includes(id)) continue;
      rows.push({
        campaignId: id, campaignName: col(r, "CampaignName"), channelType: "SEARCH", status: col(r, "CampaignStatus"),
        currency: col(r, "CurrencyCode") || null, spend: num(col(r, "Spend")), impressions: num(col(r, "Impressions")),
        clicks: num(col(r, "Clicks")), videoViews: null,
      });
    }
    return { rows, notes };
  }

  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    if (!/^\d+$/.test(campaignId)) throw new ParamError("campaign_id must be numeric");
    const raw = await this.call("Campaigns(update)", this.campaignBase, "PUT", "/Campaigns", {
      AccountId: this.cfg.accountId, Campaigns: [{ Id: campaignId, Status: "Paused" }],
    });
    return { campaignId, status: "PAUSED", raw };
  }
}
