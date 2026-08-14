import { useEffect, useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
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

  // Full country list for the business-location dropdown — sourced from the
  // locations table (all countries, ordered by name), not a hardcoded array.
  const { data: locationRows } = await adminClient
    .from("locations")
    .select("name")
    .order("name", { ascending: true });
  const countries = (locationRows ?? [])
    .map((r) => r.name as string | null)
    .filter((n): n is string => !!n);

  // Shopping — up to 4 products for the shopify/gumroad shop_provider modes
  // (beatstars_url covers the beatstars mode instead). RLS on shop_products
  // correctly joins profiles.user_id (unlike profile_services' owner policy),
  // so the RLS-scoped client works fine here, no admin client needed.
  const { data: shopProducts } = await supabase
    .from("shop_products")
    .select("id, title, image_url, price, currency, buy_url, position")
    .eq("profile_id", profile.id as string)
    .order("position", { ascending: true });

  return Response.json(
    {
      profile,
      services: services ?? [],
      countries,
      shopProducts: shopProducts ?? [],
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
    // Services are quote/request only. Price fields are display-only (shown on the
    // public profile service card) — they are not connected to any checkout flow.
    const priceOnRequest = formData.get("price_on_request") === "true";
    const { error } = await adminClient.from("profile_services").insert({
      profile_id: profile.id as string,
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: priceOnRequest ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: priceOnRequest ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: priceOnRequest ? null : ((formData.get("currency") as string) || "EUR"),
      price_unit: priceOnRequest ? null : ((formData.get("price_unit") as string) || "flat"),
      booking_type: "quote",
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

  if (intent === "update_service") {
    const id = formData.get("id") as string;
    // Price fields are display-only (public profile service card) — no checkout flow.
    const priceOnRequest = formData.get("price_on_request") === "true";
    const { error } = await adminClient.from("profile_services").update({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      price_min: priceOnRequest ? null : (parseFloat(formData.get("price_min") as string) || null),
      price_max: priceOnRequest ? null : (parseFloat(formData.get("price_max") as string) || null),
      price_label: priceOnRequest ? "Price on request" : ((formData.get("price_label") as string) || null),
      currency: priceOnRequest ? null : ((formData.get("currency") as string) || "EUR"),
      price_unit: priceOnRequest ? null : ((formData.get("price_unit") as string) || "flat"),
      booking_type: "quote",
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_service") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_services").delete().eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  // ── Scheduling & Reservations (Calendly/HubSpot get real integrations on
  // sqrz-profiles; every other provider link-outs. scheduling_provider stays a
  // free string, not an enum, so adding another provider is just a dropdown
  // option, no migration) ──────────────
  if (intent === "update_scheduling") {
    const url = ((formData.get("scheduling_url") as string) || "").trim();
    // Clearing the URL clears the provider too — mirrors how the widget fields
    // on Profile go back to "unset" the moment their value is emptied, and is
    // what makes sqrz-profiles' SchedulingWidget stop rendering.
    const provider = url ? ((formData.get("scheduling_provider") as string) || "calendly") : null;
    const { error } = await supabase.from("profiles").update({
      scheduling_provider: provider,
      scheduling_url: url || null,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  // ── Shopping (profiles.shop_provider: null|'beatstars'|'shopify'|'gumroad',
  // DB CHECK constraint — matches the picker's allowed values 1:1) ──────────
  // Mirrors sqrz-ios's BusinessView: one provider select + conditional
  // content — beatstars_url for "beatstars" (holds the artist's BeatStars
  // *player embed* URL, see the field's own hint text below), up to 4
  // shop_products rows for "shopify"/"gumroad". Switching providers never
  // deletes the other mode's data (beatstars_url / shop_products just sit
  // unused), matching iOS.
  if (intent === "update_shop") {
    const provider = ((formData.get("shop_provider") as string) || "") || null;
    const update: Record<string, unknown> = { shop_provider: provider };
    if (provider === "beatstars") {
      update.beatstars_url = ((formData.get("beatstars_url") as string) || "").trim() || null;
    }
    const { error } = await supabase.from("profiles").update(update).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "add_shop_product") {
    const title = (formData.get("title") as string)?.trim();
    const buyUrl = (formData.get("buy_url") as string)?.trim();
    if (!title || !buyUrl) {
      return Response.json({ ok: false, error: "Title and Buy URL are required" }, { headers });
    }
    const { count } = await supabase
      .from("shop_products")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profile.id as string);
    const { error } = await supabase.from("shop_products").insert({
      profile_id: profile.id as string,
      title,
      image_url: (formData.get("image_url") as string)?.trim() || null,
      price: parseFloat(formData.get("price") as string) || null,
      currency: (formData.get("currency") as string)?.trim() || "USD",
      buy_url: buyUrl,
      position: count ?? 0,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_shop_product") {
    const id = formData.get("id") as string;
    const title = (formData.get("title") as string)?.trim();
    const buyUrl = (formData.get("buy_url") as string)?.trim();
    if (!title || !buyUrl) {
      return Response.json({ ok: false, error: "Title and Buy URL are required" }, { headers });
    }
    const { error } = await supabase.from("shop_products").update({
      title,
      image_url: (formData.get("image_url") as string)?.trim() || null,
      price: parseFloat(formData.get("price") as string) || null,
      currency: (formData.get("currency") as string)?.trim() || "USD",
      buy_url: buyUrl,
    }).eq("id", id).eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_shop_product") {
    const id = formData.get("id") as string;
    const { error } = await supabase.from("shop_products").delete().eq("id", id).eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

type ShopProduct = {
  id: string;
  title: string;
  image_url: string | null;
  price: number | null;
  currency: string | null;
  buy_url: string;
  position: number;
};

const MAX_SHOP_PRODUCTS = 4;

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
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: Service | null;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [priceOnRequest, setPriceOnRequest] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    price_min: "",
    price_max: "",
    price_label: "",
    currency: "EUR",
    price_unit: "flat",
  });

  useEffect(() => {
    if (editing) {
      const onRequest = editing.price_label === "Price on request";
      setPriceOnRequest(onRequest);
      setForm({
        title: editing.title ?? "",
        description: editing.description ?? "",
        price_min: String(editing.price_min ?? ""),
        price_max: String(editing.price_max ?? ""),
        // "Price on request" is a sentinel set by the toggle — keep the free-text
        // label field empty in that case so it isn't shown back as a custom label.
        price_label: onRequest ? "" : (editing.price_label ?? ""),
        currency: editing.currency ?? "EUR",
        price_unit: editing.price_unit ?? "flat",
      });
    } else {
      setPriceOnRequest(false);
      setForm({ title: "", description: "", price_min: "", price_max: "", price_label: "", currency: "EUR", price_unit: "flat" });
    }
  }, [editing, isOpen]);

  function handleSubmit() {
    if (!form.title.trim()) return;
    const fd = new FormData();
    fd.append("intent", editing ? "update_service" : "add_service");
    if (editing) fd.append("id", editing.id);
    fd.append("title", form.title);
    fd.append("description", form.description);
    fd.append("price_on_request", String(priceOnRequest));
    if (!priceOnRequest) {
      fd.append("price_min", form.price_min);
      fd.append("price_max", form.price_max);
      fd.append("price_label", form.price_label);
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

        {/* Pricing — display only (shown on the public profile service card; not a checkout) */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>
          <input
            type="checkbox"
            checked={priceOnRequest}
            onChange={(e) => setPriceOnRequest(e.target.checked)}
          />
          Price on request
        </label>

        {!priceOnRequest && (
          <>
            <div>
              <label style={labelStyle}>Price Label <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span></label>
              <input
                style={inputStyle}
                value={form.price_label}
                onChange={(e) => setForm((f) => ({ ...f, price_label: e.target.value }))}
                placeholder="e.g. from €500"
              />
            </div>
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

// ── ShopProductModal — up to 4 cards for shopify/gumroad, mirrors iOS's
// shopProductsEditor field set (title, image URL, price, currency, buy URL) ──

function ShopProductModal({
  isOpen,
  onClose,
  editing,
  fetcher,
}: {
  isOpen: boolean;
  onClose: () => void;
  editing: ShopProduct | null;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [form, setForm] = useState({ title: "", image_url: "", price: "", currency: "USD", buy_url: "" });

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title ?? "",
        image_url: editing.image_url ?? "",
        price: editing.price != null ? String(editing.price) : "",
        currency: editing.currency ?? "USD",
        buy_url: editing.buy_url ?? "",
      });
    } else {
      setForm({ title: "", image_url: "", price: "", currency: "USD", buy_url: "" });
    }
  }, [editing, isOpen]);

  function handleSubmit() {
    if (!form.title.trim() || !form.buy_url.trim()) return;
    const fd = new FormData();
    fd.append("intent", editing ? "update_shop_product" : "add_shop_product");
    if (editing) fd.append("id", editing.id);
    fd.append("title", form.title);
    fd.append("image_url", form.image_url);
    fd.append("price", form.price);
    fd.append("currency", form.currency || "USD");
    fd.append("buy_url", form.buy_url);
    fetcher.submit(fd, { method: "post" });
    onClose();
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? "Edit Product" : "Add Product"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={labelStyle}>Title</label>
          <input
            style={inputStyle}
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Product name"
            autoFocus
          />
        </div>
        <div>
          <label style={labelStyle}>Image URL</label>
          <input
            style={inputStyle}
            value={form.image_url}
            onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
            placeholder="https://…"
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10 }}>
          <div>
            <label style={labelStyle}>Price</label>
            <input
              type="number"
              style={inputStyle}
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              placeholder="0.00"
            />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <input
              style={inputStyle}
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
              placeholder="USD"
              maxLength={3}
            />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Buy URL</label>
          <input
            style={inputStyle}
            value={form.buy_url}
            onChange={(e) => setForm((f) => ({ ...f, buy_url: e.target.value }))}
            placeholder="https://…"
          />
        </div>

        {(fetcher.data as { error?: string } | undefined)?.error && (
          <p style={{ fontSize: 13, color: "#ef4444" }}>{(fetcher.data as { error: string }).error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={fetcher.state !== "idle" || !form.title.trim() || !form.buy_url.trim()}
          style={{ ...saveBtn, marginTop: 4, alignSelf: "flex-start" }}
        >
          {fetcher.state !== "idle" ? "Saving…" : editing ? "Save Changes" : "Add Product"}
        </button>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ServicePage() {
  const { profile, services: initialServices, countries, shopProducts: initialShopProducts } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    services: Service[];
    countries: string[];
    shopProducts: ShopProduct[];
  };

  const serviceFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const activeFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const businessFetcher = useFetcher();
  const schedulingFetcher = useFetcher();
  const shopFetcher = useFetcher();
  const shopProductFetcher = useFetcher();
  const deleteShopProductFetcher = useFetcher();

  const [services, setServices] = useState<Service[]>(initialServices);
  const [serviceModal, setServiceModal] = useState<{ open: boolean; editing: Service | null }>({
    open: false,
    editing: null,
  });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [selectedLegalForm, setSelectedLegalForm] = useState<string>((profile.legal_form as string) ?? "");

  // Scheduling widget — click-to-expand row, same interaction pattern as the
  // music/video widget fields on the Profile page (this section has no widget
  // rows of its own yet; copied the pattern rather than inventing a new one).
  const [schedulingEditing, setSchedulingEditing] = useState(false);
  const [schedulingProvider, setSchedulingProvider] = useState((profile.scheduling_provider as string) || "calendly");
  const [schedulingUrl, setSchedulingUrl] = useState((profile.scheduling_url as string) ?? "");
  const schedulingSet = !!schedulingUrl.trim();
  const SCHEDULING_PROVIDER_LABELS: Record<string, string> = {
    calendly: "Calendly",
    hubspot: "HubSpot",
    opentable: "OpenTable",
    resy: "Resy",
    tock: "Tock",
    sevenrooms: "SevenRooms",
    eventbrite: "Eventbrite",
    dice: "Dice",
    tickettailor: "Ticket Tailor",
  };
  const SCHEDULING_URL_PLACEHOLDERS: Record<string, string> = {
    calendly: "https://calendly.com/your-handle",
    hubspot: "https://meetings.hubspot.com/your-handle",
  };

  // Shopping — one provider select + conditional content (beatstars → a
  // single embed-URL field; shopify/gumroad → a shop_products list),
  // mirroring sqrz-ios's BusinessView exactly: same field set, same
  // "switching provider doesn't delete the other mode's data" behavior.
  // Click-to-expand + Save/Cancel for the provider/URL row matches this
  // page's own Scheduling section above.
  const [shopProducts, setShopProducts] = useState<ShopProduct[]>(initialShopProducts);
  const [shopEditing, setShopEditing] = useState(false);
  const [shopProvider, setShopProvider] = useState((profile.shop_provider as string) || "");
  const [beatstarsUrl, setBeatstarsUrl] = useState((profile.beatstars_url as string) ?? "");
  const shopSet = !!shopProvider;
  const [shopProductModal, setShopProductModal] = useState<{ open: boolean; editing: ShopProduct | null }>({
    open: false,
    editing: null,
  });
  const SHOP_PROVIDER_LABELS: Record<string, string> = {
    beatstars: "BeatStars",
    shopify: "Shopify",
    gumroad: "Gumroad",
  };

  useEffect(() => {
    setShopProducts(initialShopProducts);
  }, [initialShopProducts]);

  function saveShop() {
    setShopEditing(false);
    const fd = new FormData();
    fd.append("intent", "update_shop");
    fd.append("shop_provider", shopProvider);
    if (shopProvider === "beatstars") fd.append("beatstars_url", beatstarsUrl);
    shopFetcher.submit(fd, { method: "post" });
  }

  function saveScheduling() {
    setSchedulingEditing(false);
    const fd = new FormData();
    fd.append("intent", "update_scheduling");
    fd.append("scheduling_provider", schedulingProvider);
    fd.append("scheduling_url", schedulingUrl);
    schedulingFetcher.submit(fd, { method: "post" });
  }

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

  const businessFilled = [profile.company_name, profile.responsible_person, profile.vat_id].some(Boolean) ? 1 : 0;

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

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Business</h1>

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

      {/* Scheduling & Reservations — link-out widget, same shape as the public
          BookMeButton/primaryCta.ts resolver on sqrz-profiles (already shipped,
          untouched). Calendly and HubSpot get real integrations (popup / iframe
          modal); every other provider here just link-outs to the URL. Still
          exactly one provider selectable at a time; scheduling_provider is a
          free string, not an enum, so more providers slot in later without a
          migration or a rework here. */}
      <div style={card}>
        <CompletionBadge filled={schedulingSet ? 1 : 0} total={1} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Scheduling & Reservations</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div>
            <div
              onClick={() => !schedulingEditing && setSchedulingEditing(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                cursor: schedulingEditing ? "default" : "pointer",
              }}
            >
              <span style={{ fontSize: 18, minWidth: 24 }}>📅</span>
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: schedulingSet ? ACCENT : "var(--text-muted)" }}>
                  {schedulingSet ? (SCHEDULING_PROVIDER_LABELS[schedulingProvider] ?? schedulingProvider) : "Scheduling link"}
                </span>
                {schedulingSet && !schedulingEditing && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)", display: "inline-block", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>{schedulingUrl}</span>
                )}
              </div>
              {!schedulingEditing && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{schedulingSet ? "Edit" : "Add"}</span>
              )}
            </div>
            {schedulingEditing && (
              <div style={{ padding: "10px 0 14px 34px" }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Provider</label>
                <select
                  value={schedulingProvider}
                  onChange={e => setSchedulingProvider(e.target.value)}
                  style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer", marginBottom: 10 }}
                >
                  <option value="calendly">Calendly</option>
                  <option value="hubspot">HubSpot</option>
                  <option value="opentable">OpenTable</option>
                  <option value="resy">Resy</option>
                  <option value="tock">Tock</option>
                  <option value="sevenrooms">SevenRooms</option>
                  <option value="eventbrite">Eventbrite</option>
                  <option value="dice">Dice</option>
                  <option value="tickettailor">Ticket Tailor</option>
                </select>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Link</label>
                <input
                  style={inputStyle}
                  value={schedulingUrl}
                  onChange={e => setSchedulingUrl(e.target.value)}
                  placeholder={SCHEDULING_URL_PLACEHOLDERS[schedulingProvider] ?? "https://your-scheduling-link.com"}
                  autoFocus
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    disabled={schedulingFetcher.state !== "idle"}
                    style={{ ...saveBtn, marginTop: 0, fontSize: 13, padding: "8px 16px", opacity: schedulingFetcher.state !== "idle" ? 0.6 : 1 }}
                    onClick={saveScheduling}
                  >
                    {schedulingFetcher.state !== "idle" ? "Saving…" : "Save"}
                  </button>
                  <button
                    style={{ padding: "8px 16px", background: "none", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}
                    onClick={() => {
                      setSchedulingEditing(false);
                      setSchedulingProvider((profile.scheduling_provider as string) || "calendly");
                      setSchedulingUrl((profile.scheduling_url as string) ?? "");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Shopping — profiles.shop_provider (beatstars|shopify|gumroad|null,
          matches the DB CHECK constraint exactly), the same one-provider-at-a-
          time model as sqrz-ios's Business tab. BeatStars is a single embed
          URL (beatstars_url column, holds a player.beatstars.com embed link —
          see the field's own hint); Shopify/Gumroad show a shop_products list
          (title/image/price/currency/buy URL, capped at 4 — DB-enforced). */}
      <div style={card}>
        <CompletionBadge filled={shopSet ? 1 : 0} total={1} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Shopping</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div>
            <div
              onClick={() => !shopEditing && setShopEditing(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                cursor: shopEditing ? "default" : "pointer",
              }}
            >
              <span style={{ fontSize: 18, minWidth: 24 }}>🛒</span>
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: shopSet ? ACCENT : "var(--text-muted)" }}>
                  {shopSet ? (SHOP_PROVIDER_LABELS[shopProvider] ?? shopProvider) : "Shop provider"}
                </span>
                {shopSet && !shopEditing && shopProvider === "beatstars" && beatstarsUrl && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)", display: "inline-block", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>{beatstarsUrl}</span>
                )}
              </div>
              {!shopEditing && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{shopSet ? "Edit" : "Add"}</span>
              )}
            </div>

            {shopEditing && (
              <div style={{ padding: "10px 0 14px 34px" }}>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Provider</label>
                <select
                  value={shopProvider}
                  onChange={e => setShopProvider(e.target.value)}
                  style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer", marginBottom: 10 }}
                >
                  <option value="">None</option>
                  <option value="beatstars">BeatStars</option>
                  <option value="shopify">Shopify</option>
                  <option value="gumroad">Gumroad</option>
                </select>

                {shopProvider === "beatstars" && (
                  <>
                    <label style={{ ...labelStyle, marginBottom: 6 }}>BeatStars Player URL</label>
                    <input
                      style={inputStyle}
                      value={beatstarsUrl}
                      onChange={e => setBeatstarsUrl(e.target.value)}
                      placeholder="https://player.beatstars.com/?storeId=..."
                    />
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0", fontFamily: FONT_BODY }}>
                      Not your store link — this is the embeddable player URL from BeatStars Studio → Players → Embeddable code.
                    </p>
                  </>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    disabled={shopFetcher.state !== "idle"}
                    style={{ ...saveBtn, marginTop: 0, fontSize: 13, padding: "8px 16px", opacity: shopFetcher.state !== "idle" ? 0.6 : 1 }}
                    onClick={saveShop}
                  >
                    {shopFetcher.state !== "idle" ? "Saving…" : "Save"}
                  </button>
                  <button
                    style={{ padding: "8px 16px", background: "none", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}
                    onClick={() => {
                      setShopEditing(false);
                      setShopProvider((profile.shop_provider as string) || "");
                      setBeatstarsUrl((profile.beatstars_url as string) ?? "");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Shop products — shopify/gumroad only, up to 4 */}
          {(shopProvider === "shopify" || shopProvider === "gumroad") && (
            <div style={{ marginTop: shopEditing ? 6 : 4 }}>
              {shopProducts.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "6px 0 12px" }}>No products added yet.</p>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  {shopProducts.map((product, i) => (
                    <div
                      key={product.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "10px 0",
                        borderBottom: i < shopProducts.length - 1 ? "1px solid var(--border)" : "none",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {product.title}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                          {product.price != null ? `${(product.currency ?? "USD").toUpperCase()} ${product.price}` : "No price set"}
                        </div>
                      </div>
                      <MenuDots
                        onEdit={() => setShopProductModal({ open: true, editing: product })}
                        onDelete={() => {
                          setShopProducts(prev => prev.filter(p => p.id !== product.id));
                          const fd = new FormData();
                          fd.append("intent", "delete_shop_product");
                          fd.append("id", product.id);
                          deleteShopProductFetcher.submit(fd, { method: "post" });
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={() => setShopProductModal({ open: true, editing: null })}
                disabled={shopProducts.length >= MAX_SHOP_PRODUCTS}
                style={{
                  background: "none",
                  border: `1px solid rgba(245,166,35,0.4)`,
                  color: ACCENT,
                  borderRadius: 10,
                  padding: "9px 18px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: shopProducts.length >= MAX_SHOP_PRODUCTS ? "not-allowed" : "pointer",
                  fontFamily: FONT_BODY,
                  opacity: shopProducts.length >= MAX_SHOP_PRODUCTS ? 0.5 : 1,
                }}
              >
                {shopProducts.length >= MAX_SHOP_PRODUCTS ? "Max 4 products" : "+ Add Product"}
              </button>
            </div>
          )}
        </div>
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
                    {countries.map((country) => (
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
                    {countries.map((country) => (
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

      <ServiceModal
        isOpen={serviceModal.open}
        onClose={() => setServiceModal({ open: false, editing: null })}
        editing={serviceModal.editing}
        fetcher={serviceFetcher}
      />

      <ShopProductModal
        isOpen={shopProductModal.open}
        onClose={() => setShopProductModal({ open: false, editing: null })}
        editing={shopProductModal.editing}
        fetcher={shopProductFetcher}
      />
    </div>
  );
}
