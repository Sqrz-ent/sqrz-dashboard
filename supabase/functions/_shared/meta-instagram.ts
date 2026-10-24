// ─────────────────────────────────────────────────────────────────────────────
// _shared/meta-instagram.ts (2026-10-27)
//
// Resolves a Facebook Page's linked Instagram professional account
// (instagram_business_account) LIVE from the Graph API, using SQRZ's own
// system-user credentials — never the stored profile_meta_connections.
// instagram_user_id/instagram_username at face value, which can be stale or
// simply never populated (e.g. a connection activated before this lookup
// existed, or before the artist's Facebook login had the instagram_basic
// scope — the exact case that produced meta-campaign-create's "no
// instagram_user_id is resolved" failure for an otherwise-active connection).
//
// Shared by meta-page-connection-status (refreshes the stored value on every
// check of an active connection, not just the first) and meta-campaign-create
// (resolves it on demand, right before building an Instagram-existing-post
// ad, if the stored column is missing). meta-page-connect and meta-page-posts
// each still have their own local copy of the plain Meta-API lookup
// (fetchPageInstagram) — not touched by this pass, which only needed these
// two call sites to stop duplicating/drifting from each other.
// ─────────────────────────────────────────────────────────────────────────────

export type PageInstagramAccount = { id: string; username: string | null };

type MetaError = { message?: string; code?: number; error_subcode?: number };

// Pure Meta API call — no Supabase involved. Returns null when the Page has
// no linked Instagram account at all; that's a normal outcome, not an error.
// Throws only on a genuine Graph API failure (bad token, Page not found,
// transient error, etc.) — callers decide how to treat that.
export async function fetchPageInstagram(
  pageId: string,
  token: string,
  graphVersion: string,
): Promise<PageInstagramAccount | null> {
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${pageId}`);
  url.searchParams.set("fields", "instagram_business_account{id,username}");
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString());
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as MetaError | undefined;
  if (!res.ok || err) {
    throw new Error(
      `GET ${pageId} (instagram_business_account) → ${res.status}${err?.message ? ` ${err.message}` : ""}`,
    );
  }
  const ig = body.instagram_business_account as { id?: string; username?: string } | undefined;
  if (!ig?.id) return null;
  return { id: ig.id, username: ig.username ?? null };
}

// Minimal shape of whatever Supabase client the caller already has (admin or
// otherwise) — avoids importing the full supabase-js client type here, just
// the one call shape this actually uses.
type MinimalSupabase = {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

// Resolves the Page's linked Instagram account live, and — ONLY if one is
// found — writes it back onto this profile's profile_meta_connections row
// (instagram_user_id/instagram_username), so a future read doesn't need to
// re-resolve it. Deliberately does NOT clear a previously-stored value when
// Meta now returns none (a transient/partial failure shouldn't erase a
// previously-good value); meta-page-connection-status's own full refresh
// (which intentionally does overwrite with whatever Meta currently reports,
// including null) is a separate, already-correct code path, untouched by
// this helper. Returns the resolved account (or null); throws only on a
// genuine Meta API failure, same as fetchPageInstagram.
export async function resolveAndStorePageInstagram(
  supabase: MinimalSupabase,
  profileId: string,
  pageId: string,
  token: string,
  graphVersion: string,
): Promise<PageInstagramAccount | null> {
  const instagram = await fetchPageInstagram(pageId, token, graphVersion);
  if (instagram) {
    const { error } = await supabase
      .from("profile_meta_connections")
      .update({ instagram_user_id: instagram.id, instagram_username: instagram.username })
      .eq("profile_id", profileId);
    if (error) {
      console.error(
        `[meta-instagram] failed to store resolved Instagram account for profile ${profileId}:`,
        error.message,
      );
    }
  }
  return instagram;
}
