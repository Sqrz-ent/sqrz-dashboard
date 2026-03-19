import { useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.service";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
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

const sectionTitle: React.CSSProperties = {
  fontFamily: FONT_DISPLAY,
  fontSize: 30,
  fontWeight: 800,
  color: ACCENT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.03em",
  margin: "0 0 18px",
  lineHeight: 1.1,
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

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.07em",
  display: "block",
  marginBottom: 6,
};

const saveBtn: React.CSSProperties = {
  padding: "10px 22px",
  background: ACCENT,
  color: "#111",
  border: "none",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: FONT_BODY,
  marginTop: 14,
};

function MenuDots({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, padding: "2px 6px", lineHeight: 1 }}>⋮</button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, zIndex: 10, minWidth: 110, boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}>
          <button onClick={() => { onEdit(); setOpen(false); }} style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>Edit</button>
          <button onClick={() => { onDelete(); setOpen(false); }} style={{ display: "block", width: "100%", padding: "9px 14px", background: "none", border: "none", textAlign: "left", fontSize: 13, color: "#ef4444", cursor: "pointer", fontFamily: FONT_BODY }}>Delete</button>
        </div>
      )}
    </div>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const { data: services } = await supabase
    .from("profile_services")
    .select("*")
    .eq("profile_id", profile.id as string)
    .order("sort_order", { ascending: true });

  return Response.json({ profile, services: services ?? [] }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "toggle_services") {
    const { error } = await supabase.from("profiles").update({
      services_active: !(profile.services_active as boolean),
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  const adminClient = createSupabaseAdminClient();

  if (intent === "add_service") {
    const priceOnRequest = formData.get("price_on_request") === "true";
    const { error } = await adminClient.from("profile_services").insert({
      profile_id: profile.id as string,
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: priceOnRequest ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: priceOnRequest ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: priceOnRequest ? null : ((formData.get("currency") as string) || "EUR"),
      is_active: true,
      sort_order: 0,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_service") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_services").delete().eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_service") {
    const id = formData.get("id") as string;
    const priceOnRequest = formData.get("price_on_request") === "true";
    const { error } = await adminClient.from("profile_services").update({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: priceOnRequest ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: priceOnRequest ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: priceOnRequest ? null : ((formData.get("currency") as string) || "EUR"),
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

type Service = {
  id: string;
  title: string;
  description: string | null;
  price_min: number | null;
  price_max: number | null;
  price_label: string | null;
  currency: string | null;
  is_active: boolean;
  sort_order: number;
};

function EditServiceForm({ service, onCancel }: { service: Service; onCancel: () => void }) {
  const fetcher = useFetcher();
  const [priceOnRequest, setPriceOnRequest] = useState(service.price_label === "Price on request");
  const [form, setForm] = useState({
    title: service.title ?? "",
    description: service.description ?? "",
    price_min: String(service.price_min ?? ""),
    price_max: String(service.price_max ?? ""),
    currency: service.currency ?? "EUR",
  });

  return (
    <fetcher.Form method="post" style={{ padding: "14px 0 4px", display: "flex", flexDirection: "column", gap: 10 }}>
      <input type="hidden" name="intent" value="update_service" />
      <input type="hidden" name="id" value={service.id} />
      <input type="hidden" name="price_on_request" value={String(priceOnRequest)} />
      <div>
        <label style={labelStyle}>Service Name</label>
        <input name="title" style={inputStyle} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
      </div>
      <div>
        <label style={labelStyle}>Description</label>
        <textarea name="description" rows={3} style={{ ...inputStyle, resize: "vertical" }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>
        <input type="checkbox" checked={priceOnRequest} onChange={e => setPriceOnRequest(e.target.checked)} />
        Price on request
      </label>
      {!priceOnRequest && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 10 }}>
          <div>
            <label style={labelStyle}>Min Price</label>
            <input name="price_min" type="number" style={inputStyle} value={form.price_min} onChange={e => setForm(f => ({ ...f, price_min: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Max Price</label>
            <input name="price_max" type="number" style={inputStyle} value={form.price_max} onChange={e => setForm(f => ({ ...f, price_max: e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select name="currency" style={{ ...inputStyle }} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="submit" style={{ ...saveBtn, marginTop: 0, fontSize: 13, padding: "8px 16px" }} disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save Changes"}
        </button>
        <button type="button" onClick={onCancel} style={{ padding: "8px 16px", background: "none", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>
          Cancel
        </button>
      </div>
    </fetcher.Form>
  );
}

function ServiceCard({ service }: { service: Service }) {
  const [editing, setEditing] = useState(false);
  const deleteFetcher = useFetcher();

  const priceDisplay = service.price_label === "Price on request"
    ? "Price on request"
    : service.price_min != null || service.price_max != null
    ? `${service.currency ?? "€"}${service.price_min ?? ""}${service.price_max != null ? ` – ${service.currency ?? "€"}${service.price_max}` : ""}`
    : null;

  return (
    <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 14, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{service.title}</div>
          {priceDisplay && (
            <div style={{ fontSize: 13, color: service.price_label === "Price on request" ? "var(--text-muted)" : ACCENT, marginTop: 2, fontWeight: 600 }}>
              {priceDisplay}
            </div>
          )}
          {service.description && (
            <div style={{
              fontSize: 13,
              color: "var(--text-muted)",
              marginTop: 4,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}>
              {service.description}
            </div>
          )}
        </div>
        <MenuDots
          onEdit={() => setEditing(v => !v)}
          onDelete={() => {
            const fd = new FormData();
            fd.append("intent", "delete_service");
            fd.append("id", service.id);
            deleteFetcher.submit(fd, { method: "post" });
          }}
        />
      </div>
      {editing && <EditServiceForm service={service} onCancel={() => setEditing(false)} />}
    </div>
  );
}

export default function ServicePage() {
  const { profile, services } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    services: Service[];
  };

  const toggleFetcher = useFetcher();
  const addFetcher = useFetcher();

  const [showAddForm, setShowAddForm] = useState(false);
  const [priceOnRequest, setPriceOnRequest] = useState(false);
  const [addForm, setAddForm] = useState({
    title: "",
    description: "",
    price_min: "",
    price_max: "",
    currency: "EUR",
  });

  const servicesActive = profile.services_active as boolean;

  function handleAddSubmit() {
    if (!addForm.title.trim()) return;
    const fd = new FormData();
    fd.append("intent", "add_service");
    fd.append("title", addForm.title);
    fd.append("description", addForm.description);
    fd.append("price_on_request", String(priceOnRequest));
    if (!priceOnRequest) {
      fd.append("price_min", addForm.price_min);
      fd.append("price_max", addForm.price_max);
      fd.append("currency", addForm.currency);
    }
    addFetcher.submit(fd, { method: "post" });
    setAddForm({ title: "", description: "", price_min: "", price_max: "", currency: "EUR" });
    setPriceOnRequest(false);
    setShowAddForm(false);
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Services</h1>

      {/* Toggle services active */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY }}>Publish your Services</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
              {servicesActive ? "Your services are visible on your profile." : "Your services are hidden from your profile."}
            </div>
          </div>
          <button
            onClick={() => {
              const fd = new FormData();
              fd.append("intent", "toggle_services");
              toggleFetcher.submit(fd, { method: "post" });
            }}
            disabled={toggleFetcher.state !== "idle"}
            style={{
              padding: "10px 20px",
              background: servicesActive ? ACCENT : "var(--bg)",
              color: servicesActive ? "#111" : "var(--text-muted)",
              border: servicesActive ? "none" : "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: FONT_BODY,
              minWidth: 80,
            }}
          >
            {toggleFetcher.state !== "idle" ? "…" : servicesActive ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      {/* Services list */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 18 }}>Your Services</h2>

        {services.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No services added yet.</p>
        ) : (
          <div>
            {services.map(service => (
              <ServiceCard key={service.id} service={service} />
            ))}
          </div>
        )}

        <button
          onClick={() => setShowAddForm(v => !v)}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          {showAddForm ? "Cancel" : "+ Add Service"}
        </button>

        {showAddForm && (
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Service Name</label>
              <input
                style={inputStyle}
                value={addForm.title}
                onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. DJ Set, Live Performance"
              />
            </div>
            <div>
              <label style={labelStyle}>Terms / Description</label>
              <textarea
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
                value={addForm.description}
                onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Describe what's included…"
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>
              <input type="checkbox" checked={priceOnRequest} onChange={e => setPriceOnRequest(e.target.checked)} />
              Price on request
            </label>
            {!priceOnRequest && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 10 }}>
                <div>
                  <label style={labelStyle}>Min Price</label>
                  <input
                    type="number"
                    style={inputStyle}
                    value={addForm.price_min}
                    onChange={e => setAddForm(f => ({ ...f, price_min: e.target.value }))}
                    placeholder="500"
                  />
                </div>
                <div>
                  <label style={labelStyle}>Max Price</label>
                  <input
                    type="number"
                    style={inputStyle}
                    value={addForm.price_max}
                    onChange={e => setAddForm(f => ({ ...f, price_max: e.target.value }))}
                    placeholder="2000"
                  />
                </div>
                <div>
                  <label style={labelStyle}>Currency</label>
                  <select
                    style={{ ...inputStyle }}
                    value={addForm.currency}
                    onChange={e => setAddForm(f => ({ ...f, currency: e.target.value }))}
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
              </div>
            )}
            <button
              onClick={handleAddSubmit}
              disabled={addFetcher.state !== "idle"}
              style={{ ...saveBtn, marginTop: 4, alignSelf: "flex-start" }}
            >
              {addFetcher.state !== "idle" ? "Adding…" : "Add Service"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
