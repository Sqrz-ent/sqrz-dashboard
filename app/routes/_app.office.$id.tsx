import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.office.$id";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { getPlanLevel } from "~/lib/plans";
import BookingChat from "~/components/BookingChat";

// ─── Types ────────────────────────────────────────────────────────────────────

type BookingRequest = {
  id: string;
  from_profile_id: string | null;
  message: string | null;
  service: string | null;
  budget_min: number | null;
  budget_max: number | null;
  currency: string | null;
  event_date: string | null;
  event_location: string | null;
  status: string | null;
};

type Participant = {
  id: string;
  profile_id: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  pay: number | null;
  pay_status: string | null;
  invite_token: string | null;
};

type Payment = {
  id: number;
  title: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  stripe_invoice_url: string | null;
  created_at: string;
};

type Booking = {
  id: string;
  title: string | null;
  service: string | null;
  status: string;
  date_start: string | null;
  date_end: string | null;
  city: string | null;
  venue: string | null;
  address: string | null;
  rate: number | null;
  currency: string | null;
  require_hotel: boolean | null;
  require_travel: boolean | null;
  require_food: boolean | null;
  show_label: boolean | null;
  owner_id: string;
  payment_method: string | null;
  payment_amount: number | null;
  payment_currency: string | null;
  payment_status: string | null;
  paid_at: string | null;
  booking_requests: BookingRequest[];
  booking_participants: Participant[];
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [bookingRes, paymentsRes] = await Promise.all([
    supabase
      .from("bookings")
      .select("*, booking_requests(*), booking_participants(*)")
      .eq("id", params.id)
      .eq("owner_id", profile.id as string)
      .single(),
    supabase
      .from("payments")
      .select("id, title, amount, currency, status, stripe_invoice_url, created_at")
      .eq("booking_id", params.id)
      .order("created_at", { ascending: false }),
  ]);

  if (!bookingRes.data) return redirect("/office", { headers });

  return Response.json(
    {
      booking: bookingRes.data,
      payments: paymentsRes.data ?? [],
      profileId: profile.id as string,
      userEmail: (profile.email as string) ?? user.email ?? "",
      planId: (profile.plan_id as number | null) ?? null,
      isBeta: (profile.is_beta as boolean) ?? false,
    },
    { headers }
  );
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return Response.json({ error: "Not found" }, { status: 404, headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "update_status") {
    const status = formData.get("status") as string;
    await supabase
      .from("bookings")
      .update({ status })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "update_show_label") {
    const { error } = await supabase
      .from("bookings")
      .update({ show_label: formData.get("show_label") === "true" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "send_proposal") {
    const rate = parseFloat(formData.get("rate") as string) || null;
    const currency = (formData.get("currency") as string) || "EUR";
    const message = (formData.get("message") as string) || "";
    const requireHotel = formData.get("require_hotel") === "true";
    const requireTravel = formData.get("require_travel") === "true";
    const requireFood = formData.get("require_food") === "true";
    const paymentMethod = (formData.get("payment_method") as string) || "external";

    const { error } = await supabase
      .from("bookings")
      .update({
        rate,
        currency,
        require_hotel: requireHotel,
        require_travel: requireTravel,
        require_food: requireFood,
        payment_method: paymentMethod,
        payment_amount: rate,
        payment_currency: currency,
        payment_status: "unpaid",
        status: "pending",
      })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);

    if (error) return Response.json({ error: error.message }, { status: 500, headers });

    // Look up buyer email from booking_request → from_profile_id
    try {
      const { data: req } = await supabase
        .from("booking_requests")
        .select("from_profile_id, service")
        .eq("booking_id", params.id)
        .limit(1)
        .maybeSingle();

      if (req?.from_profile_id) {
        const { data: buyer } = await supabase
          .from("profiles")
          .select("email, name")
          .eq("id", req.from_profile_id)
          .maybeSingle();

        if (buyer?.email) {
          const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";

          // Generate magic link — same pattern as team invites (auth/callback is already in allowed URLs)
          const { createClient } = await import("@supabase/supabase-js");
          const supabaseAdmin = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
          );
          const redirectTo = `https://dashboard.sqrz.com/auth/callback?next=${encodeURIComponent(`/booking/${params.id}`)}`;
          console.log("[proposal] generating magic link for:", buyer.email);
          console.log("[proposal] redirectTo:", redirectTo);
          const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
            type: "magiclink",
            email: buyer.email,
            options: { redirectTo },
          });
          console.log("[proposal] linkData:", JSON.stringify(linkData));
          console.log("[proposal] linkError:", JSON.stringify(linkError));
          console.log("[proposal] action_link:", linkData?.properties?.action_link);
          const bookingLink = linkData?.properties?.action_link
            ?? `https://dashboard.sqrz.com/booking/${params.id}`;

          const { Resend } = await import("resend");
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: "SQRZ <bookings@sqrz.com>",
            to: buyer.email,
            subject: "You have a new proposal on SQRZ",
            html: `
              <p>Hi ${buyer.name ?? "there"},</p>
              <p>You have received a proposal for your booking request.</p>
              <p><strong>Rate:</strong> ${sym}${rate?.toLocaleString() ?? "TBD"}</p>
              ${message ? `<p><strong>Note:</strong> ${message}</p>` : ""}
              <p>Click the button below to view your booking proposal.<br>This link will log you in automatically — no password needed.</p>
              <p><a href="${bookingLink}" style="display:inline-block;padding:12px 24px;background:#F5A623;color:#111;font-weight:700;text-decoration:none;border-radius:8px;">View Proposal →</a></p>
              <p>The SQRZ Team</p>
            `,
          });
        }
      }
    } catch (err) {
      console.error("[proposal] email send failed:", err);
    }

    return Response.json({ ok: true }, { headers });
  }

  if (intent === "invite_team_member") {
    const name  = ((formData.get("name")  as string) ?? "").trim();
    const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
    const role  = ((formData.get("role")  as string) ?? "").trim();
    const pay   = parseFloat(formData.get("pay") as string) || null;

    if (!email.includes("@")) {
      return Response.json({ error: "Invalid email" }, { status: 400, headers });
    }

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    let guestProfileId: string | null = existing?.id ?? null;

    if (!guestProfileId) {
      const { data: newProfile } = await supabase
        .from("profiles")
        .insert({ email, name, user_type: "guest", is_published: false, created_by: "team_invite" })
        .select("id")
        .single();
      guestProfileId = newProfile?.id ?? null;
    }

    const inviteToken = crypto.randomUUID();
    const { data: participant, error: participantError } = await supabase
      .from("booking_participants")
      .insert({ booking_id: params.id, user_id: null, name, email, role, pay, is_admin: false, invite_token: inviteToken })
      .select()
      .single();

    if (participantError) {
      return Response.json({ error: participantError.message }, { status: 500, headers });
    }

    console.log("[invite] participant:", participant?.id);

    try {
      const admin = createSupabaseAdminClient();
      const next = encodeURIComponent(`/booking/${params.id}?token=${inviteToken}`);
      const redirectTo = `https://dashboard.sqrz.com/auth/callback?next=${next}`;
      const { data: linkData } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo },
      });

      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "SQRZ <bookings@sqrz.com>",
        to: email,
        subject: "You've been invited to a booking",
        html: `
          <p>Hi ${name},</p>
          <p>You've been invited to collaborate on a booking.</p>
          <p><a href="${linkData?.properties?.action_link}">Click here to access the booking</a></p>
          <p>The SQRZ Team</p>
        `,
      });
    } catch (err) {
      console.error("[invite] email send failed:", err);
    }

    return Response.json({ ok: true, invited: email }, { headers });
  }

  if (intent === "mark_as_paid") {
    const { error } = await supabase
      .from("bookings")
      .update({ payment_status: "paid", paid_at: new Date().toISOString(), status: "completed" })
      .eq("id", params.id)
      .eq("owner_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: true }, { headers });
}

// ─── Helpers + tokens ─────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "long", day: "numeric", year: "numeric",
  });
}

