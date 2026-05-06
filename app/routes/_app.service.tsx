import { useEffect, useState } from "react";
import { redirect, useLoaderData, useFetcher, useSearchParams } from "react-router";
import type { Route } from "./+types/_app.service";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import Modal from "~/components/Modal";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

const subtleCard: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "14px 16px",
};

const COUNTRY_OPTIONS = [
  "Argentina",
  "Australia",
  "Austria",
  "Belgium",
  "Bolivia",
  "Brazil",
  "Canada",
  "Chile",
  "Colombia",
  "Costa Rica",
  "Croatia",
  "Czech Republic",
  "Denmark",
  "Dominican Republic",
  "Ecuador",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Japan",
  "Mexico",
  "Netherlands",
  "New Zealand",
  "Norway",
  "Panama",
  "Paraguay",
  "Peru",
  "Poland",
  "Portugal",
  "Romania",
  "Singapore",
  "South Africa",
  "South Korea",
  "Spain",
  "Sweden",
  "Switzerland",
  "Turkey",
  "United Kingdom",
  "United States",
  "Uruguay",
];

const COUNTRY_LABEL_BY_CODE: Record<string, string> = {
  AR: "Argentina",
  AT: "Austria",
  AU: "Australia",
  BE: "Belgium",
  BO: "Bolivia",
  BR: "Brazil",
  CA: "Canada",
  CH: "Switzerland",
  CL: "Chile",
  CO: "Colombia",
  CR: "Costa Rica",
  CZ: "Czech Republic",
  DE: "Germany",
  DK: "Denmark",
  DO: "Dominican Republic",
  EC: "Ecuador",
  ES: "Spain",
  FI: "Finland",
  FR: "France",
  GB: "United Kingdom",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  JP: "Japan",
  KR: "South Korea",
  MX: "Mexico",
  NL: "Netherlands",
  NO: "Norway",
  NZ: "New Zealand",
  PA: "Panama",
  PE: "Peru",
  PL: "Poland",
  PT: "Portugal",
  PY: "Paraguay",
  RO: "Romania",
  SE: "Sweden",
  SG: "Singapore",
  TR: "Turkey",
  US: "United States",
  UY: "Uruguay",
  ZA: "South Africa",
};

function normalizeCountryValue(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return COUNTRY_LABEL_BY_CODE[trimmed.toUpperCase()] ?? trimmed;
}

