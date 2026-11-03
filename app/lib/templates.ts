// Campaign template helpers for the web Grow section (2026-11) — a port of
// sqrz-ios Models/CampaignTemplateConfig.swift and the card/lock rules in
// Features/Boost/BoostView.swift (isLocked / unlock rule / "Includes X of Pro").
// Same table (campaign_templates, RLS-filtered), same status rules.

export type CampaignTemplate = {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  long_description: string | null;
  image_file: string | null;
  display_price: number | null;
  iap_product_id: string | null;
  creative_source: string; // 'upload' | 'existing_post' | 'lead_form' | 'video_link'
  post_source: string | null;
  cta_type: string | null;
  allow_destination_choice: boolean;
  budget_options: number[];
  ad_budget_min: number | null;
  ad_budget_max: number | null;
  end_options: string[];
  access_tier: string; // 'free' | 'premium'
  requires_connected_page: boolean;
  requires_eligibility_check: boolean;
  delivery: string; // 'self_serve' | 'contact'
  status: string; // 'active' | 'coming_soon' | 'hidden'
  sort_order: number;
  outlet: string | null;
  outlets: unknown;
  budget_input: string | null; // 'required' (default) | 'included' | 'own_account'
  available_from: string | null;
  available_until: string | null;
  unlock_template_ids: string[] | null;
  unlock_min_count: number | null;
  unlock_label: string | null;
  pro_days: number | null;
};

// A web user always holds Pro (the whole dashboard is Pro-gated server-side), so
// iOS's "premium template without grow_access" lock can never apply here.
export function isComingSoon(t: CampaignTemplate): boolean {
  return t.status === "coming_soon";
}

// Outside the available_from/available_until window the row is treated as
// unavailable even though RLS still returns it (CampaignTemplateConfig.isWithinAvailabilityWindow).
export function isWithinAvailabilityWindow(t: CampaignTemplate, now = Date.now()): boolean {
  const from = t.available_from ? Date.parse(t.available_from) : null;
  const until = t.available_until ? Date.parse(t.available_until) : null;
  if (from != null && !Number.isNaN(from) && now < from) return false;
  if (until != null && !Number.isNaN(until) && now > until) return false;
  return true;
}

// Which templates the Grow tab lists: active/coming_soon, inside the window, by sort_order.
export function visibleTemplates(rows: CampaignTemplate[]): CampaignTemplate[] {
  return rows
    .filter((t) => (t.status === "active" || t.status === "coming_soon") && isWithinAvailabilityWindow(t))
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function isMetaOutlet(t: CampaignTemplate): boolean {
  const v = (t.outlet ?? "").trim().toLowerCase();
  return v === "" || v === "meta";
}

export function opensManagedCall(t: CampaignTemplate): boolean {
  return t.delivery === "contact";
}

export function requiresBudgetInput(t: CampaignTemplate): boolean {
  return (t.budget_input ?? "required") === "required";
}

export function outletPills(t: CampaignTemplate): string[] {
  return Array.isArray(t.outlets) ? (t.outlets as unknown[]).filter((o): o is string => typeof o === "string") : [];
}

// "Includes 3 months of Pro" (under 30 days: "Includes 10 days of Pro").
export function proIncludedText(t: CampaignTemplate): string | null {
  const d = t.pro_days;
  if (d == null || d <= 0) return null;
  if (d < 30) return `Includes ${d} ${d === 1 ? "day" : "days"} of Pro`;
  const months = Math.max(1, Math.round(d / 30));
  return `Includes ${months} ${months === 1 ? "month" : "months"} of Pro`;
}

export function displayPriceText(t: CampaignTemplate): string {
  return t.display_price == null ? "—" : `$${t.display_price.toFixed(2)}`;
}

export function budgetRangeDisplay(t: CampaignTemplate): string {
  const opts = t.budget_options ?? [];
  if (opts.length > 0) return `$${Math.min(...opts)} – $${Math.max(...opts)}`;
  if (t.ad_budget_min != null && t.ad_budget_max != null) return `$${t.ad_budget_min} – $${t.ad_budget_max}`;
  return "—";
}

// ─── Unlock rule (campaign_templates.unlock_*, BoostView.isUnlockGated) ──────

export type CampaignLite = { campaign_template: string | null; status: string | null };

export function unlockProgressCount(t: CampaignTemplate, campaigns: CampaignLite[]): number {
  const ids = t.unlock_template_ids;
  if (!ids || ids.length === 0) return 0;
  const set = new Set(ids);
  return campaigns.filter((c) => {
    if (!c.campaign_template || !set.has(c.campaign_template)) return false;
    const s = c.status?.toLowerCase();
    return s === "live" || s === "completed";
  }).length;
}

// No rule (null ids or null min count) → never gated. Derived fresh each time.
export function isUnlockGated(t: CampaignTemplate, campaigns: CampaignLite[]): boolean {
  if (!t.unlock_template_ids || t.unlock_template_ids.length === 0 || t.unlock_min_count == null) return false;
  return unlockProgressCount(t, campaigns) < t.unlock_min_count;
}

export type TemplateAvailability =
  | { kind: "open" }
  | { kind: "coming_soon" }
  | { kind: "unlock_gated"; label: string | null }
  | { kind: "app_only" }; // a non-Meta (Lab) outlet workflow — iOS opens its own sheet

// The card state, in iOS's order: coming_soon, then unlock rule, then outlet.
export function templateAvailability(t: CampaignTemplate, campaigns: CampaignLite[]): TemplateAvailability {
  if (isComingSoon(t)) return { kind: "coming_soon" };
  if (isUnlockGated(t, campaigns)) return { kind: "unlock_gated", label: t.unlock_label?.trim() || null };
  if (!isMetaOutlet(t)) return { kind: "app_only" };
  return { kind: "open" };
}

export function templateImageUrl(file: string | null, supabaseUrl: string | undefined): string | null {
  if (!file || !supabaseUrl) return null;
  return `${supabaseUrl}/storage/v1/object/public/public_images/${encodeURI(file)}`;
}

// ─── Create-flow constants & helpers shared by the form and its action ──────

export const CONTACT_BOOKING_URL = "https://meetings.hubspot.com/willvilla/sqrz-grow-discovery-call";
export const RADIUS_OPTIONS_KM = [10, 25, 50, 80] as const;
export const CREATIVE_FORMATS = ["story", "feed", "classic"] as const;
export const CTA_TYPES = ["book_now", "learn_more", "contact_us"] as const;

export function extractYouTubeVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isId = (s: string) => /^[A-Za-z0-9_-]{11}$/.test(s);
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("youtu.be")) {
    const id = url.pathname.replace(/^\/+|\/+$/g, "");
    return isId(id) ? id : null;
  }
  if (is("youtube.com")) {
    const v = url.searchParams.get("v");
    if (v && isId(v)) return v;
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

export function normalizedYouTubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

// Prefills the HubSpot booking link with the artist's own details (same
// query params as iOS prefilledBookingURL).
export function prefilledBookingUrl(p: { email?: string | null; first_name?: string | null; name?: string | null; last_name?: string | null }): string {
  const url = new URL(CONTACT_BOOKING_URL);
  if (p.email) url.searchParams.append("email", p.email);
  const first = p.first_name || p.name?.split(" ")[0];
  if (first) url.searchParams.append("firstname", first);
  if (p.last_name) url.searchParams.append("lastname", p.last_name);
  return url.toString();
}
