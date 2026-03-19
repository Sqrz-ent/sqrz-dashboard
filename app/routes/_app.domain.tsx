import { useState, useRef } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.domain";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";

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

const ALLOWED_FIELDS = ["pixel_facebook", "pixel_google", "pixel_linkedin", "hubspot_portal_id", "custom_domain"];

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
      profile_id: profile.id,
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
  const field = formData.get("field") as string;
  const value = formData.get("value") as string;

  if (!ALLOWED_FIELDS.includes(field)) {
    return Response.json({ ok: false, error: "Invalid field" }, { headers });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ [field]: value || null })
    .eq("id", profile.id as string);

  return Response.json({ ok: !error, error: error?.message }, { headers });
}

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
    fd.append("field", field);
    fd.append("value", value);
    fetcher.submit(fd, { method: "post" });
    setSaved(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={card}>
      {/* Completion badge */}
      <span style={{
        position: "absolute", top: 16, right: 18,
        fontSize: 11, fontWeight: 700,
        color: isSet ? ACCENT : "var(--text-muted)",
        fontFamily: FONT_BODY,
      }}>
        {isSet ? "✓ Completed" : "Not set"}
      </span>

      <p style={{
        fontSize: 11,
        fontWeight: 700,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        margin: "0 0 4px",
        fontFamily: FONT_BODY,
      }}>
        {whyLabel}
      </p>

      <h2 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 28,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 10px",
        lineHeight: 1.1,
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
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 11,
            fontWeight: 700,
            color: ACCENT,
            fontFamily: FONT_BODY,
            pointerEvents: "none",
          }}>
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

export default function DomainPage() {
  const data = useLoaderData<typeof loader>() as {
    pixel_facebook: string;
    pixel_google: string;
    pixel_linkedin: string;
    hubspot_portal_id: string;
    custom_domain: string;
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={{
        fontFamily: FONT_DISPLAY,
        fontSize: 36,
        fontWeight: 800,
        color: ACCENT,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        margin: "0 0 28px",
        lineHeight: 1.1,
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

      <FieldCard
        field="custom_domain"
        title="Custom Domain"
        whyLabel="WHY USE A"
        explanation="Use your own domain to present your work with full authority and brand control. Instead of username.sqrz.com, your audience sees yourname.com — fully connected to your SQRZ profile. Domain activation may take up to 24–72 hours after DNS changes."
        initialValue={data.custom_domain}
      />
    </div>
  );
}