function CompletionBadge({ filled, total }: { filled: number; total: number }) {
  const done = filled >= total && total > 0;
  return (
    <span style={{
      position: "absolute", top: 14, right: 16,
      fontSize: 11, fontWeight: 700,
      background: done ? "#F5A623" : "var(--surface-muted)",
      color: done ? "#7a4800" : "var(--text-muted)",
      padding: "3px 10px",
      borderRadius: 20,
      fontFamily: FONT_BODY,
      letterSpacing: "0.02em",
    }}>
      {done ? "✓ Complete" : `${filled}/${total}`}
    </span>
  );
}

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

  const adminClient = createSupabaseAdminClient();
  const { data: services } = await adminClient
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

  const adminClient = createSupabaseAdminClient();

  if (intent === "toggle_service_active") {
    const id = formData.get("id") as string;
    const is_active = formData.get("is_active") === "true";
    const { error } = await adminClient.from("profile_services").update({ is_active }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "reorder_services") {
    const order = JSON.parse(formData.get("order") as string) as Array<{ id: string; sort_order: number }>;
    await Promise.all(
      order.map(({ id, sort_order }) =>
        adminClient.from("profile_services").update({ sort_order }).eq("id", id).eq("profile_id", profile.id as string)
      )
    );
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_service") {
    const priceOnRequest = formData.get("price_on_request") === "true";
    const bookingType = formData.get("booking_type") as string || "quote";
    const isInstant = bookingType === "instant";
    const { error } = await adminClient.from("profile_services").insert({
      profile_id: profile.id as string,
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: (isInstant || priceOnRequest) ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: (isInstant || priceOnRequest) ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest && !isInstant ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: (isInstant || priceOnRequest) ? null : ((formData.get("currency") as string) || "EUR"),
      price_unit: (isInstant || priceOnRequest) ? null : ((formData.get("price_unit") as string) || "flat"),
      booking_type: bookingType,
      instant_price: isInstant ? (parseFloat(formData.get("instant_price") as string) || null) : null,
      instant_currency: isInstant ? ((formData.get("instant_currency") as string) || "EUR") : null,
      instant_tax_rate: isInstant ? (parseFloat(formData.get("instant_tax_rate") as string) || 0) : null,
      is_active: true,
      sort_order: 0,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_business") {
    const { error } = await supabase.from("profiles").update({
      company_name: formData.get("company_name") as string,
      company_address: formData.get("company_address") as string,
      company_country: ((formData.get("company_country") as string) || null),
      company_tax_id: null,
      legal_form: formData.get("legal_form") as string,
      vat_id: (formData.get("vat_id") as string) || null,
      trade_register_court: (formData.get("trade_register_court") as string) || null,
      trade_register_number: (formData.get("trade_register_number") as string) || null,
      responsible_person: (formData.get("responsible_person") as string) || null,
      regulatory_body: (formData.get("regulatory_body") as string) || null,
      dpo_email: (formData.get("dpo_email") as string) || null,
      external_privacy_url: (formData.get("external_privacy_url") as string) || null,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "toggle_e_invoice_enabled") {
    const hasPaidPlan = !!profile.plan_id && Number(profile.plan_id) > 0;
    const hasOneTimeUnlock = !!(profile.e_invoice_unlocked_at as string | null);
    if (!hasPaidPlan && !hasOneTimeUnlock) {
      return Response.json({ ok: false, error: "E-invoice activation is required first." }, { status: 403, headers });
    }

    const enabled = formData.get("enabled") === "true";
    const { error } = await supabase
      .from("profiles")
      .update({ e_invoice_enabled: enabled })
      .eq("id", profile.id as string);

    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_service") {
    const id = formData.get("id") as string;
    const priceOnRequest = formData.get("price_on_request") === "true";
    const bookingType = formData.get("booking_type") as string || "quote";
    const isInstant = bookingType === "instant";
    const { error } = await adminClient.from("profile_services").update({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: (isInstant || priceOnRequest) ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: (isInstant || priceOnRequest) ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest && !isInstant ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: (isInstant || priceOnRequest) ? null : ((formData.get("currency") as string) || "EUR"),
      price_unit: (isInstant || priceOnRequest) ? null : ((formData.get("price_unit") as string) || "flat"),
      booking_type: bookingType,
      instant_price: isInstant ? (parseFloat(formData.get("instant_price") as string) || null) : null,
      instant_currency: isInstant ? ((formData.get("instant_currency") as string) || "EUR") : null,
      instant_tax_rate: isInstant ? (parseFloat(formData.get("instant_tax_rate") as string) || 0) : null,
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_service") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_services").delete().eq("id", id);
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
  price_unit: string | null;
  currency: string | null;
  is_active: boolean;
  sort_order: number;
  booking_type: "instant" | "quote";
  instant_price: number | null;
  instant_currency: string | null;
  instant_tax_rate: number | null;
};

// ── Sortable service row ──────────────────────────────────────────────────────

function SortableServiceRow({
  service,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  service: Service;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: service.id });

  const priceDisplay =
    service.price_label === "Price on request"
      ? "Price on request"
      : service.price_min != null || service.price_max != null
      ? `${service.currency ?? "€"}${service.price_min ?? ""}${service.price_max != null ? ` – ${service.currency ?? "€"}${service.price_max}` : ""}`
      : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        borderBottom: "1px solid var(--border)",
        paddingBottom: 14,
        marginBottom: 14,
        opacity: isDragging ? 0.5 : service.is_active ? 1 : 0.5,
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        style={{
          background: "none",
          border: "none",
          padding: "2px 4px",
          marginTop: 2,
          cursor: isDragging ? "grabbing" : "grab",
          color: "var(--text-muted)",
          fontSize: 16,
          lineHeight: 1,
          flexShrink: 0,
          opacity: 0.4,
          touchAction: "none",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.8"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.4"; }}
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        ⠿
      </button>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
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
          {/* Active toggle */}
          <button
            onClick={onToggleActive}
            title={service.is_active ? "Active — click to pause" : "Inactive — click to activate"}
            style={{
              width: 36,
              height: 20,
              borderRadius: 10,
              border: "none",
              background: service.is_active ? ACCENT : "var(--surface-muted, #333)",
              cursor: "pointer",
              position: "relative",
              transition: "background 0.15s",
              flexShrink: 0,
              marginTop: 3,
            }}
          >
            <span style={{
              position: "absolute",
              top: 2,
              left: service.is_active ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
            }} />
          </button>
          <MenuDots onEdit={onEdit} onDelete={onDelete} />
        </div>
      </div>
    </div>
  );
}

// ── ServiceModal ──────────────────────────────────────────────────────────────

function ServiceModal({
  isOpen,
  onClose,
  editing,
  fetcher,
  isPremium,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: Service | null;
  fetcher: ReturnType<typeof useFetcher>;
  isPremium: boolean;
}) {
  const [priceOnRequest, setPriceOnRequest] = useState(false);
  const [isInstant, setIsInstant] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    price_min: "",
    price_max: "",
    currency: "EUR",
    price_unit: "flat",
    instant_price: "",
    instant_currency: "EUR",
    instant_tax_rate: "0",
  });

  useEffect(() => {
    if (editing) {
      const instant = editing.booking_type === "instant";
      setIsInstant(instant);
      setPriceOnRequest(!instant && editing.price_label === "Price on request");
      setForm({
        title: editing.title ?? "",
        description: editing.description ?? "",
        price_min: String(editing.price_min ?? ""),
        price_max: String(editing.price_max ?? ""),
        currency: editing.currency ?? "EUR",
        price_unit: editing.price_unit ?? "flat",
        instant_price: String(editing.instant_price ?? ""),
        instant_currency: editing.instant_currency ?? "EUR",
        instant_tax_rate: String(editing.instant_tax_rate ?? "0"),
      });
    } else {
      setIsInstant(false);
      setPriceOnRequest(false);
      setForm({ title: "", description: "", price_min: "", price_max: "", currency: "EUR", price_unit: "flat", instant_price: "", instant_currency: "EUR", instant_tax_rate: "0" });
    }
  }, [editing, isOpen]);

  function handleSubmit() {
    if (!form.title.trim()) return;
    const fd = new FormData();
    fd.append("intent", editing ? "update_service" : "add_service");
    if (editing) fd.append("id", editing.id);
    fd.append("title", form.title);
    fd.append("description", form.description);
    fd.append("booking_type", isInstant ? "instant" : "quote");
    fd.append("price_on_request", String(priceOnRequest && !isInstant));
    if (isInstant) {
      fd.append("instant_price", form.instant_price);
      fd.append("instant_currency", form.instant_currency);
      fd.append("instant_tax_rate", form.instant_tax_rate);
    } else if (!priceOnRequest) {
      fd.append("price_min", form.price_min);
      fd.append("price_max", form.price_max);
      fd.append("currency", form.currency);
      fd.append("price_unit", form.price_unit || "flat");
    }
    fetcher.submit(fd, { method: "post" });
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? "Edit Service" : "Add Service"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={labelStyle}>Service Name</label>
          <input
            style={inputStyle}
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="e.g. DJ Set, Live Performance"
            autoFocus
          />
        </div>
        <div>
          <label style={labelStyle}>Terms / Description</label>
          <textarea
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Describe what's included…"
          />
        </div>

        {!isInstant && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>
            <input
              type="checkbox"
              checked={priceOnRequest}
              onChange={(e) => setPriceOnRequest(e.target.checked)}
            />
            Price on request
          </label>
        )}

        {!priceOnRequest && !isInstant && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 10 }}>
              <div>
                <label style={labelStyle}>Min Price</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={form.price_min}
                  onChange={(e) => setForm((f) => ({ ...f, price_min: e.target.value }))}
                  placeholder="500"
                />
              </div>
              <div>
                <label style={labelStyle}>Max Price</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={form.price_max}
                  onChange={(e) => setForm((f) => ({ ...f, price_max: e.target.value }))}
                  placeholder="2000"
                />
              </div>
              <div>
                <label style={labelStyle}>Currency</label>
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
            <div>
              <label style={labelStyle}>Price Unit</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {([ { value: "flat", label: "Flat" }, { value: "hour", label: "Per Hour" }, { value: "day", label: "Per Day" }, { value: "unit", label: "Per Unit" } ] as const).map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, price_unit: value }))}
                    style={{
                      padding: "5px 14px",
                      borderRadius: 20,
                      border: form.price_unit === value ? `1.5px solid ${ACCENT}` : "1px solid var(--border)",
                      background: form.price_unit === value ? "rgba(245,166,35,0.1)" : "transparent",
                      color: form.price_unit === value ? ACCENT : "var(--text-muted)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: FONT_BODY,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: isPremium ? "var(--text)" : "var(--text-muted)", fontFamily: FONT_BODY }}>
              Instant Booking
            </span>
            {!isPremium && (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 8px",
                borderRadius: 20,
                background: "rgba(245,166,35,0.12)",
                color: ACCENT,
                fontSize: 11,
                fontWeight: 700,
                cursor: "default",
                fontFamily: FONT_BODY,
                letterSpacing: "0.03em",
              }}>
                Creator Plan
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => isPremium && setIsInstant((v) => !v)}
            aria-pressed={isInstant}
            style={{
              width: 42,
              height: 24,
              borderRadius: 12,
              border: "none",
              background: isInstant ? ACCENT : "var(--border)",
              cursor: isPremium ? "pointer" : "not-allowed",
              position: "relative",
              transition: "background 0.15s",
              opacity: isPremium ? 1 : 0.45,
              flexShrink: 0,
            }}
          >
            <span style={{
              position: "absolute",
              top: 3,
              left: isInstant ? 21 : 3,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.15s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
            }} />
          </button>
        </div>

        {isInstant && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 10 }}>
              <div>
                <label style={labelStyle}>Fixed Price</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={form.instant_price}
                  onChange={(e) => setForm((f) => ({ ...f, instant_price: e.target.value }))}
                  placeholder="150"
                  autoFocus
                />
              </div>
              <div>
                <label style={labelStyle}>Currency</label>
                <select
                  style={{ ...inputStyle }}
                  value={form.instant_currency}
                  onChange={(e) => setForm((f) => ({ ...f, instant_currency: e.target.value }))}
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Tax Rate %</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                style={inputStyle}
                value={form.instant_tax_rate}
                onChange={(e) => setForm((f) => ({ ...f, instant_tax_rate: e.target.value }))}
                placeholder="e.g. 19 for German USt"
              />
            </div>
          </>
        )}

        <button
          onClick={handleSubmit}
          disabled={fetcher.state !== "idle"}
          style={{ ...saveBtn, marginTop: 4, alignSelf: "flex-start" }}
        >
          {fetcher.state !== "idle" ? "Saving…" : editing ? "Save Changes" : "Add Service"}
        </button>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ServicePage() {
  const { profile, services: initialServices } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    services: Service[];
  };
  const [searchParams] = useSearchParams();

  const serviceFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const activeFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const businessFetcher = useFetcher();
  const eInvoiceFetcher = useFetcher();

  const [services, setServices] = useState<Service[]>(initialServices);
  const [serviceModal, setServiceModal] = useState<{ open: boolean; editing: Service | null }>({
    open: false,
    editing: null,
  });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [selectedLegalForm, setSelectedLegalForm] = useState<string>((profile.legal_form as string) ?? "");

  // Keep local state in sync when loader re-runs (after add/delete/edit)
  useEffect(() => {
    setServices(initialServices);
  }, [initialServices]);

  // Revert optimistic toggle on error
  useEffect(() => {
    if (activeFetcher.state !== "idle") return;
    const data = activeFetcher.data as { ok?: boolean; error?: string } | undefined;
    if (!data) return;
    if (!data.ok) {
      setServices(initialServices); // revert
      setToggleError(data.error ?? "Failed to update");
      const t = setTimeout(() => setToggleError(null), 2500);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFetcher.state, activeFetcher.data]);

  const planId = profile.plan_id as number | null | undefined;
  const isPremium = !!planId && planId > 0;
  const hasPaidPlan = isPremium;
  const hasOneTimeEInvoiceUnlock = !!(profile.e_invoice_unlocked_at as string | null);
  const hasEInvoiceAccess = hasPaidPlan || hasOneTimeEInvoiceUnlock;
  const eInvoiceEnabled = hasEInvoiceAccess && !!(profile.e_invoice_enabled as boolean | null);
  const businessFilled = [profile.company_name, profile.responsible_person, profile.vat_id].some(Boolean) ? 1 : 0;
  const eInvoiceStatus = searchParams.get("einvoice");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = services.findIndex((s) => s.id === active.id);
    const newIndex = services.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(services, oldIndex, newIndex);

    // Optimistic update
    setServices(reordered);

    // Persist new order
    const order = reordered.map((s, i) => ({ id: s.id, sort_order: i }));
    const fd = new FormData();
    fd.append("intent", "reorder_services");
    fd.append("order", JSON.stringify(order));
    reorderFetcher.submit(fd, { method: "post" });
  }

  const lf = selectedLegalForm.trim();
  const isPartnership = ["GbR", "Partnerschaft"].includes(lf);
  const isGmbH = ["GmbH", "UG (haftungsbeschränkt)", "AG"].includes(lf);
  const isIntlLtd = ["Ltd.", "S.L.", "SAS", "B.V."].includes(lf);
  const isLatAm = ["S.A.S. (Colombia)", "S.A. (Latin America)", "Ltda. (Latin America)", "S.A. de C.V. (México)", "S. de R.L. de C.V. (México)", "MEI / Ltda. (Brasil)", "SpA (Chile)"].includes(lf);
  const isUS = ["LLC (Limited Liability Company)", "C-Corp", "S-Corp", "Sole Proprietor (US)", "Partnership (US)"].includes(lf);
  const isUSCorp = ["C-Corp", "S-Corp"].includes(lf);
  const isOther = lf === "Other";
  const hasForm = !!lf;

  const showCompanyName = isPartnership || isGmbH || isIntlLtd || isLatAm || isUS || isOther;
  const showCompanyAddress = isPartnership || isGmbH || isIntlLtd || isLatAm || isUS || isOther;
  const showResponsiblePerson = hasForm;
  const showVat = hasForm;
  const showTradeRegister = isGmbH || isOther;
  const showStateOfIncorporation = isUSCorp;
  const showRegulatoryBody = isOther;
  const showDpo = hasForm;
  const showExternalPrivacy = hasForm;

  const vatLabel = isUS ? "EIN (Employer Identification Number)" : "VAT ID";
  const vatPlaceholder = isUS ? "e.g. 12-3456789" : isLatAm ? "e.g. NIT 900.123.456-7" : "e.g. DE123456789";
  const responsiblePersonLabel = isUS ? "Responsible Person / Registered Agent" : "Responsible Person";
  const companyAddressLabel = isUS ? "Company Address (US)" : "Company Address";
  const businessCountry = normalizeCountryValue(
    (profile.company_country as string | null) ||
    (profile.location_iso as string | null)
  );
  const invoiceCountry =
    businessCountry ||
    normalizeCountryValue(
      (profile.company_address as string | null)?.split(",").map((part) => part.trim()).filter(Boolean).pop() ?? null
    );
  const invoicingChecks = [
    { label: "Company or issuer name", done: !!((profile.company_name as string | null) || (profile.name as string | null)) },
    { label: "Legal form", done: !!(profile.legal_form as string | null) },
    { label: "Company address", done: !!(profile.company_address as string | null) },
    { label: "Issuer country", done: !!invoiceCountry },
    { label: "VAT / tax identifier", done: !!(profile.vat_id as string | null) },
  ];
  const invoicingReady = invoicingChecks.every((item) => item.done);

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Business</h1>

      {eInvoiceStatus === "unlocked" && (
        <div style={{
          background: "rgba(74,222,128,0.12)",
          border: "1px solid rgba(74,222,128,0.35)",
          borderRadius: 12,
          padding: "12px 16px",
          marginBottom: 18,
          color: "#4ade80",
          fontSize: 13,
          fontWeight: 600,
          fontFamily: FONT_BODY,
        }}>
          E-invoicing is now unlocked for this account. You can turn it on below.
        </div>
      )}

      {eInvoiceStatus === "cancelled" && (
        <div style={{
          background: "rgba(245,166,35,0.08)",
          border: "1px solid rgba(245,166,35,0.25)",
          borderRadius: 12,
          padding: "12px 16px",
          marginBottom: 18,
          color: "var(--text-muted)",
          fontSize: 13,
          fontFamily: FONT_BODY,
        }}>
          E-invoice activation was cancelled. Standard PDF invoices are still available.
        </div>
      )}

      {toggleError && (
        <div style={{
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 10,
          padding: "10px 16px",
          marginBottom: 16,
          fontSize: 13,
          color: "#f87171",
        }}>
          {toggleError}
        </div>
      )}

      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 18 }}>Services</h2>

        {services.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No services added yet.</p>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={services.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                {services.map((service) => (
                  <SortableServiceRow
                    key={service.id}
                    service={service}
                    onEdit={() => setServiceModal({ open: true, editing: service })}
                    onDelete={() => {
                      const fd = new FormData();
                      fd.append("intent", "delete_service");
                      fd.append("id", service.id);
                      deleteFetcher.submit(fd, { method: "post" });
                    }}
                    onToggleActive={() => {
                      // Optimistic update
                      setServices(prev => prev.map(s => s.id === service.id ? { ...s, is_active: !service.is_active } : s));
                      const fd = new FormData();
                      fd.append("intent", "toggle_service_active");
                      fd.append("id", service.id);
                      fd.append("is_active", String(!service.is_active));
                      activeFetcher.submit(fd, { method: "post" });
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}

        <button
          onClick={() => setServiceModal({ open: true, editing: null })}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          + Add Service
        </button>
      </div>

      <div style={card}>
        <CompletionBadge filled={businessFilled} total={1} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Business Details</h2>
        <businessFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_business" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={labelStyle}>Legal Form</label>
              <select
                name="legal_form"
                value={selectedLegalForm}
                onChange={(e) => setSelectedLegalForm(e.target.value)}
                style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer" }}
              >
                <option value="">— Select legal form —</option>
                <optgroup label="Individual">
                  <option>Freelancer / Selbstständig</option>
                  <option>Sole Trader</option>
                </optgroup>
                <optgroup label="Partnership">
                  <option>GbR</option>
                  <option>Partnerschaft</option>
                </optgroup>
                <optgroup label="Limited Company">
                  <option>GmbH</option>
                  <option>UG (haftungsbeschränkt)</option>
                  <option>AG</option>
                  <option>Ltd.</option>
                  <option>S.L.</option>
                  <option>SAS</option>
                  <option>B.V.</option>
                </optgroup>
                <optgroup label="United States">
                  <option>LLC (Limited Liability Company)</option>
                  <option>C-Corp</option>
                  <option>S-Corp</option>
                  <option>Sole Proprietor (US)</option>
                  <option>Partnership (US)</option>
                </optgroup>
                <optgroup label="Latin America">
                  <option>S.A.S. (Colombia)</option>
                  <option>S.A. (Latin America)</option>
                  <option>Ltda. (Latin America)</option>
                  <option>S.A. de C.V. (México)</option>
                  <option>S. de R.L. de C.V. (México)</option>
                  <option>MEI / Ltda. (Brasil)</option>
                  <option>SpA (Chile)</option>
                </optgroup>
                <optgroup label="Other">
                  <option>Other</option>
                </optgroup>
              </select>
            </div>

            {showCompanyName && (
              <div>
                <label style={labelStyle}>Company Name</label>
                <input name="company_name" defaultValue={(profile.company_name as string) ?? ""} style={inputStyle} />
              </div>
            )}

            {showCompanyAddress ? (
              <>
                <div>
                  <label style={labelStyle}>{companyAddressLabel}</label>
                  <input name="company_address" defaultValue={(profile.company_address as string) ?? ""} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Company Country</label>
                  <select
                    name="company_country"
                    defaultValue={businessCountry}
                    style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer" }}
                  >
                    <option value="">— Select country —</option>
                    {COUNTRY_OPTIONS.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : !hasForm ? (
              <>
                <div>
                  <label style={labelStyle}>Company Name</label>
                  <input name="company_name" defaultValue={(profile.company_name as string) ?? ""} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Company Address</label>
                  <input name="company_address" defaultValue={(profile.company_address as string) ?? ""} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Company Country</label>
                  <select
                    name="company_country"
                    defaultValue={businessCountry}
                    style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer" }}
                  >
                    <option value="">— Select country —</option>
                    {COUNTRY_OPTIONS.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}

            {!showCompanyName && hasForm && (
              <input type="hidden" name="company_name" value={(profile.company_name as string) ?? ""} />
            )}
            {showCompanyAddress === false && hasForm && (
              <input type="hidden" name="company_address" value={(profile.company_address as string) ?? ""} />
            )}
            {showCompanyAddress === false && hasForm && (
              <input type="hidden" name="company_country" value={businessCountry} />
            )}

            {hasForm && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 16 }}>
                <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", margin: "0 0 6px", fontFamily: FONT_BODY }}>
                  Legal &amp; Compliance
                </p>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6, fontFamily: FONT_BODY }}>
                  Shown in the legal footer on your profile page.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {showResponsiblePerson && (
                    <div>
                      <label style={labelStyle}>{responsiblePersonLabel}</label>
                      <input name="responsible_person" defaultValue={(profile.responsible_person as string) ?? ""} placeholder="Full legal name" style={inputStyle} />
                    </div>
                  )}
                  {showVat && (
                    <div>
                      <label style={labelStyle}>{vatLabel}</label>
                      <input name="vat_id" defaultValue={(profile.vat_id as string) ?? ""} placeholder={vatPlaceholder} style={inputStyle} />
                    </div>
                  )}
                  {showStateOfIncorporation && (
                    <div>
                      <label style={labelStyle}>State of Incorporation</label>
                      <input name="trade_register_court" defaultValue={(profile.trade_register_court as string) ?? ""} placeholder="e.g. Delaware, Wyoming" style={inputStyle} />
                      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0", fontFamily: FONT_BODY }}>
                        Stored as "Registered in: [state]" in the legal footer.
                      </p>
                    </div>
                  )}
                  {showTradeRegister && (
                    <>
                      <div>
                        <label style={labelStyle}>Trade Register Court</label>
                        <input name="trade_register_court" defaultValue={(profile.trade_register_court as string) ?? ""} placeholder="e.g. Amtsgericht Mannheim" style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Trade Register Number</label>
                        <input name="trade_register_number" defaultValue={(profile.trade_register_number as string) ?? ""} placeholder="e.g. HRB 12345" style={inputStyle} />
                      </div>
                    </>
                  )}
                  {showRegulatoryBody && (
                    <div>
                      <label style={labelStyle}>Professional Regulatory Body</label>
                      <input name="regulatory_body" defaultValue={(profile.regulatory_body as string) ?? ""} style={inputStyle} />
                    </div>
                  )}
                  {showDpo && (
                    <div>
                      <label style={labelStyle}>Data Protection Officer Email</label>
                      <input type="email" name="dpo_email" defaultValue={(profile.dpo_email as string) ?? ""} placeholder="datenschutz@example.com" style={inputStyle} />
                    </div>
                  )}
                  {showExternalPrivacy && (
                    <div>
                      <label style={labelStyle}>External Privacy Policy URL</label>
                      <input type="url" name="external_privacy_url" defaultValue={(profile.external_privacy_url as string) ?? ""} placeholder="https://..." style={inputStyle} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {businessFetcher.data?.error && (
            <p style={{ color: "#ef4444", fontSize: 12, margin: "10px 0 0" }}>{(businessFetcher.data as { error?: string }).error}</p>
          )}
          <button type="submit" style={saveBtn} disabled={businessFetcher.state !== "idle"}>
            {businessFetcher.state !== "idle" ? "Saving…" : "Save"}
          </button>
        </businessFetcher.Form>
      </div>

      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Invoicing</h2>

        <div style={{ ...subtleCard, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <p style={{ ...labelStyle, marginBottom: 8 }}>Invoice Mode</p>
              <p style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, margin: "0 0 6px", fontFamily: FONT_BODY }}>
                E-invoices
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, margin: 0, fontFamily: FONT_BODY, maxWidth: 620 }}>
                Standard PDF invoice creation is available to all users. Structured e-invoices are optional and affect future invoices only.
              </p>
            </div>
            <div style={{ flexShrink: 0, textAlign: "right" }}>
              {hasEInvoiceAccess ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const fd = new FormData();
                      fd.append("intent", "toggle_e_invoice_enabled");
                      fd.append("enabled", String(!eInvoiceEnabled));
                      eInvoiceFetcher.submit(fd, { method: "post" });
                    }}
                    disabled={eInvoiceFetcher.state !== "idle"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      cursor: eInvoiceFetcher.state !== "idle" ? "not-allowed" : "pointer",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: eInvoiceEnabled ? ACCENT : "var(--text-muted)", fontFamily: FONT_BODY }}>
                      {eInvoiceEnabled ? "On" : "Off"}
                    </span>
                    <span style={{
                      width: 36,
                      height: 20,
                      borderRadius: 999,
                      background: eInvoiceEnabled ? ACCENT : "var(--surface-muted)",
                      position: "relative",
                      display: "inline-block",
                    }}>
                      <span style={{
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: eInvoiceEnabled ? "#111" : "var(--text-muted)",
                        position: "absolute",
                        top: 3,
                        left: eInvoiceEnabled ? 19 : 3,
                      }} />
                    </span>
                  </button>
                  <p style={{ fontSize: 11, color: ACCENT, margin: "8px 0 0", fontFamily: FONT_BODY, fontWeight: 700 }}>
                    {hasPaidPlan ? "Included in your plan" : "Unlocked with one-time activation"}
                  </p>
                </>
              ) : (
                <>
                  <div style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    opacity: 0.75,
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", fontFamily: FONT_BODY }}>
                      Off
                    </span>
                    <span style={{
                      width: 36,
                      height: 20,
                      borderRadius: 999,
                      background: "var(--surface-muted)",
                      position: "relative",
                      display: "inline-block",
                    }}>
                      <span style={{
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: "var(--text-muted)",
                        position: "absolute",
                        top: 3,
                        left: 3,
                      }} />
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: ACCENT, margin: "8px 0 0", fontFamily: FONT_BODY, fontWeight: 700 }}>
                    One-time activation available
                  </p>
                </>
              )}
            </div>
          </div>
          {!hasEInvoiceAccess && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
              <p style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, margin: "0 0 6px", fontFamily: FONT_BODY }}>
                Unlock e-invoicing for $25 one time
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, margin: "0 0 10px", fontFamily: FONT_BODY }}>
                No subscription required. Standard PDF invoices remain available even if you stay on the free plan.
              </p>
              <form method="post" action="/api/invoicing/activate">
                <button
                  type="submit"
                  style={{
                    padding: "10px 16px",
                    background: ACCENT,
                    color: "#111",
                    border: "none",
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                  }}
                >
                  Unlock e-invoices
                </button>
              </form>
            </div>
          )}
        </div>

        <div style={{ ...subtleCard, marginBottom: 14 }}>
          <p style={{ ...labelStyle, marginBottom: 10 }}>Activation Readiness</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {invoicingChecks.map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: "var(--text)", fontSize: 13, fontFamily: FONT_BODY }}>{item.label}</span>
                <span style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: item.done ? "#4ade80" : "var(--text-muted)",
                  background: item.done ? "rgba(74,222,128,0.12)" : "var(--surface-muted)",
                  borderRadius: 999,
                  padding: "3px 10px",
                  fontFamily: FONT_BODY,
                }}>
                  {item.done ? "Ready" : "Missing"}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: invoicingReady ? "#4ade80" : "var(--text-muted)", margin: "12px 0 0", fontFamily: FONT_BODY }}>
            {invoicingReady
              ? "Your current business details are sufficient for enabling e-invoices once the feature is activated."
              : "Complete the missing issuer details first. E-invoicing should only be enabled once your company data is legally complete."}
          </p>
        </div>

        <div style={subtleCard}>
          <p style={{ ...labelStyle, marginBottom: 10 }}>Compliance Notes</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, margin: 0, fontFamily: FONT_BODY }}>
              Changing invoice mode should affect future invoices only and must not rewrite or renumber previously issued invoices.
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, margin: 0, fontFamily: FONT_BODY }}>
              If you later turn e-invoicing back on, numbering should continue in the same sequence. SQRZ helps generate documents, but you remain responsible for compliance with your local invoicing rules.
            </p>
          </div>
        </div>
      </div>

      <ServiceModal
        isOpen={serviceModal.open}
        onClose={() => setServiceModal({ open: false, editing: null })}
        editing={serviceModal.editing}
        fetcher={serviceFetcher}
        isPremium={isPremium}
      />
    </div>
  );
}
