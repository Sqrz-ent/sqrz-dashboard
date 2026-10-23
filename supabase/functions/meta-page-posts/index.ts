import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// meta-page-posts
//
// "Promote an existing post" V1 (2026-10-23) — lists the 15 most recent
// published posts on a profile's CONNECTED Facebook Page (profile_meta_
// connections, status='active'), so the create-campaign flow can let the
// artist pick one instead of uploading new creative.
//
// Instagram (2026-10-23, same pass) — also lists the 15 most recent media
// items from the Instagram professional account linked to the connected
// Page (Page's own `instagram_business_account` field, resolved fresh here
// rather than trusting profile_meta_connections.instagram_user_id, which
// may be stale if the Page's linked Instagram changed since the last
// meta-page-connection-status check). Each item in the combined `posts`
// array carries `source: "facebook"` or `"instagram"` and keeps that
// platform's own native field names rather than forcing a lossy shared
// schema — Facebook: id/created_time/message/full_picture/permalink_url
// (unchanged from before this pass); Instagram:
// id/timestamp/caption/media_url/thumbnail_url/permalink/media_type.
// Instagram items are listed first in the array (the client is expected to
// enforce this ordering itself too, not just rely on it).
//
// A missing/unlinked Instagram account, or an Instagram-specific fetch
// failure, is NOT a hard failure of this endpoint — Facebook posts are
// still returned, with instagram_error ("not_linked" | "missing_permission"
// | "fetch_failed") + instagram_message describing why Instagram posts
// aren't included. A Facebook posts failure is still a hard failure
// (502, unchanged from before this pass) — only Instagram degrades
// gracefully.
//
// Page access: the business has at least ADVERTISE access to the Page (via
// the connect flow — see meta-page-connect/meta-page-connection-status),
// but reading a Page's own posts (and, by extension, its linked Instagram
// account's media) needs a genuine PAGE access token, not just the system
// user's own token. Derived here via
// GET /{page_id}?fields=access_token,instagram_business_account{id,username}
// using the system user token — a System User with sufficient task access
// on the Page can mint that Page's token this way (confirmed against
// Meta's current docs). Falls back to the system user token directly for
// Facebook posts if that derivation fails, in case some permission
// configuration already allows reading posts without it; Instagram is
// reported as instagram_error: "fetch_failed" in that case, since there's
// no business_account id to even attempt a media fetch with.
//
// Uses /{page_id}/published_posts (not the broader /posts edge) — only
// posts the Page itself published, no scheduled/draft posts, no posts by
// others onto an open Page. Facebook `id` comes back in Meta's own
// `{page_id}_{post_id}` format, exactly what the AdCreative
// `object_story_id` field expects. Instagram `id` is the IG media id,
// exactly what `source_instagram_media_id` expects. Both are stored and
// sent back to the client unchanged, no reformatting.
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

function isPermissionError(err: MetaError | undefined): boolean {
  // Meta's "permission denied" family (code 10) and "permissions error"
  // (code 200) are the two codes actually seen for a Page/IG account the
  // business can advertise with but can't read content from.
  return err?.code === 10 || err?.code === 200;
}

// A System User with task access on a Page can retrieve that Page's own
// access token, and read its linked Instagram business account id, in one
// call. Throws on failure — the caller falls back to the system user token
// for Facebook posts rather than failing the whole request over it, and
// treats Instagram as unresolvable (instagram_error: "fetch_failed").
async function getPageTokenAndInstagram(
  pageId: string,
  systemUserToken: string,
): Promise<{ pageToken: string; instagram: { id: string; username: string | null } | null }> {
  const url = new URL(`${GRAPH}/${pageId}`);
  url.searchParams.set("fields", "access_token,instagram_business_account{id,username}");
  url.searchParams.set("access_token", systemUserToken);
  const res = await fetch(url.toString());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(`GET ${pageId} (access_token,instagram_business_account) → ${res.status}${err ? ` ${formatMetaError(err)}` : ""}`);
  }
  const token = body.access_token as string | undefined;
  if (!token) throw new Error(`GET ${pageId} (access_token) → no access_token field in response`);
  const ig = body.instagram_business_account as { id?: string; username?: string } | undefined;
  return {
    pageToken: token,
    instagram: ig?.id ? { id: ig.id, username: ig.username ?? null } : null,
  };
}

