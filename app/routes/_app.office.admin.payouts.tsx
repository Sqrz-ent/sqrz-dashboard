import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.office.admin.payouts";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

const ACCENT = "#F5A623";
const FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

const WILL_PROFILE_ID = "8fc5755f-8e1b-47ce-b971-641860458bd0";

function fmtMoney(n: number) {
  return new Intl.NumberFormat("en-EU", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(n);
}

type BookingEarning = {
  id: string;
  booking_id: string;
  referrer_slug: string;
  referred_slug: string;
  booking_value: number;
  commission_pct: number;
  commission_amount: number;
  payout_status: string;
  created_at: string;
};

type PartnerEarning = {
  id: string;
  partner_slug: string;
  commission_amount: number;
  payout_status: string;
  created_at: string;
};

type LoaderData = {
  bookingEarnings: BookingEarning[];
  partnerEarnings: PartnerEarning[];
  bookingTotal: number;
  partnerTotal: number;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile || (profile.id as string) !== WILL_PROFILE_ID) {
    return redirect("/office", { headers });
  }

  const admin = createSupabaseAdminClient();

  // ── 1. Booking referral earnings ──────────────────────────────────────────
  const { data: rawBookingEarnings } = await admin
    .from("booking_referral_earnings")
    .select("id, booking_id, referrer_id, referred_id, booking_value, commission_pct, commission_amount, payout_status, created_at")
    .eq("payout_status", "pending")
    .order("created_at", { ascending: false });

  // Fetch referrer + referred profile slugs
  const bEarnings = rawBookingEarnings ?? [];
  const bProfileIds = [
    ...new Set([
      ...bEarnings.map((r) => r.referrer_id as string),
      ...bEarnings.map((r) => r.referred_id as string),
    ]),
  ].filter(Boolean);

  const { data: bProfiles } = bProfileIds.length
    ? await admin.from("profiles").select("id, slug").in("id", bProfileIds)
    : { data: [] };

  const slugMap: Record<string, string> = {};
  for (const p of bProfiles ?? []) {
    slugMap[p.id as string] = (p.slug as string) ?? "unknown";
  }

  const bookingEarnings: BookingEarning[] = bEarnings.map((r) => ({
    id: r.id as string,
    booking_id: r.booking_id as string,
    referrer_slug: slugMap[r.referrer_id as string] ?? "unknown",
    referred_slug: slugMap[r.referred_id as string] ?? "unknown",
    booking_value: Number(r.booking_value ?? 0),
    commission_pct: Number(r.commission_pct ?? 2.5),
    commission_amount: Number(r.commission_amount ?? 0),
    payout_status: r.payout_status as string,
    created_at: r.created_at as string,
  }));

  const bookingTotal = bookingEarnings.reduce((s, r) => s + r.commission_amount, 0);

  // ── 2. SaaS partner earnings ──────────────────────────────────────────────
  const { data: rawPartnerEarnings } = await admin
    .from("partner_earnings")
    .select("id, partner_id, commission_amount, payout_status, created_at")
    .eq("payout_status", "pending")
    .order("created_at", { ascending: false });

  const pEarnings = rawPartnerEarnings ?? [];
  const pProfileIds = [...new Set(pEarnings.map((r) => r.partner_id as string))].filter(Boolean);

  const { data: pProfiles } = pProfileIds.length
    ? await admin.from("profiles").select("id, slug").in("id", pProfileIds)
    : { data: [] };

  const pSlugMap: Record<string, string> = {};
  for (const p of pProfiles ?? []) {
    pSlugMap[p.id as string] = (p.slug as string) ?? "unknown";
  }

  const partnerEarnings: PartnerEarning[] = pEarnings.map((r) => ({
    id: r.id as string,
    partner_slug: pSlugMap[r.partner_id as string] ?? "unknown",
    commission_amount: Number(r.commission_amount ?? 0),
    payout_status: r.payout_status as string,
    created_at: r.created_at as string,
  }));

  const partnerTotal = partnerEarnings.reduce((s, r) => s + r.commission_amount, 0);

  return Response.json(
    { bookingEarnings, partnerEarnings, bookingTotal, partnerTotal } satisfies LoaderData,
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile || (profile.id as string) !== WILL_PROFILE_ID) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "run_payout_batch") {
    // Placeholder — actual Stripe transfers handled by Edge Function
    // Mark both tables as 'processing' to indicate batch is running
    const admin = createSupabaseAdminClient();
    await Promise.all([
      admin
        .from("booking_referral_earnings")
        .update({ payout_status: "processing" })
        .eq("payout_status", "pending"),
      admin
        .from("partner_earnings")
        .update({ payout_status: "processing" })
        .eq("payout_status", "pending"),
    ]);
    return Response.json({ ok: true }, { headers });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPayoutsPage() {
  const { bookingEarnings, partnerEarnings, bookingTotal, partnerTotal } =
    useLoaderData<typeof loader>() as LoaderData;

  const fetcher = useFetcher();
  const isRunning = fetcher.state !== "idle";

  const grandTotal = bookingTotal + partnerTotal;

  const th: React.CSSProperties = {
    padding: "9px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    color: "var(--text-muted)",
    background: "var(--surface-muted)",
    borderBottom: "1px solid var(--border)",
  };

  const td: React.CSSProperties = {
    padding: "11px 14px",
    fontSize: 13,
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
  };

  const tableStyle: React.CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    tableLayout: "fixed",
  };

  const sectionCard: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 24,
  };

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px 100px", fontFamily: FONT, color: "var(--text)" }}>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Payout queue</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Pending partner commissions across subscriptions and bookings.
          </p>
        </div>
        <div style={{
          background: "rgba(245,166,35,0.1)",
          border: "1px solid rgba(245,166,35,0.3)",
          borderRadius: 10,
          padding: "10px 18px",
          textAlign: "right",
        }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 2px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>Total pending</p>
          <p style={{ fontSize: 22, fontWeight: 700, color: ACCENT, margin: 0 }}>{fmtMoney(grandTotal)}</p>
        </div>
      </div>

      {/* ── Booking referral earnings ────────────────────────────────────── */}
      <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 10px" }}>
        Booking referrals pending
        {bookingEarnings.length > 0 && (
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>
            ({bookingEarnings.length} row{bookingEarnings.length !== 1 ? "s" : ""} · {fmtMoney(bookingTotal)})
          </span>
        )}
      </h2>
      <div style={sectionCard}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...th, width: "22%" }}>Partner</th>
              <th style={{ ...th, width: "22%" }}>Seller</th>
              <th style={{ ...th, width: "20%" }}>Booking value</th>
              <th style={{ ...th, width: "18%" }}>Commission</th>
              <th style={{ ...th, width: "18%" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {bookingEarnings.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--text-muted)", padding: "28px 14px" }}>
                  No pending booking referral commissions.
                </td>
              </tr>
            ) : (
              bookingEarnings.map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, fontFamily: "monospace", fontWeight: 600 }}>{r.referrer_slug}</td>
                  <td style={{ ...td, fontFamily: "monospace", color: "var(--text-muted)" }}>{r.referred_slug}</td>
                  <td style={td}>{fmtMoney(r.booking_value)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{fmtMoney(r.commission_amount)}</td>
                  <td style={td}>
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: 20,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "rgba(251,191,36,0.12)",
                      color: "#fbbf24",
                    }}>
                      {r.payout_status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── SaaS partner earnings ────────────────────────────────────────── */}
      <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 10px" }}>
        SaaS subscription commissions pending
        {partnerEarnings.length > 0 && (
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>
            ({partnerEarnings.length} row{partnerEarnings.length !== 1 ? "s" : ""} · {fmtMoney(partnerTotal)})
          </span>
        )}
      </h2>
      <div style={sectionCard}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...th, width: "40%" }}>Partner</th>
              <th style={{ ...th, width: "30%" }}>Commission</th>
              <th style={{ ...th, width: "30%" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {partnerEarnings.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--text-muted)", padding: "28px 14px" }}>
                  No pending subscription commissions.
                </td>
              </tr>
            ) : (
              partnerEarnings.map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, fontFamily: "monospace", fontWeight: 600 }}>{r.partner_slug}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{fmtMoney(r.commission_amount)}</td>
                  <td style={td}>
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: 20,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "rgba(251,191,36,0.12)",
                      color: "#fbbf24",
                    }}>
                      {r.payout_status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Run payout batch ────────────────────────────────────────────── */}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="run_payout_batch" />
        <button
          type="submit"
          disabled={isRunning || grandTotal === 0}
          style={{
            padding: "13px 28px",
            borderRadius: 10,
            border: "none",
            background: grandTotal > 0 ? ACCENT : "var(--surface-muted)",
            color: grandTotal > 0 ? "#fff" : "var(--text-muted)",
            fontWeight: 700,
            fontSize: 14,
            cursor: grandTotal > 0 ? "pointer" : "default",
            fontFamily: FONT,
            opacity: isRunning ? 0.7 : 1,
          }}
        >
          {isRunning ? "Running…" : `Run payout batch · ${fmtMoney(grandTotal)}`}
        </button>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          Marks all rows as processing. Actual Stripe transfers run via the payout Edge Function.
        </p>
      </fetcher.Form>

    </div>
  );
}
