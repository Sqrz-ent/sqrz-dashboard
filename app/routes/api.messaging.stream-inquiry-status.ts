import { createSupabaseAdminClient, createSupabaseServerClient, createSupabaseBearerClient } from "~/lib/supabase.server";
import { fetchInquiryMessagePreview } from "~/lib/messaging/inquiry.server";

// Archive action for an inquiry thread. Closes the Stream thread (sets its status)
// AND upserts the corresponding `leads` row as archived — one lead per thread
// (keyed on thread_id). Dual-auth (cookie web + Bearer native). See the sibling
// keep-active endpoint for the "not archived, bump to top" action.
export async function action({ request }: { request: Request }) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let headers = new Headers();
  let user;

  if (bearerToken) {
    const supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
  } else {
    const { supabase: cookieClient, headers: cookieHeaders } = createSupabaseServerClient(request);
    headers = cookieHeaders;
    ({ data: { user } } = await cookieClient.auth.getUser());
  }

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const body = await request.json();
  const threadId = String(body?.threadId ?? "");
  if (!threadId) {
    return Response.json({ error: "Missing threadId" }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile?.id) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers });
  }

  const { data: thread } = await admin
    .from("profile_inquiry_threads")
    .select("id, profile_id, visitor_name, visitor_email, provider_channel_id")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread || thread.profile_id !== profile.id) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }

  // Close the thread.
  const { error: closeError } = await admin
    .from("profile_inquiry_threads")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", threadId);

  if (closeError) {
    return Response.json({ error: closeError.message }, { status: 500, headers });
  }

  // Short snapshot of the conversation for the lead card (first message). Only
  // include it in the payload when we actually got one — a transient null must not
  // overwrite (wipe) a message stored by an earlier action.
  const messagePreview = await fetchInquiryMessagePreview(thread.provider_channel_id as string);

  const leadRow: Record<string, unknown> = {
    thread_id: threadId,
    profile_id: profile.id,
    name: thread.visitor_name,
    email: thread.visitor_email,
    source: "chat",
    status: "archived",
  };
  if (messagePreview) leadRow.message = messagePreview;

  // Upsert the lead as archived (one per thread, keyed on thread_id).
  const { error: leadError } = await admin
    .from("leads")
    .upsert(leadRow, { onConflict: "thread_id" });

  if (leadError) {
    return Response.json({ error: leadError.message }, { status: 500, headers });
  }

  return Response.json({ ok: true }, { headers });
}
