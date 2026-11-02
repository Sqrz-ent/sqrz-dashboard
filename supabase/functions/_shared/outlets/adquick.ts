import {
  assertSqrzLandingUrl, checkBudget, checkNumericIds, checkTexts, dryRunResult, extraStr, extraStrList, fetchAsBlob, fileNameFor, firstArray,
  httpJson, majorStr, num, rejectGeo, requireEnv, resolveDateRange, rethrowWithCreated,
} from "./sandbox-common.ts";
import {
  type CreateCampaignInput, type CreatedCampaign, type InsightRow, type InsightsQuery, type InsightsResult, OutletError,
  type OutletAdapter, type OutletObject, ParamError, type PauseResult, type PingResult, type UploadAssetInput, type UploadedAsset,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// AdQuick Partner API outlet adapter (DOOH / billboards) — SANDBOX ONLY.
// Base https://api.adquick.com, static partner token in header X-PARTNER-TOKEN
// (issued by AdQuick to partners — see docs/outlets/adquick.md).
//
// MAPPING: out-of-home buying has no campaign/ad-group/ad. create_campaign builds:
//   plan (status "draft")  → insertion order (status "draft") → creative attached to it.
//   campaignId = plan id · adGroupId = insertion order id · adId = creative id.
// Required extra: start_date, end_date (YYYY-MM-DD, a flight). Optional extra:
// markets (array of market names/DMA codes), formats (array, e.g. "digital_billboard").
// Budget = daily_budget_cents × flight days. The slug URL is stored as the creative's
// destination/QR URL. Nothing is booked/submitted: drafts only.
//
// VERIFIED (via third-party profile files, NOT AdQuick's docs): partner REST API at
// https://api.adquick.com with a static X-PARTNER-TOKEN header, unversioned paths;
// AdQuick's integration covers creative upload, spec sheets and ordering. Account-gated.
// UNVERIFIED — EVERYTHING ELSE: every path, verb, body and response shape below
// (/plans, /plans/{id}/insertion_orders, /creatives, reporting, pause) is a plausible
// REST guess to be corrected against docs.adquick.com. `validate_only` shows the bodies.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://api.adquick.com";

export type AdQuickConfig = { token: string };

export function adquickConfigFromEnv(): AdQuickConfig {
  return { token: requireEnv(["ADQUICK_PARTNER_TOKEN"] as const).ADQUICK_PARTNER_TOKEN };
}

// deno-lint-ignore no-explicit-any
const fmtErr = (b: any): string => [b?.message, b?.error, ...(Array.isArray(b?.errors) ? b.errors.map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e).slice(0, 200))) : [])].filter(Boolean).join(" — ");

export class AdQuickAdapter implements OutletAdapter {
  readonly name = "adquick" as const;
  constructor(private readonly cfg: AdQuickConfig) {}

