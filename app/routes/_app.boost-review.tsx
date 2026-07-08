import { useState } from "react";
import { redirect, useLoaderData, useFetcher, Link } from "react-router";
import type { Route } from "./+types/_app.boost-review";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { transitionBoostCampaign } from "~/lib/boost.server";

const ACCENT = "#F5A623";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";

type ReviewCampaign = {
  id: string;
  created_at: string | null;
  status_updated_at: string | null;
  promote_type: string | null;
  goal: string | null;
  channel: string | null;
  duration: string | null;
  budget_amount: number;
  budget_currency: string | null;
  target_audience: string | null;
  notes: string | null;
  creative_asset_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  profile_slug: string | null;
  profile_name: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  // Admin-only (same gate as Crew).
  if (!profile?.is_beta) return redirect("/", { headers });

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("boost_campaigns")
    .select(
      "id, created_at, status_updated_at, promote_type, goal, channel, duration, budget_amount, budget_currency, target_audience, notes, creative_asset_url, starts_at, ends_at, profiles(slug, name, brand_name)"
    )
    .eq("status", "in_review")
    .order("status_updated_at", { ascending: true });

  const campaigns: ReviewCampaign[] = (data ?? []).map((c) => {
    const p = c.profiles as { slug?: string; name?: string; brand_name?: string } | null;
    return {
      id: c.id as string,
      created_at: c.created_at as string | null,
      status_updated_at: c.status_updated_at as string | null,
      promote_type: c.promote_type as string | null,
      goal: c.goal as string | null,
      channel: c.channel as string | null,
      duration: c.duration as string | null,
      budget_amount: c.budget_amount as number,
      budget_currency: c.budget_currency as string | null,
      target_audience: c.target_audience as string | null,
      notes: c.notes as string | null,
      creative_asset_url: c.creative_asset_url as string | null,
      starts_at: c.starts_at as string | null,
      ends_at: c.ends_at as string | null,
      profile_slug: p?.slug ?? null,
      profile_name: p?.brand_name || p?.name || null,
    };
  });

  return Response.json({ campaigns }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile?.is_beta) {
    return Response.json({ ok: false, error: "Not authorized" }, { status: 403, headers });
  }

  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  const campaignId = fd.get("campaign_id") as string;
  if (!campaignId) return Response.json({ ok: false, error: "Missing campaign" }, { headers });

  if (intent === "approve") {
    const res = await transitionBoostCampaign({ campaignId, status: "approved" });
    return Response.json(res, { headers });
  }

  if (intent === "request_changes") {
    const feedback = ((fd.get("review_feedback") as string) || "").trim();
    if (!feedback) return Response.json({ ok: false, error: "Feedback is required." }, { headers });
    const res = await transitionBoostCampaign({ campaignId, status: "needs_changes", reviewFeedback: feedback });
    return Response.json(res, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

export default function BoostReviewPage() {
  const { campaigns } = useLoaderData<typeof loader>() as { campaigns: ReviewCampaign[] };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 800, color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em", margin: 0 }}>
          Boost Review
        </h1>
        <Link to="/boost" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>← Boost</Link>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 24px" }}>
        Campaigns awaiting review, oldest first.
      </p>

      {campaigns.length === 0 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "40px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
          Nothing in the queue right now. 🎉
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {campaigns.map((c) => <ReviewCard key={c.id} campaign={c} />)}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ campaign: c }: { campaign: ReviewCampaign }) {
  const fetcher = useFetcher();
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busy = fetcher.state !== "idle";
  const error = (fetcher.data as { ok?: boolean; error?: string } | undefined)?.error;

  const money = `${c.budget_amount.toLocaleString()} ${(c.budget_currency || "USD").toUpperCase()}`;
  const dates = c.starts_at && c.ends_at ? `${c.starts_at} → ${c.ends_at}` : null;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            {c.profile_name || c.profile_slug || "Unknown"}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {c.profile_slug ? `${c.profile_slug}.sqrz.com` : ""}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 800, color: ACCENT, whiteSpace: "nowrap" }}>{money}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 14 }}>
        <Field label="Promoting" value={c.promote_type} />
        <Field label="Goal" value={c.goal} />
        <Field label="Channel" value={c.channel} />
        <Field label="Duration" value={c.duration} />
        {dates && <Field label="Dates" value={dates} />}
      </div>

      {c.target_audience && <Block label="Target audience" value={c.target_audience} />}
      {c.notes && <Block label="Artist notes" value={c.notes} />}

      {c.creative_asset_url && (
        <div style={{ marginTop: 12 }}>
          <FieldLabel>Creative</FieldLabel>
          <a href={c.creative_asset_url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 6 }}>
            {/^https?:\/\/.*\.(png|jpe?g|webp|gif)(\?|$)/i.test(c.creative_asset_url) ? (
              <img src={c.creative_asset_url} alt="Creative" style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 10, border: "1px solid var(--border)", display: "block" }} />
            ) : (
              <span style={{ color: ACCENT, fontSize: 13, fontWeight: 600 }}>Open asset →</span>
            )}
          </a>
        </div>
      )}

      {error && <p style={{ color: "#ef4444", fontSize: 12, fontWeight: 700, margin: "12px 0 0" }}>{error}</p>}

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const fd = new FormData();
            fd.append("intent", "approve");
            fd.append("campaign_id", c.id);
            fetcher.submit(fd, { method: "post" });
          }}
          style={{ ...btn, background: ACCENT, color: "#111", opacity: busy ? 0.6 : 1 }}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowFeedback((v) => !v)}
          style={{ ...btn, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
        >
          Request changes
        </button>
      </div>

      {showFeedback && (
        <div style={{ marginTop: 12 }}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What needs to change before this can go live? (sent to the artist)"
            rows={3}
            style={{
              width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14,
              background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
              borderRadius: 8, fontFamily: FONT_BODY, resize: "vertical",
            }}
          />
          <button
            type="button"
            disabled={busy || !feedback.trim()}
            onClick={() => {
              const fd = new FormData();
              fd.append("intent", "request_changes");
              fd.append("campaign_id", c.id);
              fd.append("review_feedback", feedback.trim());
              fetcher.submit(fd, { method: "post" });
            }}
            style={{ ...btn, marginTop: 8, background: "#ef4444", color: "#fff", opacity: busy || !feedback.trim() ? 0.6 : 1 }}
          >
            Send feedback
          </button>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>{children}</div>;
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ fontSize: 14, color: "var(--text)", marginTop: 3 }}>{value}</div>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ fontSize: 14, color: "var(--text)", marginTop: 4, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 9,
  border: "none",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: FONT_BODY,
};
