import { redirect } from "react-router";
import type { Route } from "./+types/api.payout";
import {
  createSupabaseServerClient,
  createSupabaseBearerClient,
  createSupabaseAdminClient,
} from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// Member-initiated payout release request. The seller asks SQRZ to release the
// secured booking funds; this does NOT move money — it flips the wallet to
// 'release_requested' and notifies an admin, who reconciles + releases manually.
//
// Auth: Bearer (sqrz-ios native) OR cookie session (web), mirroring
// api.stripe.connect.tsx. Body is JSON: { booking_id: string }.
export async function action({ request }: Route.ActionArgs) {
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const isNative = bearerToken != null;

  let headers = new Headers();
  let supabase;
  let user;

  if (bearerToken) {
    supabase = createSupabaseBearerClient(bearerToken);
    ({ data: { user } } = await supabase.auth.getUser(bearerToken));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    ({ supabase, headers } = createSupabaseServerClient(request));
    ({ data: { user } } = await supabase.auth.getUser());
    if (!user) return redirect("/login", { headers });
  }

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) {
    return isNative
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : redirect("/login", { headers });
  }

  // Body: JSON { booking_id }. Fall back to form data so a cookie/form caller works too.
  let bookingId: string | null = null;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { booking_id?: string };
    bookingId = body.booking_id ?? null;
  } else {
    const form = await request.formData().catch(() => null);
    bookingId = (form?.get("booking_id") as string | null) ?? null;
  }

  if (!bookingId) {
    return Response.json({ error: "booking_id is required" }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();

  // 1. Booking must exist and be owned by the authenticated profile.
  const { data: booking } = await admin
    .from("bookings")
    .select("id, title, owner_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) {
    return Response.json({ error: "Booking not found" }, { status: 400, headers });
  }
  if (booking.owner_id !== profile.id) {
    return Response.json({ error: "Not authorized for this booking" }, { status: 400, headers });
  }

  // 2. Wallet must exist for this booking.
  const { data: wallet } = await admin
    .from("booking_wallets")
    .select("id, payout_status, secured_amount, currency")
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (!wallet) {
    return Response.json({ error: "Wallet not found" }, { status: 400, headers });
  }

  // 3. Wallet must be in the 'approved' state to request release.
  if (wallet.payout_status !== "approved") {
    return Response.json(
      { error: `Payout cannot be requested while wallet is '${wallet.payout_status ?? "unset"}'` },
      { status: 400, headers }
    );
  }

  // 4. Invoice gate: at least one non-void invoice must exist for this booking.
  const { data: invoices } = await admin
    .from("invoices")
    .select("id")
    .eq("booking_id", bookingId)
    .neq("status", "void")
    .limit(1);

  if (!invoices || invoices.length === 0) {
    return Response.json(
      { error: "An invoice is required before requesting a payout." },
      { status: 400, headers }
    );
  }

  // 5. All checks passed — flip to 'release_requested'.
  const { error: updateError } = await admin
    .from("booking_wallets")
    .update({ payout_status: "release_requested" })
    .eq("id", wallet.id);

  if (updateError) {
    return Response.json({ error: "Could not update wallet" }, { status: 400, headers });
  }

  // 6. Notify admin (non-fatal).
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL ?? "admin@sqrz.com";

    const sellerName =
      (profile.brand_name as string | null) ||
      (profile.name as string | null) ||
      [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
      (profile.slug as string | null) ||
      "Unknown seller";

    const currency = (wallet.currency as string | null) ?? "EUR";
    const amount = Number(wallet.secured_amount ?? 0).toLocaleString();
    const title = (booking.title as string | null) ?? "Untitled booking";

    await resend.emails.send({
      from: "SQRZ <bookings@sqrz.com>",
      to: adminEmail,
      subject: `Payout requested — ${title}`,
      html: `
        <p>A payout release has been requested.</p>
        <ul>
          <li><strong>Seller:</strong> ${sellerName}</li>
          <li><strong>Booking:</strong> ${title}</li>
          <li><strong>Secured amount:</strong> ${currency} ${amount}</li>
          <li><strong>Booking ID:</strong> ${bookingId}</li>
        </ul>
        <p><a href="https://dashboard.sqrz.com/office/admin/payouts">Review payouts →</a></p>
        <p>— SQRZ</p>
      `,
    });
  } catch (err) {
    console.error("[payout] admin notification email failed:", err);
  }

  return Response.json({ ok: true }, { headers });
}
