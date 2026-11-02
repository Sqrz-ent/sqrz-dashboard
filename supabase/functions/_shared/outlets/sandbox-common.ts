// Helpers shared by the sandbox adapters (all outlets except google).
// (google.ts predates this file and keeps its own copies; it is untouched.)

import {
  ConfigError, type CreateCampaignInput, type CreatedCampaign, type InsightsQuery, OutletError, type OutletObject, ParamError,
} from "./types.ts";

/** Placeholder id returned by validate_only dry runs. */
export const DRY_RUN_ID = "(validate_only)";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads required secrets; throws one ConfigError naming every missing one. */
export function requireEnv<T extends string>(names: readonly T[]): Record<T, string> {
  const missing = names.filter((k) => !Deno.env.get(k)?.trim());
  if (missing.length) throw new ConfigError(`missing secrets: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((k) => [k, Deno.env.get(k)!.trim()])) as Record<T, string>;
}

export const optionalEnv = (name: string, fallback = ""): string => Deno.env.get(name)?.trim() || fallback;

/** Defense in depth behind the slug validation in the handler: only SQRZ profiles can be advertised. */
const SQRZ_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sqrz\.com\/?$/;
export function assertSqrzLandingUrl(url: string): void {
  if (!SQRZ_URL.test(url)) throw new ParamError(`landing URL must be https://<slug>.sqrz.com, got "${url}"`);
}

export function checkTexts(label: string, list: string[], o: { min?: number; max: number; maxCount: number }): void {
  const min = o.min ?? 1;
  if (list.length < min) throw new ParamError(`${label}: at least ${min} required`);
  if (list.length > o.maxCount) throw new ParamError(`${label}: at most ${o.maxCount}`);
  for (const t of list) {
    if (!t.trim() || t.length > o.max) throw new ParamError(`${label}: "${t}" must be 1–${o.max} chars`);
  }
}

export function checkBudget(cents: number, minCents = 1): void {
  if (!Number.isInteger(cents) || cents < minCents) {
    throw new ParamError(`daily_budget_cents must be an integer >= ${minCents}`);
  }
}

/** cents → micro units (1 currency unit = 1,000,000 micros). */
export const centsToMicros = (cents: number): number => cents * 10_000;

export function rejectGeo(input: CreateCampaignInput, outlet: string): void {
  if (input.geo) throw new ParamError(`geo targeting is not supported by the ${outlet} sandbox adapter yet`);
}

// ── Date ranges ──────────────────────────────────────────────────────────────

const PRESETS = [
  "TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH", "ALL_TIME",
] as const;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Explicit from/to, else a preset (default LAST_30_DAYS). UTC dates, YYYY-MM-DD. */
export function resolveDateRange(q: InsightsQuery): { from: string; to: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (q.from || q.to) {
    if (!q.from || !q.to || !re.test(q.from) || !re.test(q.to)) throw new ParamError("from/to must both be YYYY-MM-DD");
    return { from: q.from, to: q.to };
  }
  const preset = (q.datePreset ?? "LAST_30_DAYS").toUpperCase();
  if (!(PRESETS as readonly string[]).includes(preset)) {
    throw new ParamError(`date_preset must be one of ${PRESETS.join(", ")}`);
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (n: number) => new Date(today.getTime() - n * 86_400_000);
  switch (preset) {
    case "TODAY": return { from: ymd(today), to: ymd(today) };
    case "YESTERDAY": return { from: ymd(back(1)), to: ymd(back(1)) };
    case "LAST_7_DAYS": return { from: ymd(back(6)), to: ymd(today) };
    case "LAST_14_DAYS": return { from: ymd(back(13)), to: ymd(today) };
    case "THIS_MONTH": return { from: ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: ymd(today) };
    case "LAST_MONTH": {
      const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { from: ymd(first), to: ymd(last) };
    }
    case "ALL_TIME": return { from: "2015-01-01", to: ymd(today) };
    default: return { from: ymd(back(29)), to: ymd(today) };
  }
}

export function checkNumericIds(ids: string[] | undefined, label = "campaign id"): void {
  for (const id of ids ?? []) if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ParamError(`${label} has invalid characters: ${id}`);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * fetch + JSON parse + uniform error: throws OutletError("<label> → <status> <detail>")
 * with the parsed body attached, mirroring formatMetaError / formatGoogleError.
 * `fmt` extracts a readable message from an outlet-specific error body.
 */
// deno-lint-ignore no-explicit-any
export async function httpJson(label: string, url: string, init: RequestInit, fmt: (body: any) => string): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const rid = res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? res.headers.get("trackingid");
    const detail = fmt(body) || text.slice(0, 300);
    throw new OutletError(`${label} → ${res.status} ${detail}${rid ? ` (request_id=${rid})` : ""}`.trim(), body);
  }
  return body;
}

/** Downloads a source file into memory (multipart uploads need a Blob). */
export async function fetchAsBlob(url: string, maxBytes: number): Promise<{ blob: Blob; contentType: string; bytes: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new OutletError(`source download failed → ${res.status} ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len && len > maxBytes) throw new ParamError(`source is ${len} bytes; this adapter's limit is ${maxBytes}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ParamError(`source is ${buf.byteLength} bytes; this adapter's limit is ${maxBytes}`);
  const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  return { blob: new Blob([buf], { type: contentType }), contentType, bytes: buf.byteLength };
}

export function fileNameFor(title: string, contentType: string): string {
  const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `${title.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "asset"}.${ext}`;
}

// ── OAuth token cache (per isolate) ──────────────────────────────────────────

const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function cachedToken(key: string, load: () => Promise<{ token: string; expiresInSec: number }>): Promise<string> {
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const t = await load();
  tokens.set(key, { token: t.token, expiresAt: Date.now() + t.expiresInSec * 1000 });
  return t.token;
}

export const num = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));

// ── Additions for the second connector batch ─────────────────────────────────

/** Reads a string from CreateCampaignInput.extra. */
export function extraStr(input: CreateCampaignInput, key: string): string | undefined {
  const v = input.extra?.[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ParamError(`extra.${key} must be a string`);
  return v.trim();
}

export function extraStrList(input: CreateCampaignInput, key: string): string[] {
  const v = input.extra?.[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ParamError(`extra.${key} must be an array of strings`);
  return v.map((x) => x.trim()).filter(Boolean);
}

/** cents → "12.34" (major units as a string). */
export const majorStr = (cents: number): string => (cents / 100).toFixed(2);

/** validate_only result: nothing was sent; `requests` are the bodies the adapter would send. */
export function dryRunResult(requests: unknown[], raw: Record<string, unknown> = {}): CreatedCampaign {
  return {
    status: "PAUSED", campaignId: DRY_RUN_ID, adGroupId: DRY_RUN_ID, adId: DRY_RUN_ID, budgetId: DRY_RUN_ID,
    validateOnly: true, objects: [], raw: { dryRun: true, ...raw, requests },
  };
}

/** Re-throws a mid-chain failure carrying the objects created so far (they stay paused/draft; they get logged). */
export function rethrowWithCreated(e: unknown, objects: OutletObject[]): never {
  throw new OutletError(e instanceof Error ? e.message : String(e), e instanceof OutletError ? e.detail : undefined, objects);
}

/** Form-encoded OAuth2 token request (refresh_token / client_credentials), cached per isolate. */
export function oauthForm(
  cacheKey: string, url: string, fields: Record<string, string>,
  // deno-lint-ignore no-explicit-any
  opts: { basic?: { id: string; secret: string }; headers?: Record<string, string>; fmt?: (b: any) => string } = {},
): Promise<string> {
  return cachedToken(cacheKey, async () => {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", ...(opts.headers ?? {}) };
    if (opts.basic) headers.Authorization = `Basic ${btoa(`${opts.basic.id}:${opts.basic.secret}`)}`;
    const b = await httpJson("OAuth token", url, { method: "POST", headers, body: new URLSearchParams(fields).toString() },
      opts.fmt ?? ((x) => [x?.error_description, x?.error, x?.message].filter(Boolean).join(" — ")));
    if (!b.access_token) throw new OutletError("OAuth token response had no access_token", b);
    return { token: b.access_token, expiresInSec: Number(b.expires_in ?? 3600) };
  });
}

/** Unwraps list-ish responses: first array found among the common envelope keys. */
// deno-lint-ignore no-explicit-any
export function firstArray(body: any, keys: string[] = ["data", "items", "results", "rows", "elements", "campaigns"]): any[] {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

// ── OAuth 1.0a (HMAC-SHA1) — used by the X Ads API ───────────────────────────

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export async function oauth1Header(
  method: string, url: string, params: Record<string, string>,
  c: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string },
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.consumerKey, oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.token, oauth_version: "1.0",
  };
  const u = new URL(url);
  const all: [string, string][] = [...Object.entries(params), ...Object.entries(oauth), ...[...u.searchParams.entries()]];
  const norm = all.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const base = [method.toUpperCase(), rfc3986(`${u.origin}${u.pathname}`), rfc3986(norm)].join("&");
  const key = `${rfc3986(c.consumerSecret)}&${rfc3986(c.tokenSecret)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(base)))));
  const header = { ...oauth, oauth_signature: sig };
  return "OAuth " + Object.entries(header).map(([k2, v]) => `${rfc3986(k2)}="${rfc3986(v)}"`).join(", ");
}