function formatRate(rate: number | null, currency: string | null): string {
  if (!rate) return "—";
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  return `${sym}${rate.toLocaleString()}`;
}

function currencySym(c: string | null) {
  return c === "EUR" ? "€" : c === "GBP" ? "£" : "$";
}

const ACCENT = "#F5A623";
const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "16px 18px",
  marginBottom: 14,
};

const label: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 4px",
};

const val: React.CSSProperties = {
  color: "var(--text)",
  fontSize: 14,
  margin: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: FONT_BODY,
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: "rgba(245,166,35,0.12)", text: ACCENT },
  pending:   { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  confirmed: { bg: "rgba(74,222,128,0.12)", text: "#4ade80" },
  completed: { bg: "var(--surface-muted)", text: "var(--text-muted)" },
  archived:  { bg: "var(--surface-muted)", text: "var(--text-muted)" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.archived;
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: "0 0 16px", lineHeight: 1.1 }}>
      {children}
    </h2>
  );
}

// ─── Details section ──────────────────────────────────────────────────────────

function DetailsSection({ booking }: { booking: Booking }) {
  const req = booking.booking_requests?.[0];
  const showLabelFetcher = useFetcher();

  return (
    <section id="details" style={{ paddingBottom: 40 }}>
      <SectionHeading>Details</SectionHeading>

      {/* Status + service */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: booking.service ? 14 : 0 }}>
          <StatusBadge status={booking.status} />
        </div>
        {booking.service && (
          <div>
            <p style={label}>Service</p>
            <p style={val}>{booking.service}</p>
          </div>
        )}
      </div>

      {/* Dates */}
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <p style={label}>Start date</p>
            <p style={val}>{formatDate(booking.date_start)}</p>
          </div>
          {booking.date_end && booking.date_end !== booking.date_start && (
            <div>
              <p style={label}>End date</p>
              <p style={val}>{formatDate(booking.date_end)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Public calendar toggle */}
      <div style={card}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            defaultChecked={!!booking.show_label}
            onChange={(e) => {
              const fd = new FormData();
              fd.append("intent", "update_show_label");
              fd.append("show_label", String(e.target.checked));
              showLabelFetcher.submit(fd, { method: "post" });
            }}
            style={{ accentColor: ACCENT, cursor: "pointer", width: 16, height: 16 }}
          />
          <div>
            <p style={{ ...label, margin: 0 }}>Show on public calendar</p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
              When on, the booking title is visible on your profile calendar
            </p>
          </div>
        </label>
      </div>

      {/* Location */}
      {(booking.city || booking.venue || booking.address) && (
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: booking.address ? 14 : 0 }}>
            {booking.venue && (
              <div>
                <p style={label}>Venue</p>
                <p style={val}>{booking.venue}</p>
              </div>
            )}
            {booking.city && (
              <div>
                <p style={label}>City</p>
                <p style={val}>{booking.city}</p>
              </div>
            )}
          </div>
          {booking.address && (
            <div>
              <p style={label}>Address</p>
              <p style={{ ...val, color: "var(--text-muted)", fontSize: 13 }}>{booking.address}</p>
            </div>
          )}
        </div>
      )}

      {/* Rate (if already set) */}
      {booking.rate != null && (
        <div style={card}>
          <p style={label}>Agreed Rate</p>
          <p style={{ ...val, color: ACCENT, fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {formatRate(booking.rate, booking.currency)}
          </p>
        </div>
      )}

      {/* Original request */}
      {req && (
        <div style={card}>
          <p style={{ ...label, marginBottom: 14 }}>Booking request</p>
          {req.service && (
            <div style={{ marginBottom: 12 }}>
              <p style={label}>Service requested</p>
              <p style={val}>{req.service}</p>
            </div>
          )}
          {(req.budget_min || req.budget_max) && (
            <div style={{ marginBottom: 12 }}>
              <p style={label}>Budget</p>
              <p style={val}>
                {[
                  req.budget_min ? formatRate(req.budget_min, req.currency ?? booking.currency) : null,
                  req.budget_max ? formatRate(req.budget_max, req.currency ?? booking.currency) : null,
                ].filter(Boolean).join(" – ")}
              </p>
            </div>
          )}
          {req.message && (
            <div>
              <p style={label}>Message</p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.65, margin: "6px 0 0", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
                {req.message}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Proposal section ─────────────────────────────────────────────────────────

function ProposalSection({ booking, planLevel }: { booking: Booking; planLevel: number }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [form, setForm] = useState({
    rate: String(booking.rate ?? ""),
    currency: booking.currency ?? "EUR",
    message: "",
    require_travel: booking.require_travel ?? false,
    require_hotel: booking.require_hotel ?? false,
    require_food: booking.require_food ?? false,
    payment_method: booking.payment_method ?? "external",
  });

  const sent = fetcher.state === "idle" && fetcher.data?.ok;
  const canUseStripe = planLevel >= 1;

  return (
    <section id="proposal" style={{ paddingBottom: 40 }}>
      <SectionHeading>Proposal</SectionHeading>

      {sent ? (
        <div style={{ ...card, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(74,222,128,0.06)" }}>
          <p style={{ color: "#4ade80", fontSize: 14, margin: 0, fontWeight: 600 }}>
            ✓ Proposal sent — booking is now pending.
          </p>
        </div>
      ) : (
        <div style={card}>
          {/* Rate + currency */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 12, marginBottom: 14 }}>
            <div>
              <p style={{ ...label, marginBottom: 6 }}>Your Rate</p>
              <input
                type="number"
                style={inputStyle}
                value={form.rate}
                onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                placeholder="1500"
              />
            </div>
            <div>
              <p style={{ ...label, marginBottom: 6 }}>Currency</p>
              <select
                style={{ ...inputStyle }}
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </div>

          {/* Payment method */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ ...label, marginBottom: 10 }}>Payment Method</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(
                [
                  { value: "external", label: "Handle externally", sub: "I'll invoice the client myself", disabled: false },
                  { value: "stripe", label: "Request via SQRZ", sub: "Stripe payment link — Creator+", disabled: !canUseStripe },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 9,
                    border: `1px solid ${form.payment_method === opt.value ? ACCENT : "var(--border)"}`,
                    background: form.payment_method === opt.value ? "rgba(245,166,35,0.06)" : "var(--bg)",
                    cursor: opt.disabled ? "not-allowed" : "pointer",
                    opacity: opt.disabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="payment_method"
                    value={opt.value}
                    checked={form.payment_method === opt.value}
                    disabled={opt.disabled}
                    onChange={() => !opt.disabled && setForm((f) => ({ ...f, payment_method: opt.value }))}
                    style={{ accentColor: ACCENT, marginTop: 2, flexShrink: 0 }}
                  />
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>{opt.label}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>{opt.sub}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Message */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ ...label, marginBottom: 6 }}>Message (optional)</p>
            <textarea
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
              placeholder="Add a note to your proposal…"
            />
          </div>

          {/* Rider checkboxes */}
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            {(
              [
                { key: "require_travel", label: "Require Travel" },
                { key: "require_hotel", label: "Require Hotel" },
                { key: "require_food", label: "Require Food" },
              ] as const
            ).map(({ key, label: lbl }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                  style={{ accentColor: ACCENT, width: 15, height: 15 }}
                />
                {lbl}
              </label>
            ))}
          </div>

          {fetcher.data?.error && (
            <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 12px" }}>{fetcher.data.error}</p>
          )}

          {/* Send button */}
          <button
            onClick={() => {
              const fd = new FormData();
              fd.append("intent", "send_proposal");
              fd.append("rate", form.rate);
              fd.append("currency", form.currency);
              fd.append("message", form.message);
              fd.append("require_hotel", String(form.require_hotel));
              fd.append("require_travel", String(form.require_travel));
              fd.append("require_food", String(form.require_food));
              fd.append("payment_method", form.payment_method);
              fetcher.submit(fd, { method: "post" });
            }}
            disabled={fetcher.state !== "idle"}
            style={{
              width: "100%",
              padding: "13px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: fetcher.state !== "idle" ? "default" : "pointer",
              opacity: fetcher.state !== "idle" ? 0.7 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            {fetcher.state !== "idle" ? "Sending…" : "Send Proposal"}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── Team section ─────────────────────────────────────────────────────────────

function TeamSection({ participants, bookingId }: { participants: Participant[]; bookingId: string }) {
  const fetcher = useFetcher<{ ok?: boolean; invited?: string; error?: string }>();
  const formRef = useRef<HTMLFormElement>(null);
  const isSending = fetcher.state !== "idle";
  const lastInvited = fetcher.state === "idle" && fetcher.data?.invited ? fetcher.data.invited : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.invited) {
      formRef.current?.reset();
    }
  }, [fetcher.state, fetcher.data]);

  const payStatusColor = (s: string | null) =>
    s === "paid" ? "#4ade80" : s === "pending" ? ACCENT : "var(--text-muted)";

  return (
    <section id="team" style={{ paddingBottom: 40 }}>
      <SectionHeading>Team</SectionHeading>

      {/* Invite form */}
      <div style={{ ...card, border: "1px solid rgba(245,166,35,0.2)", marginBottom: 16 }}>
        <p style={{ ...label, marginBottom: 14 }}>Invite participant</p>
        <fetcher.Form ref={formRef} method="post">
          <input type="hidden" name="intent" value="invite_team_member" />
          <input type="hidden" name="booking_id" value={bookingId} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <p style={{ ...label, marginBottom: 5 }}>Name</p>
              <input name="name" type="text" placeholder="Alex Smith" required style={inputStyle} />
            </div>
            <div>
              <p style={{ ...label, marginBottom: 5 }}>Email</p>
              <input name="email" type="email" placeholder="alex@example.com" required style={inputStyle} />
            </div>
            <div>
              <p style={{ ...label, marginBottom: 5 }}>Role</p>
              <input name="role" type="text" placeholder="Audio Engineer" style={inputStyle} />
            </div>
            <div>
              <p style={{ ...label, marginBottom: 5 }}>Pay</p>
              <input name="pay" type="number" placeholder="500" style={inputStyle} />
            </div>
          </div>
          {fetcher.data?.error && (
            <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 10px" }}>{fetcher.data.error}</p>
          )}
          <button
            type="submit"
            disabled={isSending}
            style={{
              display: "block",
              margin: "4px auto 0",
              padding: "11px 28px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 700,
              cursor: isSending ? "default" : "pointer",
              opacity: isSending ? 0.6 : 1,
              fontFamily: FONT_BODY,
            }}
          >
            {isSending ? "Inviting…" : "Invite Participant"}
          </button>
        </fetcher.Form>
      </div>

      {/* Success toast */}
      {lastInvited && (
        <div style={{ background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#4ade80" }}>
          ✓ Invite sent to {lastInvited}
        </div>
      )}

      {/* Participant cards */}
      {participants.length === 0 ? (
        <div style={{ textAlign: "center", padding: "28px 24px", color: "var(--text-muted)", fontSize: 14 }}>
          No participants yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {participants.map((p) => (
            <div key={p.id} style={{ ...card, marginBottom: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: "50%", background: "rgba(245,166,35,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
                  👤
                </div>
                <div style={{ minWidth: 0 }}>
                  <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name ?? "Team member"}
                  </p>
                  {p.role && (
                    <p style={{ color: "var(--text-muted)", fontSize: 11, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.role}
                    </p>
                  )}
                </div>
              </div>
              {p.pay_status && (
                <span style={{ fontSize: 11, fontWeight: 600, color: payStatusColor(p.pay_status), textTransform: "capitalize" }}>
                  {p.pay_status}
                  {p.pay ? ` · ${currencySym(null)}${p.pay.toLocaleString()}` : ""}
                </span>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button style={{ flex: 1, padding: "6px 0", background: "var(--surface-muted)", border: "none", borderRadius: 7, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
                  Message
                </button>
                <button style={{ flex: 1, padding: "6px 0", background: "transparent", border: "1px solid var(--border)", borderRadius: 7, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
                  Invoice
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Payments section ─────────────────────────────────────────────────────────

function PaymentsSection({ payments, booking }: { payments: Payment[]; booking: Booking }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const isExternal = booking.payment_method === "external" || booking.payment_method == null;
  const isPaid = booking.payment_status === "paid";
  const hasRate = booking.payment_amount != null && booking.payment_amount > 0;
  const sym = currencySym(booking.payment_currency ?? booking.currency);
  const amount = booking.payment_amount ?? booking.rate;

  const showExternalPayment = isExternal && hasRate;

  return (
    <section id="payments" style={{ paddingBottom: 40 }}>
      <SectionHeading>Payments</SectionHeading>

      {/* External payment card */}
      {showExternalPayment && (
        <div style={{ ...card, marginBottom: 14 }}>
          {isPaid ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 20, fontWeight: 700, color: "#4ade80", margin: "0 0 2px" }}>
                  {sym}{amount!.toLocaleString()} — Paid ✓
                </p>
                {booking.paid_at && (
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                    {new Date(booking.paid_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                )}
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: "rgba(74,222,128,0.12)", color: "#4ade80" }}>
                Paid
              </span>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 14px" }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", display: "block", marginBottom: 4 }}>
                  {sym}{amount!.toLocaleString()}
                </span>
                Awaiting external payment
              </p>
              {fetcher.data?.error && (
                <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 10px" }}>{fetcher.data.error}</p>
              )}
              <button
                onClick={() => {
                  const fd = new FormData();
                  fd.append("intent", "mark_as_paid");
                  fetcher.submit(fd, { method: "post" });
                }}
                disabled={fetcher.state !== "idle"}
                style={{
                  padding: "10px 20px",
                  background: "#4ade80",
                  color: "#111",
                  border: "none",
                  borderRadius: 9,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: fetcher.state !== "idle" ? "default" : "pointer",
                  opacity: fetcher.state !== "idle" ? 0.7 : 1,
                  fontFamily: FONT_BODY,
                }}
              >
                {fetcher.state !== "idle" ? "Saving…" : "Mark as Paid ✓"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stripe invoice rows */}
      {payments.length === 0 && !showExternalPayment ? (
        <div style={{ ...card, textAlign: "center", padding: "36px 24px" }}>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>No invoices yet.</p>
        </div>
      ) : (
        payments.map((p) => {
          const isPaidRow = p.status === "paid";
          const isPendingRow = p.status === "pending";
          const statusColor = isPaidRow ? ACCENT : isPendingRow ? "#facc15" : "var(--text-muted)";
          return (
            <div key={p.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: "var(--text)", fontSize: 14, fontWeight: 600, margin: "0 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Invoice: {p.title ?? "—"}
                </p>
                {p.amount != null && (
                  <p style={{ color: ACCENT, fontSize: 13, fontWeight: 600, margin: 0 }}>
                    {currencySym(p.currency)}{p.amount.toLocaleString()}
                  </p>
                )}
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "capitalize", color: statusColor, padding: "3px 8px", borderRadius: 6, border: `1px solid ${statusColor}30`, background: `${statusColor}12`, flexShrink: 0 }}>
                {p.status ?? "unknown"}
              </span>
              {p.stripe_invoice_url ? (
                <a
                  href={p.stripe_invoice_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--text-muted)", fontSize: 12, textDecoration: "none", padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 7, display: "flex", alignItems: "center", gap: 4, flexShrink: 0, fontFamily: FONT_BODY }}
                >
                  Invoice ↗
                </a>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 10px", flexShrink: 0 }}>
                  Invoice ↗
                </span>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

// ─── Actions section ──────────────────────────────────────────────────────────

function ActionsSection({ booking }: { booking: Booking }) {
  const fetcher = useFetcher();

  function submitStatus(status: string) {
    const fd = new FormData();
    fd.append("intent", "update_status");
    fd.append("status", status);
    fetcher.submit(fd, { method: "post" });
  }

  const isRequested = booking.status === "requested";
  const actionLink: React.CSSProperties = {
    background: "none",
    border: "none",
    color: ACCENT,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "10px 0",
    fontFamily: FONT_BODY,
    textAlign: "left",
    display: "block",
    width: "100%",
    borderBottom: "1px solid var(--border)",
  };

  return (
    <section id="actions" style={{ paddingBottom: 80 }}>
      <SectionHeading>Actions</SectionHeading>
      <div style={card}>
        {isRequested ? (
          <>
            <button
              style={actionLink}
              onClick={() => {
                const el = document.getElementById("proposal");
                if (!el) return;
                const top = el.getBoundingClientRect().top + window.scrollY - 120;
                window.scrollTo({ top, behavior: "smooth" });
              }}
            >
              Send Proposal →
            </button>
            <button
              style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
              onClick={() => submitStatus("archived")}
              disabled={fetcher.state !== "idle"}
            >
              Decline Request
            </button>
          </>
        ) : (
          <>
            {booking.status !== "confirmed" && (
              <button style={actionLink} onClick={() => submitStatus("confirmed")} disabled={fetcher.state !== "idle"}>
                Mark Confirmed
              </button>
            )}
            {booking.status !== "completed" && (
              <button
                style={{ ...actionLink, borderBottom: booking.status !== "archived" ? undefined : "none" }}
                onClick={() => submitStatus("completed")}
                disabled={fetcher.state !== "idle"}
              >
                Mark Completed
              </button>
            )}
            {booking.status !== "archived" && (
              <button
                style={{ ...actionLink, color: "var(--text-muted)", borderBottom: "none" }}
                onClick={() => submitStatus("archived")}
                disabled={fetcher.state !== "idle"}
              >
                Archive
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingDetailPage() {
  const { booking, payments, profileId, userEmail, planId, isBeta } = useLoaderData<typeof loader>();
  const b = booking as unknown as Booking;
  const isRequested = b.status === "requested";
  const planLevel = getPlanLevel(planId as number | null, isBeta as boolean);

  const sections = isRequested
    ? [
        { id: "details",  label: "Details" },
        { id: "proposal", label: "Proposal" },
        { id: "actions",  label: "Actions" },
      ]
    : [
        { id: "details",  label: "Details" },
        { id: "team",     label: "Team" },
        { id: "payments", label: "Payments" },
        { id: "actions",  label: "Actions" },
      ];

  const [activeSection, setActiveSection] = useState(sections[0].id);

  // Scrollspy via scroll listener
  useEffect(() => {
    const OFFSET = 120;
    function onScroll() {
      let current = sections[0].id;
      for (const { id } of sections) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= OFFSET) {
          current = id;
        }
      }
      setActiveSection(current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isRequested]); // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 116;
    window.scrollTo({ top, behavior: "smooth" });
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", fontFamily: FONT_BODY }}>
      {/* Sticky section nav */}
      <div
        style={{
          position: "sticky",
          top: 56,
          zIndex: 20,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 0,
          padding: "0 24px",
        }}
      >
        <Link
          to="/office"
          style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none", paddingRight: 20, borderRight: "1px solid var(--border)", marginRight: 12, lineHeight: "50px" }}
        >
          ← Back
        </Link>
        {sections.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => scrollToSection(id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeSection === id ? `2px solid ${ACCENT}` : "2px solid transparent",
              color: activeSection === id ? ACCENT : "var(--text-muted)",
              fontSize: 13,
              fontWeight: activeSection === id ? 700 : 500,
              padding: "14px 14px",
              cursor: "pointer",
              transition: "color 0.15s",
              fontFamily: FONT_BODY,
              lineHeight: "22px",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Page header */}
      <div style={{ padding: "28px 24px 8px" }}>
        <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.3 }}>
          {b.title ?? b.service ?? "Booking"}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <StatusBadge status={b.status} />
          {b.city && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>📍 {b.city}</span>
          )}
          {b.date_start && (
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {new Date(b.date_start).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
        </div>
      </div>

      {/* Sections */}
      <div style={{ padding: "24px 24px 0" }}>
        <DetailsSection booking={b} />

        {isRequested && <ProposalSection booking={b} planLevel={planLevel} />}

        {!isRequested && (
          <>
            <TeamSection participants={b.booking_participants} bookingId={b.id} />
            <PaymentsSection payments={payments as unknown as Payment[]} booking={b} />
          </>
        )}

        <ActionsSection booking={b} />
      </div>

      <BookingChat bookingId={b.id} currentUserEmail={userEmail} isOwner={true} />
    </div>
  );
}
