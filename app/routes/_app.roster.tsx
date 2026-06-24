import { useEffect, useState } from "react";
import { redirect, useLoaderData, useFetcher, Form } from "react-router";
import type { Route } from "./+types/_app.roster";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getOwnerProfile } from "~/lib/profile.server";
import { isAgent } from "~/lib/agent.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type RosterRow = {
  delegation_id: string;
  permission_scope: string[];
  delegated_since: string;
  profile_id: string;
  slug: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  user_type: string | null;
  is_published: boolean | null;
  is_claimed: boolean | null;
  claim_token: string | null;
  profile_url: string | null;
  total_views: number;
  views_last_30d: number;
  active_campaigns: number;
  total_bookings: number;
  pending_bookings: number;
};

type LoaderData = { roster: RosterRow[] };

type CreateResult = {
  slug?: string;
  name?: string;
  claim_token?: string;
  profile_url?: string;
  claim_url?: string;
  error?: string;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  // Roster is always the REAL user's roster — never the acting-as profile.
  const owner = await getOwnerProfile(supabase, user.id);
  if (!owner) return redirect("/login", { headers });

  // Gate: must be a manager (≥1 active beta delegation).
  if (!(await isAgent(owner.id as string))) {
    throw new Response("Not found", { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_agent_roster", {
    p_agent_profile_id: owner.id as string,
  });

  if (error) {
    console.error("[roster] get_agent_roster error:", error.message);
  }

  return Response.json({ roster: (data ?? []) as RosterRow[] }, { headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeSlugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function displayName(p: RosterRow): string {
  return (
    p.name ||
    [p.first_name, p.last_name].filter(Boolean).join(" ") ||
    p.slug ||
    "Untitled"
  );
}

function initialsOf(p: RosterRow): string {
  return displayName(p)
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// ─── Stat pill ────────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ color: "var(--text)", fontSize: 16, fontWeight: 700 }}>{value}</div>
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ─── Roster card ──────────────────────────────────────────────────────────────

function RosterCard({ row }: { row: RosterRow }) {
  const [copied, setCopied] = useState(false);
  const claimUrl =
    !row.is_claimed && row.claim_token && row.profile_url
      ? `${row.profile_url}?claim=${encodeURIComponent(row.claim_token)}`
      : null;

  async function copyClaim() {
    if (!row.claim_token) return;
    try {
      await navigator.clipboard.writeText(row.claim_token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt("Copy claim code", row.claim_token);
    }
  }

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Identity */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {row.avatar_url ? (
          <img
            src={row.avatar_url}
            alt=""
            style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background: "rgba(245,166,35,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              fontWeight: 700,
              color: "#F5A623",
            }}
          >
            {initialsOf(row)}
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              color: "var(--text)",
              fontWeight: 600,
              fontSize: 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName(row)}
          </div>
          {row.slug && (
            <div style={{ color: "#F5A623", fontSize: 11, opacity: 0.8 }}>
              {row.slug}.sqrz.com
            </div>
          )}
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            borderRadius: 999,
            padding: "3px 7px",
            background: row.is_claimed ? "rgba(74,222,128,0.14)" : "rgba(96,165,250,0.14)",
            color: row.is_claimed ? "#4ade80" : "#60a5fa",
            flexShrink: 0,
          }}
        >
          {row.is_claimed ? "Claimed" : "Unclaimed"}
        </span>
      </div>

      {/* Stats */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "10px 0",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Stat label="Views 30d" value={row.views_last_30d} />
        <Stat label="Bookings" value={row.total_bookings} />
        <Stat label="Pending" value={row.pending_bookings} />
        <Stat label="Campaigns" value={row.active_campaigns} />
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <Form method="post" action="/roster/switch" style={{ flex: 1, display: "flex" }}>
          <input type="hidden" name="profileId" value={row.profile_id} />
          <button
            type="submit"
            style={{
              flex: 1,
              background: "#F5A623",
              color: "#111111",
              border: "none",
              borderRadius: 9,
              fontSize: 13,
              fontWeight: 700,
              padding: "9px 12px",
              cursor: "pointer",
            }}
          >
            Manage
          </button>
        </Form>
        {!row.is_claimed && row.claim_token && (
          <button
            type="button"
            onClick={copyClaim}
            title={claimUrl ?? undefined}
            style={{
              background: "transparent",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 9,
              fontSize: 13,
              fontWeight: 700,
              padding: "9px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied ✓" : "Copy Claim Code"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Roster() {
  const { roster } = useLoaderData<typeof loader>() as LoaderData;

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const createFetcher = useFetcher<CreateResult>();
  const isCreating = createFetcher.state !== "idle";
  const error = createFetcher.data?.error ?? null;

  // Auto-derive slug from name until the user edits the slug directly.
  useEffect(() => {
    if (!slugTouched) setSlug(sanitizeSlugInput(name));
  }, [name, slugTouched]);

  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data && !createFetcher.data.error) {
      setCreated(createFetcher.data);
      setShowCreate(false);
      setName("");
      setSlug("");
      setSlugTouched(false);
    }
  }, [createFetcher.state, createFetcher.data]);

  function handleCreate() {
    if (!slug.trim()) return;
    createFetcher.submit(
      { name: name.trim(), slug },
      { method: "POST", action: "/api/crew/create-profile" }
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <h1 style={{ color: "var(--text)", fontSize: 24, fontWeight: 700, margin: 0 }}>Roster</h1>
        <button
          type="button"
          onClick={() => {
            setShowCreate(true);
            setName("");
            setSlug("");
            setSlugTouched(false);
          }}
          style={{
            background: "#F5A623",
            color: "#111111",
            border: "none",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 700,
            padding: "9px 14px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          + Create Profile
        </button>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 28 }}>
        Talent you manage. Hit <strong style={{ color: "var(--text)" }}>Manage</strong> to run
        a profile from your own login.
      </p>

      {roster.length === 0 ? (
        <div style={{ textAlign: "center", padding: "64px 24px", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
          <p style={{ fontSize: 14, margin: 0 }}>
            Your roster is empty. Create a managed profile to get started.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 14,
          }}
        >
          {roster.map((row) => (
            <RosterCard key={row.delegation_id} row={row} />
          ))}
        </div>
      )}

      {/* ── Create Managed Profile modal ─────────────────────────────────────── */}
      {showCreate && (
        <div
          onClick={() => setShowCreate(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 18,
              padding: 24,
              boxShadow: "0 24px 60px rgba(0,0,0,0.26)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
              <div>
                <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 700 }}>
                  Create managed profile
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
                  Adds the talent to your roster with a claim link.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                aria-label="Close"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 22,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>

            <label style={labelStyle}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Talent name"
              autoFocus
              style={inputStyle}
            />

            <label style={{ ...labelStyle, marginTop: 14 }}>Slug</label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "var(--surface-muted)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(sanitizeSlugInput(e.target.value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && slug.trim()) handleCreate();
                }}
                placeholder="handle"
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  color: "var(--text)",
                  fontSize: 14,
                  padding: "10px 12px",
                  outline: "none",
                }}
              />
              <span
                style={{
                  color: "var(--text-muted)",
                  fontSize: 13,
                  padding: "10px 12px 10px 0",
                  whiteSpace: "nowrap",
                }}
              >
                .sqrz.com
              </span>
            </div>

            {error && (
              <div style={{ color: "#f87171", fontSize: 13, marginTop: 12 }}>{error}</div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!slug.trim() || isCreating}
                style={{
                  flex: 1,
                  background: !slug.trim() || isCreating ? "rgba(245,166,35,0.4)" : "#F5A623",
                  color: "#111111",
                  border: "none",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 18px",
                  cursor: !slug.trim() || isCreating ? "default" : "pointer",
                }}
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                style={{
                  background: "transparent",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Created result modal (claim token + profile url) ─────────────────── */}
      {created && (
        <div
          onClick={() => setCreated(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 460,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 18,
              padding: 24,
              boxShadow: "0 24px 60px rgba(0,0,0,0.26)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
              <div style={{ color: "var(--text)", fontSize: 20, fontWeight: 700 }}>
                Profile created
              </div>
              <button
                type="button"
                onClick={() => setCreated(null)}
                aria-label="Close"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 22,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>

            <CopyBlock label="Claim code" value={created.claim_token ?? ""} />
            <CopyBlock
              label="Profile URL"
              value={created.claim_url ?? created.profile_url ?? ""}
            />

            <button
              type="button"
              onClick={() => setCreated(null)}
              style={{
                marginTop: 16,
                background: "#F5A623",
                color: "#111111",
                border: "none",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 700,
                padding: "10px 14px",
                cursor: "pointer",
                width: "100%",
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div
      style={{
        background: "rgba(245,166,35,0.06)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div
          style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.5, wordBreak: "break-all" }}
        >
          {value}
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch {
              window.prompt(`Copy ${label}`, value);
            }
          }}
          style={{
            background: "transparent",
            color: "#F5A623",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 700,
            padding: "6px 10px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {copied ? "✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  display: "block",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface-muted)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 14,
  padding: "10px 12px",
  outline: "none",
};
