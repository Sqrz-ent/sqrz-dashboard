import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-page-posts
//
// "Promote an existing post" V1 (2026-10-23) — lists the 15 most recent
// published posts on a profile's CONNECTED Facebook Page (profile_meta_
// connections, status='active'), so the create-campaign flow can let the
// artist pick one instead of uploading new creative. Facebook posts only —
// no Instagram yet.
//
// Page access: the business has at least ADVERTISE access to the Page (via
// the connect flow — see meta-page-connect/meta-page-connection-status),
// but reading a Page's own posts needs a genuine PAGE access token, not
// just the system user's own token. Derived here via
// GET /{page_id}?fields=access_token using the system user token — a
// System User with sufficient task access on the Page can mint that Page's
// token this way (confirmed against Meta's current docs). Falls back to
// the system user token directly if that derivation fails, in case some
// permission configuration already allows reading posts without it.
//
// Uses /{page_id}/published_posts (not the broader /posts edge) — only
// posts the Page itself published, no scheduled/draft posts, no posts by
// others onto an open Page. `id` comes back in Meta's own `{page_id}_
// {post_id}` format, which is exactly what the AdCreative `object_story_id`
// field expects — stored and sent back to the client unchanged, no
// reformatting.
//
// Auth: same manual JWT + user_owns_profile pattern as the other
// meta-page-* functions.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const MAX_POSTS = 15;
const MESSAGE_PREVIEW_LENGTH = 120;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type MetaError = { message?: string; code?: number; error_subcode?: number };

function formatMetaError(err: MetaError | undefined): string {
  if (!err) return "";
  return err.message || `code=${err.code ?? "?"} subcode=${err.error_subcode ?? "?"}`;
}

// A System User with task access on a Page can retrieve that Page's own
// access token this way. Throws on failure — the caller falls back to the
// system user token directly rather than failing the whole request over it.
async function getPageAccessToken(pageId: string, systemUserToken: string): Promise<string> {
  const url = new URL(`${GRAPH}/${pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", systemUserToken);
  const res = await fetch(url.toString());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`GET ${pageId} (access_token) → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  const token = body.access_token as string | undefined;
  if (!token) throw new Error(`GET ${pageId} (access_token) → no access_token field in response`);
  return token;
}

type RawPost = {
  id?: string;
  created_time?: string;
  message?: string;
  full_picture?: string;
  permalink_url?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearerToken);
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: { profile_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const profileId = body.profile_id;
  if (!profileId) return json({ error: "missing_fields", message: "profile_id is required." }, 400);

  const userScoped = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: owns, error: ownsErr } = await userScoped.rpc("user_owns_profile", { p_profile_id: profileId });
  if (ownsErr || owns !== true) return json({ error: "unauthorized" }, 403);

  const { data: connection, error: connErr } = await supabase
    .from("profile_meta_connections")
    .select("page_id, status")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (connErr) return json({ error: `connection lookup: ${connErr.message}` }, 500);
  if (!connection || connection.status !== "active" || !connection.page_id) {
    return json({ error: "not_connected", message: "This profile has no active Facebook Page connection." }, 400);
  }
  const pageId = connection.page_id as string;

  const { data: acctRow, error: acctErr } = await supabase
    .from("meta_ad_accounts")
    .select("system_user_token")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (acctErr) return json({ error: `ad account lookup: ${acctErr.message}` }, 500);
  if (!acctRow?.system_user_token) {
    return json({ error: "no_business_id", message: "No active Meta business account configured." }, 500);
  }
  const systemUserToken = acctRow.system_user_token as string;

  let pageToken = systemUserToken;
  try {
    pageToken = await getPageAccessToken(pageId, systemUserToken);
  } catch (e) {
    console.error(`[meta-page-posts] page access token derivation failed for profile ${profileId}:`, e);
    // Fall through with the system user token — some permission setups may
    // already allow reading posts without a derived page token.
  }

  const postsUrl = new URL(`${GRAPH}/${pageId}/published_posts`);
  postsUrl.searchParams.set("fields", "id,created_time,message,full_picture,permalink_url");
  postsUrl.searchParams.set("limit", String(MAX_POSTS));
  postsUrl.searchParams.set("access_token", pageToken);
  const postsRes = await fetch(postsUrl.toString());
  const postsBody = (await postsRes.json().catch(() => ({}))) as Record<string, unknown>;
  const postsErr = postsBody.error as MetaError | undefined;
  if (!postsRes.ok || postsErr) {
    const message = formatMetaError(postsErr) || `HTTP ${postsRes.status}`;
    console.error(`[meta-page-posts] published_posts fetch failed for profile ${profileId}:`, message);
    // Meta's "permission denied" family (code 10) and "permissions error"
    // (code 200) are the two codes actually seen for a Page the business
    // can advertise with but can't read content from — surfaced as a
    // distinct error code so the client can show "you may need to grant
    // SQRZ page-content access" rather than a generic failure.
    const isPermissionError = postsErr?.code === 10 || postsErr?.code === 200;
    return json({
      error: isPermissionError ? "missing_permission" : "posts_fetch_failed",
      message,
    }, 502);
  }

  const rawPosts = (postsBody.data as RawPost[] | undefined) ?? [];
  const posts = rawPosts
    .filter((p): p is RawPost & { id: string } => !!p.id)
    .map((p) => ({
      id: p.id,
      created_time: p.created_time ?? null,
      message: p.message ? p.message.slice(0, MESSAGE_PREVIEW_LENGTH) : null,
      full_picture: p.full_picture ?? null,
      permalink_url: p.permalink_url ?? null,
    }));

  return json({ ok: true, posts });
});