  // deno-lint-ignore no-explicit-any
  private api(method: string, path: string, body?: unknown, form?: FormData): Promise<any> {
    const headers: Record<string, string> = { "X-PARTNER-TOKEN": this.cfg.token, Accept: "application/json" };
    if (!form) headers["Content-Type"] = "application/json";
    return httpJson(`${method} ${path}`, `${BASE}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) }, fmtErr);
  }

  async ping(): Promise<PingResult> {
    const b = await this.api("GET", "/plans?limit=1");
    return { ok: true, detail: `api.adquick.com reachable, partner token accepted (${firstArray(b, ["plans", "data", "results"]).length} plan(s) in first page)`, raw: b };
  }

  /** Creative file (static image / video) into the partner library. UNVERIFIED request format. */
  async uploadAsset(input: UploadAssetInput): Promise<UploadedAsset> {
    const f = await fetchAsBlob(input.sourceUrl, 100 * 1024 * 1024);
    const ct = input.contentType ?? f.contentType;
    if (!/^(image|video)\//.test(ct)) throw new ParamError(`adquick upload_asset needs image/* or video/*, got ${ct}`);
    const form = new FormData();
    form.set("name", input.title.slice(0, 100)); form.set("file", f.blob, fileNameFor(input.title, ct));
    const b = await this.api("POST", "/creatives", undefined, form);
    const id = String(b?.id ?? b?.creative?.id ?? ""); if (!id) throw new OutletError("create creative returned no id", b);
    return { externalId: id, visibility: "partner-library", objects: [{ objectType: "creative", externalId: id, raw: { contentType: ct } }], raw: b };
  }

  async createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
    rejectGeo(input, "adquick");
    assertSqrzLandingUrl(input.landingUrl);
    const start = extraStr(input, "start_date"); const end = extraStr(input, "end_date");
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!start || !end || !re.test(start) || !re.test(end)) throw new ParamError("adquick create_campaign needs extra.start_date and extra.end_date (YYYY-MM-DD)");
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    if (!(days >= 1 && days <= 366)) throw new ParamError("flight must be 1–366 days (end_date >= start_date)");
    if (!input.assetId) throw new ParamError("adquick create_campaign needs asset_id (a creative id from upload_asset)");
    checkTexts("headlines", input.headlines, { max: 100, maxCount: 1 }); // plan name / creative title
    checkBudget(input.dailyBudgetCents, 100);
    const markets = extraStrList(input, "markets"); const formats = extraStrList(input, "formats");
    const name = `[SANDBOX] ${input.name}`.slice(0, 120);
    const total = Number(majorStr(input.dailyBudgetCents * days));

    const plan = { name, status: "draft", start_date: start, end_date: end, budget: total, ...(markets.length ? { markets } : {}), ...(formats.length ? { formats } : {}) };
    const io = (planId: string) => ({ plan_id: planId, name: `${name} IO`, status: "draft", start_date: start, end_date: end, budget: total });
    const attach = (ioId: string) => ({ creative_id: input.assetId, destination_url: input.landingUrl, title: input.headlines[0] });

    if (input.validateOnly) {
      return dryRunResult([
        { POST: "/plans", body: plan }, { POST: "/plans/<planId>/insertion_orders", body: io("<planId>") },
        { POST: "/insertion_orders/<ioId>/creatives", body: attach("<ioId>") },
      ], { flightDays: days, totalBudget: total, mapping: "campaignId=plan · adGroupId=insertion order · adId=creative attachment" });
    }

    const objects: OutletObject[] = [];
    try {
      const p = await this.api("POST", "/plans", plan);
      const pid = String(p?.id ?? p?.plan?.id ?? ""); if (!pid) throw new OutletError("create plan returned no id", p);
      objects.push({ objectType: "plan", externalId: pid, raw: { status: "draft", landingUrl: input.landingUrl, start, end, total } });
      const o = await this.api("POST", `/plans/${pid}/insertion_orders`, io(pid));
      const oid = String(o?.id ?? o?.insertion_order?.id ?? ""); if (!oid) throw new OutletError("create insertion order returned no id", o);
      objects.push({ objectType: "insertion_order", externalId: oid, parentExternalId: pid });
      const a = await this.api("POST", `/insertion_orders/${oid}/creatives`, attach(oid));
      const aid = String(a?.id ?? a?.creative?.id ?? input.assetId);
      objects.push({ objectType: "creative_attachment", externalId: aid, parentExternalId: oid });
      return { status: "PAUSED", campaignId: pid, adGroupId: oid, adId: aid, budgetId: pid, validateOnly: false, objects, raw: { p, o, a } };
    } catch (e) { rethrowWithCreated(e, objects); }
  }

  async getInsights(query: InsightsQuery = {}): Promise<InsightsResult> {
    checkNumericIds(query.campaignIds);
    const { from, to } = resolveDateRange(query);
    const list = await this.api("GET", "/plans?limit=100");
    // deno-lint-ignore no-explicit-any
    let plans: any[] = firstArray(list, ["plans", "data", "results"]);
    if (query.campaignIds?.length) plans = plans.filter((p) => query.campaignIds!.includes(String(p.id)));
    const rows: InsightRow[] = [];
    const notes = ["DOOH reporting is unverified: reads GET /plans/{id}/reports defensively; impressions are estimated plays/impressions, clicks are always 0."];
    for (const p of plans) {
      let m: Record<string, unknown> = {};
      try {
        const r = await this.api("GET", `/plans/${p.id}/reports?${new URLSearchParams({ start_date: from, end_date: to })}`);
        m = (Array.isArray(r?.data) ? r.data[0] : r?.report ?? r) ?? {};
      } catch (e) { notes.push(`report for ${p.id} failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`); }
      rows.push({ campaignId: String(p.id), campaignName: p.name ?? "", channelType: "DOOH", status: p.status ?? "", currency: p.currency ?? "USD",
        spend: num(m.spend ?? m.cost), impressions: num(m.impressions), clicks: 0, videoViews: null });
    }
    return { rows, notes };
  }

  /** There is no "pause" in OOH: moves the plan back to on-hold/draft. UNVERIFIED status value. */
  async pauseCampaign(campaignId: string): Promise<PauseResult> {
    checkNumericIds([campaignId]);
    const raw = await this.api("PATCH", `/plans/${campaignId}`, { status: "on_hold" });
    return { campaignId, status: "PAUSED", raw };
  }
}
