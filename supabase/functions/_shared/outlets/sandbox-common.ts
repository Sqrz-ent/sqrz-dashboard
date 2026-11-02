// Helpers shared by the microsoft / snapchat / openai / spotify sandbox adapters.
// (google.ts predates this file and keeps its own copies; it is untouched.)

import { ConfigError, type CreateCampaignInput, type InsightsQuery, OutletError, ParamError } from "./types.ts";

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
