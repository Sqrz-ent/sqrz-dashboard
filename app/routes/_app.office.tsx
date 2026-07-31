import { useLoaderData } from "react-router";
import { useState } from "react";
import { redirect } from "react-router";
import type { Route } from "./+types/_app.office";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type Lead = {
  id: string;
  name: string | null;
  email: string | null;
  message: string | null;
  source: string;
  status: string;
  updated_at: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

const SOURCE_LABELS: Record<string, string> = {
  chat: "Chat",
  web_form: "Web form",
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  // Flat lead list — Active + Archived, newest first. No stages, no pipeline.
  const { data: leadsRaw } = await supabase
    .from("leads")
    .select("id, name, email, message, source, status, updated_at")
    .eq("profile_id", profile.id as string)
    .order("updated_at", { ascending: false });

  const leads: Lead[] = (leadsRaw ?? []) as Lead[];

  return Response.json({ leads }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Lead row + list ──────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: "rgba(245,166,35,0.12)",
        color: ACCENT,
      }}
    >
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function LeadRow({ lead, muted }: { lead: Lead; muted: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          color: muted ? "var(--text-muted)" : "var(--text)",
          fontSize: 14,
          fontWeight: 600,
          margin: "0 0 3px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {lead.name || lead.email || "Anonymous"}
        </p>
        {lead.message ? (
          <p style={{
            color: "var(--text-muted)",
            fontSize: 12,
            margin: "0 0 2px",
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
            overflow: "hidden",
          }}>
            {lead.message}
          </p>
        ) : null}
        {lead.email && (lead.name || lead.message) ? (
          <p style={{ color: "var(--text-muted)", fontSize: 11, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {lead.email}
          </p>
        ) : null}
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
        {formatDate(lead.updated_at)}
      </span>
      <SourceBadge source={lead.source} />
    </div>
  );
}

function LeadList({ leads, muted }: { leads: Lead[]; muted: boolean }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      {leads.map((lead, i) => (
        <div key={lead.id}>
          <LeadRow lead={lead} muted={muted} />
          {i !== leads.length - 1 && <div style={{ borderTop: "1px solid var(--border)" }} />}
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OfficePage() {
  const { leads } = useLoaderData<typeof loader>() as { leads: Lead[] };

  const [showArchived, setShowArchived] = useState(false);

  const activeLeads = leads.filter((l) => l.status === "active");
  const archivedLeads = leads.filter((l) => l.status === "archived");

  return (
    <div style={{ padding: "28px 24px", fontFamily: FONT_BODY }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>
          Office
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
          Your leads
        </p>
      </div>

      <div style={{ maxWidth: 720 }}>
        {/* ─── Active ─── */}
        <div style={{ marginBottom: 10 }}>
          <span style={{ color: "var(--text)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Active
          </span>
        </div>

        {activeLeads.length === 0 ? (
          <div style={{ background: "var(--surface-muted)", border: "1px dashed var(--border)", borderRadius: 12, padding: "20px 16px" }}>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55 }}>
              New leads appear here. Keep a chat active or share your profile to get started.
            </p>
          </div>
        ) : (
          <LeadList leads={activeLeads} muted={false} />
        )}

        {/* ─── Archived ─── */}
        {archivedLeads.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => setShowArchived((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "none",
                border: "none",
                padding: "0 0 10px",
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Archived
              </span>
              <span style={{ color: ACCENT, fontSize: 12, fontWeight: 700 }}>
                {showArchived ? "Hide" : `Show ${archivedLeads.length} archived`}
              </span>
            </button>
            {showArchived && <LeadList leads={archivedLeads} muted={true} />}
          </div>
        )}
      </div>
    </div>
  );
}
