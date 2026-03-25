import { useState, useRef } from "react";
import { redirect, useLoaderData, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/_app.domain";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { addDomainToVercel, getDomainStatus } from "~/lib/vercel.server";
import { getPlanLevel, FEATURE_GATES } from "~/lib/plans";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid rgba(245,166,35,0.28)",
  borderRadius: 16,
  padding: "22px 24px",
  marginBottom: 20,
  position: "relative",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 13px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 14,
  color: "var(--text)",
  outline: "none",
  boxSizing: "border-box" as const,
  fontFamily: FONT_BODY,
};

const ALLOWED_PIXEL_FIELDS = ["pixel_facebook", "pixel_google", "pixel_linkedin", "hubspot_portal_id"];

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  return Response.json(
    {
      pixel_facebook: profile.pixel_facebook ?? "",
      pixel_google: profile.pixel_google ?? "",
      pixel_linkedin: profile.pixel_linkedin ?? "",
      hubspot_portal_id: profile.hubspot_portal_id ?? "",
      custom_domain: profile.custom_domain ?? "",
      custom_domain_verified: profile.custom_domain_verified ?? false,
      profile_id: profile.id,
      plan_id: (profile.plan_id as number | null) ?? null,
    },
    { headers }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Pixel / tracking field save ─────────────────────────────────────────
  if (intent === "save_field") {
    const field = formData.get("field") as string;
    const value = formData.get("value") as string;

    if (!ALLOWED_PIXEL_FIELDS.includes(field)) {
      return Response.json({ ok: false, error: "Invalid field" }, { headers });
    }

    const { error } = await supabase
      .from("profiles")
      .update({ [field]: value || null })
      .eq("id", profile.id as string);

    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  // ── Save custom domain + register with Vercel ────────────────────────────
  if (intent === "save_domain") {
    const domain = (formData.get("domain") as string).trim().toLowerCase();

    if (!domain) {
      // Clear domain
      await supabase
        .from("profiles")
        .update({ custom_domain: null, custom_domain_verified: false })
        .eq("id", profile.id as string);
      return Response.json({ ok: true, cleared: true }, { headers });
    }

    // Register with Vercel
    const vercelResult = await addDomainToVercel(domain);

    // Save to profile regardless of Vercel response (DNS may already exist)
    const { error } = await supabase
      .from("profiles")
      .update({ custom_domain: domain, custom_domain_verified: false })
      .eq("id", profile.id as string);

    return Response.json(
      { ok: !error, error: error?.message, vercel: vercelResult },
      { headers }
    );
  }

  // ── Check domain verification status ────────────────────────────────────
  if (intent === "check_domain") {
    const domain = formData.get("domain") as string;
    const status = await getDomainStatus(domain);

    const verified = status?.verified === true;

    if (verified) {
      await supabase
        .from("profiles")
        .update({ custom_domain_verified: true })
        .eq("id", profile.id as string);
    }

    return Response.json({ ok: true, verified, status }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

// ── Pixel field card (unchanged) ─────────────────────────────────────────────

type FieldCardProps = {
  field: string;
  title: string;
  whyLabel: string;
  explanation: string;
  initialValue: string;
};

function FieldCard({ field, title, whyLabel, explanation, initialValue }: FieldCardProps) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSet = !!value.trim();

  function handleBlur() {
    if (value === initialValue) return;
    const fd = new FormData();
    fd.append("intent", "save_field");
    fd.append("field", field);
    fd.append("value", value);
    fetcher.submit(fd, { method: "post" });
    setSaved(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={card}>
      <span style={{
        position: "absolute", top: 16, right: 18,
        fontSize: 11, fontWeight: 700,
        color: isSet ? ACCENT : "var(--text-muted)",
        fontFamily: FONT_BODY,
      }}>
        {isSet ? "✓ Completed" : "Not set"}
      </span>

      <p style={{
        fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: "0.07em",
        margin: "0 0 4px", fontFamily: FONT_BODY,
      }}>
        {whyLabel}
      </p>

      <h2 style={{
        fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 800,
        color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em",
        margin: "0 0 10px", lineHeight: 1.1,
      }}>
        {title}
      </h2>

      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.6, fontFamily: FONT_BODY }}>
        {explanation}
      </p>

      <div style={{ position: "relative" }}>
        <input
          style={inputStyle}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={handleBlur}
          placeholder={`Enter your ${title}…`}
        />
        {saved && (
          <span style={{
            position: "absolute", right: 12, top: "50%",
            transform: "translateY(-50%)", fontSize: 11, fontWeight: 700,
            color: ACCENT, fontFamily: FONT_BODY, pointerEvents: "none",
          }}>
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

// ── Custom domain card ────────────────────────────────────────────────────────

function CustomDomainCard({
  initialDomain,
  initialVerified,
  locked,
  onUpgrade,
}: {
  initialDomain: string;
  initialVerified: boolean;
  locked?: boolean;
  onUpgrade?: () => void;
}) {
  const fetcher = useFetcher();
  const checkFetcher = useFetcher();
  const [domain, setDomain] = useState(initialDomain);
  const [saved, setSaved] = useState(!!initialDomain);
  const [verified, setVerified] = useState(initialVerified);

  const actionData = fetcher.data as { ok: boolean; error?: string; cleared?: boolean } | undefined;
  const checkData = checkFetcher.data as { ok: boolean; verified?: boolean } | undefined;

  // Sync verified state from check response
  if (checkData?.ok && checkData.verified !== undefined && checkData.verified !== verified) {
    setVerified(checkData.verified);
  }

  function handleSave() {
    const fd = new FormData();
    fd.append("intent", "save_domain");
    fd.append("domain", domain);
    fetcher.submit(fd, { method: "post" });
    setSaved(!!domain.trim());
    setVerified(false);
  }

  function handleCheck() {
    const fd = new FormData();
    fd.append("intent", "check_domain");
    fd.append("domain", domain);
    checkFetcher.submit(fd, { method: "post" });
  }

  const isSaving = fetcher.state !== "idle";
  const isChecking = checkFetcher.state !== "idle";

  return (
    <div style={card}>
      <span style={{
        position: "absolute", top: 16, right: 18,
        fontSize: 11, fontWeight: 700,
        color: verified ? "#22c55e" : saved && domain ? ACCENT : "var(--text-muted)",
        fontFamily: FONT_BODY,
      }}>
        {verified ? "✓ Verified" : saved && domain ? "Pending DNS" : "Not set"}
      </span>

      <p style={{
        fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: "0.07em",
        margin: "0 0 4px", fontFamily: FONT_BODY,
      }}>
        WHY USE A
      </p>

      <h2 style={{
        fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 800,
        color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em",
        margin: "0 0 10px", lineHeight: 1.1,
        display: "flex", alignItems: "center", gap: 10,
      }}>
        Custom Domain
        {locked && (
          <button onClick={onUpgrade} title="Upgrade to unlock" style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 18, padding: 0, lineHeight: 1, color: "var(--text-muted)",
          }}>🔒</button>
        )}
      </h2>

      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.6, fontFamily: FONT_BODY }}>
        Use your own domain to present your work with full authority and brand control.
        Instead of <strong>username.sqrz.com</strong>, your audience sees <strong>yourname.com</strong> — fully connected to your SQRZ profile.
      </p>

      {/* Domain input + save button */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, opacity: locked ? 0.45 : 1, pointerEvents: locked ? "none" : undefined }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          value={domain}
          onChange={e => setDomain(e.target.value)}
          placeholder="yourdomain.com"
          disabled={locked}
        />
        <button
          onClick={handleSave}
          disabled={isSaving || locked}
          style={{
            padding: "10px 18px",
            background: ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            fontFamily: FONT_BODY,
            cursor: isSaving || locked ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
            opacity: isSaving ? 0.7 : 1,
          }}
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>

      {actionData?.error && (
        <p style={{ fontSize: 12, color: "#ef4444", margin: "0 0 12px", fontFamily: FONT_BODY }}>
          Error: {actionData.error}
        </p>
      )}

      {/* DNS instructions — shown once a domain is saved */}
      {saved && domain && (
        <div style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "16px 18px",
          marginBottom: 16,
        }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", margin: "0 0 12px", fontFamily: FONT_BODY }}>
            Add this record to your domain provider:
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontFamily: "monospace" }}>
            <thead>
              <tr>
                {["Type", "Host", "Value"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: "6px 8px", color: ACCENT, fontWeight: 700 }}>CNAME</td>
                <td style={{ padding: "6px 8px", color: "var(--text)" }}>@</td>
                <td style={{ padding: "6px 8px", color: "var(--text)" }}>cname.vercel-dns.com</td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0", fontFamily: FONT_BODY }}>
            If your registrar doesn't allow CNAME on @, use <strong>www</strong> as the host instead, then redirect the root to www.
          </p>
        </div>
      )}

      {/* Verification status + check button */}
      {saved && domain && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={handleCheck}
            disabled={isChecking || verified}
            style={{
              padding: "8px 16px",
              background: "transparent",
              color: verified ? "#22c55e" : ACCENT,
              border: `1px solid ${verified ? "#22c55e" : ACCENT}`,
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: FONT_BODY,
              cursor: isChecking || verified ? "not-allowed" : "pointer",
              opacity: isChecking ? 0.7 : 1,
            }}
          >
            {isChecking ? "Checking…" : verified ? "Domain verified ✓" : "Check Verification"}
          </button>

          {checkData?.ok && !verified && (
            <span style={{ fontSize: 13, color: ACCENT, fontFamily: FONT_BODY }}>
              Pending — DNS changes can take up to 48 hours
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DomainPage() {
  const data = useLoaderData<typeof loader>() as {
    pixel_facebook: string;
    pixel_google: string;
    pixel_linkedin: string;
    hubspot_portal_id: string;
    custom_domain: string;
    custom_domain_verified: boolean;
    plan_id: number | null;
  };
  const navigate = useNavigate();
  const domainLocked = getPlanLevel(data.plan_id) < FEATURE_GATES.domain;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY, fontSize: 36, fontWeight: 800,
        color: ACCENT, textTransform: "uppercase", letterSpacing: "0.03em",
        margin: "0 0 28px", lineHeight: 1.1,
      }}>
        Track. Own. Grow.
      </h1>

      <FieldCard
        field="pixel_facebook"
        title="Meta Pixel"
        whyLabel="WHY INSTALL THE"
        explanation="The Meta Pixel tracks visitors to your SQRZ page and builds retargeting audiences automatically. Install it to stop guessing — and start advertising to people who already showed interest."
        initialValue={data.pixel_facebook}
      />

      <FieldCard
        field="pixel_google"
        title="Google Analytics"
        whyLabel="WHY INSTALL"
        explanation="Google Analytics shows how visitors find you and what they do on your page. Understand traffic sources, user behavior, and which campaigns actually bring serious interest."
        initialValue={data.pixel_google}
      />

      <FieldCard
        field="pixel_linkedin"
        title="LinkedIn Insight Tag"
        whyLabel="WHY INSTALL THE"
        explanation="The LinkedIn Insight Tag tracks professional visitors to your SQRZ page. Use it to build retargeting audiences and run highly targeted campaigns toward decision-makers and companies."
        initialValue={data.pixel_linkedin}
      />

      <FieldCard
        field="hubspot_portal_id"
        title="HubSpot Tracking Script"
        whyLabel="WHY INSTALL THE"
        explanation="The HubSpot script turns anonymous visitors into measurable contacts over time. It tracks behavior across visits, connects forms to contact records, and builds the intelligence layer behind your growth — so you know who engages, not just how many. *HubSpot is free btw ;)"
        initialValue={data.hubspot_portal_id}
      />

      <CustomDomainCard
        initialDomain={data.custom_domain}
        initialVerified={data.custom_domain_verified}
        locked={domainLocked}
        onUpgrade={() => navigate("?upgrade=1")}
      />
    </div>
  );
}
