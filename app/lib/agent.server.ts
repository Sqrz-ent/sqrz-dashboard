import { createSupabaseAdminClient } from "~/lib/supabase.server";

/**
 * Agent Mode V1 — lets a manager (delegate) act on behalf of a talent profile
 * (delegator) they manage. The link lives in `profile_delegates`:
 *
 *   delegate_profile_id  → the manager (agent)
 *   delegator_profile_id → the talent being managed
 *   permission_scope[]   → reserved for future per-scope gating (not enforced in V1)
 *   status='active' AND is_beta=true → the row is live for the beta
 *
 * The "acting as" target is stored in an HTTP cookie. The cookie is NOT trusted:
 * every read re-validates the delegation server-side via the service-role client,
 * so a forged cookie can never escalate into managing a profile you don't own.
 */

export const ACTING_AS_COOKIE = "sqrz_acting_as";

// 30 days — purely a convenience; authority always comes from the live delegation.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type ManagedProfile = Record<string, unknown> & {
  id: string;
  slug: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
};

export type AgentState = {
  /** True when the owner has at least one active beta delegation (i.e. is a manager). */
  isAgent: boolean;
  /** The profile being managed right now, or null when the owner is acting as themselves. */
  managedProfile: ManagedProfile | null;
};

// ─── Cookie helpers (raw Set-Cookie, matching the codebase's existing style) ────

export function readActingAs(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${ACTING_AS_COOKIE}=([^;]+)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function setActingAsCookie(profileId: string): string {
  return `${ACTING_AS_COOKIE}=${encodeURIComponent(profileId)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`;
}

export function clearActingAsCookie(): string {
  return `${ACTING_AS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

// ─── Delegation checks (always service-role — authoritative) ────────────────────

/**
 * Does `agentProfileId` manage `targetProfileId`? Active + beta delegation only.
 */
export async function canManage(
  agentProfileId: string,
  targetProfileId: string
): Promise<boolean> {
  if (!agentProfileId || !targetProfileId) return false;
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("profile_delegates")
    .select("id")
    .eq("delegate_profile_id", agentProfileId)
    .eq("delegator_profile_id", targetProfileId)
    .eq("status", "active")
    .eq("is_beta", true)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Is `agentProfileId` a manager at all (has ≥1 active beta delegation)?
 * Gates all Agent Mode surfaces.
 */
export async function isAgent(agentProfileId: string): Promise<boolean> {
  if (!agentProfileId) return false;
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("profile_delegates")
    .select("id")
    .eq("delegate_profile_id", agentProfileId)
    .eq("status", "active")
    .eq("is_beta", true)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Resolve the full Agent Mode state for the dashboard shell given the real
 * (owner) profile id. Validates the acting-as cookie before honoring it.
 */
export async function getAgentState(
  request: Request,
  ownerProfileId: string
): Promise<AgentState> {
  const agent = await isAgent(ownerProfileId);
  if (!agent) return { isAgent: false, managedProfile: null };

  const managedProfile = await resolveManagedProfile(request, ownerProfileId);
  return { isAgent: true, managedProfile };
}

/**
 * Returns the managed profile row IF the acting-as cookie is set to a profile the
 * owner genuinely manages; otherwise null. Uses the service-role client so the
 * managed (often unclaimed/guest) row is always readable regardless of RLS.
 */
export async function resolveManagedProfile(
  request: Request,
  ownerProfileId: string
): Promise<ManagedProfile | null> {
  const actingAs = readActingAs(request);
  if (!actingAs || actingAs === ownerProfileId) return null;

  const allowed = await canManage(ownerProfileId, actingAs);
  if (!allowed) return null;

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("id", actingAs)
    .maybeSingle();

  return (data as ManagedProfile | null) ?? null;
}
