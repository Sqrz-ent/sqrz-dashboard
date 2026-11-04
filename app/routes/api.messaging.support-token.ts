import { createSupabaseBearerClient } from "~/lib/supabase.server";
import { ensureTeamStreamIdentity } from "~/lib/messaging/support.server";

// Support chat (V1, Sandbox) team identity — see
// app/lib/messaging/support.server.ts. Bearer-only: Lab team members use the
// iOS Sandbox surface to answer support chat (see sqrz-ios/CLAUDE.md's
// "Sandbox" section) — there is no web counterpart for this yet.
export async function loader({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createSupabaseBearerClient(bearerToken);
    const {
      data: { user },
    } = await supabase.auth.getUser(bearerToken);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Lab-only access, checked server-side with the caller's own JWT — same
    // pattern as sandbox-admin and the profile-advisor edge function.
    const { data: isLab, error: labErr } = await supabase.rpc("caller_account_is_lab");
    if (labErr) {
      console.error("[support-token] is_lab check failed:", labErr.message);
      return Response.json({ error: "Authorization check failed" }, { status: 500 });
    }
    if (isLab !== true) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: account } = await supabase
      .from("accounts")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!account) {
      return Response.json({ error: "Account not found" }, { status: 404 });
    }

    const { streamUserId, token } = await ensureTeamStreamIdentity(account.id as string);
    return Response.json({ streamUserId, token });
  } catch (error) {
    console.error("[support-token] loader failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to mint support token" },
      { status: 500 }
    );
  }
}