type RawPost = {
  id?: string;
  created_time?: string;
  message?: string;
  full_picture?: string;
  permalink_url?: string;
};

type RawInstagramMedia = {
  id?: string;
  timestamp?: string;
  caption?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  media_type?: string;
};

type FacebookPostItem = {
  source: "facebook";
  id: string;
  created_time: string | null;
  message: string | null;
  full_picture: string | null;
  permalink_url: string | null;
};

type InstagramPostItem = {
  source: "instagram";
  id: string;
  timestamp: string | null;
  caption: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  media_type: string | null;
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
  let instagramAccount: { id: string; username: string | null } | null = null;
  let instagramLookupError: string | null = null;
  try {
    const resolved = await getPageTokenAndInstagram(pageId, systemUserToken);
    pageToken = resolved.pageToken;
    instagramAccount = resolved.instagram;
  } catch (e) {
    console.error(`[meta-page-posts] page token / instagram_business_account lookup failed for profile ${profileId}:`, e);
    instagramLookupError = e instanceof Error ? e.message : String(e);
    // Fall through with the system user token for Facebook posts — some
    // permission setups may already allow reading posts without a derived
    // page token. Instagram has no business_account id to work with here,
    // so it's reported as fetch_failed below.
  }

  // Facebook posts — unchanged from before this pass: a failure here is
  // still a hard failure of the whole request.
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
    return json({
      error: isPermissionError(postsErr) ? "missing_permission" : "posts_fetch_failed",
      message,
    }, 502);
  }

  const rawPosts = (postsBody.data as RawPost[] | undefined) ?? [];
  const facebookPosts: FacebookPostItem[] = rawPosts
    .filter((p): p is RawPost & { id: string } => !!p.id)
    .map((p) => ({
      source: "facebook",
      id: p.id,
      created_time: p.created_time ?? null,
      message: p.message ? p.message.slice(0, MESSAGE_PREVIEW_LENGTH) : null,
      full_picture: p.full_picture ?? null,
      permalink_url: p.permalink_url ?? null,
    }));

  // Instagram media — degrades gracefully; never fails the whole request.
  let instagramPosts: InstagramPostItem[] = [];
  let instagramError: string | null = null;
  let instagramMessage: string | null = null;

  if (instagramLookupError) {
    instagramError = "fetch_failed";
    instagramMessage = instagramLookupError;
  } else if (!instagramAccount) {
    instagramError = "not_linked";
    instagramMessage = "No Instagram account is linked to this Page.";
  } else {
    const igUrl = new URL(`${GRAPH}/${instagramAccount.id}/media`);
    igUrl.searchParams.set("fields", "id,timestamp,caption,media_url,thumbnail_url,permalink,media_type");
    igUrl.searchParams.set("limit", String(MAX_POSTS));
    igUrl.searchParams.set("access_token", pageToken);
    const igRes = await fetch(igUrl.toString());
    const igBody = (await igRes.json().catch(() => ({}))) as Record<string, unknown>;
    const igErr = igBody.error as MetaError | undefined;
    if (!igRes.ok || igErr) {
      const message = formatMetaError(igErr) || `HTTP ${igRes.status}`;
      console.error(`[meta-page-posts] Instagram media fetch failed for profile ${profileId}:`, message);
      instagramError = isPermissionError(igErr) ? "missing_permission" : "fetch_failed";
      instagramMessage = message;
    } else {
      const rawMedia = (igBody.data as RawInstagramMedia[] | undefined) ?? [];
      instagramPosts = rawMedia
        .filter((m): m is RawInstagramMedia & { id: string } => !!m.id)
        .map((m) => ({
          source: "instagram",
          id: m.id,
          timestamp: m.timestamp ?? null,
          caption: m.caption ? m.caption.slice(0, MESSAGE_PREVIEW_LENGTH) : null,
          media_url: m.media_url ?? null,
          thumbnail_url: m.thumbnail_url ?? null,
          permalink: m.permalink ?? null,
          media_type: m.media_type ?? null,
        }));
    }
  }

  // Instagram first (the client is expected to enforce this itself too —
  // see sqrz-ios — but the default order here already matches).
  const posts = [...instagramPosts, ...facebookPosts];

  return json({ ok: true, posts, instagram_error: instagramError, instagram_message: instagramMessage });
});
