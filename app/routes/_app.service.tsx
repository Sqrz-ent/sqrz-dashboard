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
      booking_type: bookingType,
      instant_price: isInstant ? (parseFloat(formData.get("instant_price") as string) || null) : null,
      instant_currency: isInstant ? ((formData.get("instant_currency") as string) || "EUR") : null,
      is_active: true,
      sort_order: 0,
    });
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
      booking_type: bookingType,
      instant_price: isInstant ? (parseFloat(formData.get("instant_price") as string) || null) : null,
      instant_currency: isInstant ? ((formData.get("instant_currency") as string) || "EUR") : null,
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
  currency: string | null;
  is_active: boolean;
  sort_order: number;
  booking_type: "instant" | "quote";
  instant_price: number | null;
  instant_currency: string | null;
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
    instant_price: "",
    instant_currency: "EUR",
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
        instant_price: String(editing.instant_price ?? ""),
        instant_currency: editing.instant_currency ?? "EUR",
      });
    } else {
      setIsInstant(false);
      setPriceOnRequest(false);
      setForm({ title: "", description: "", price_min: "", price_max: "", currency: "EUR", instant_price: "", instant_currency: "EUR" });
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
    } else if (!priceOnRequest) {
      fd.append("price_min", form.price_min);
      fd.append("price_max", form.price_max);
      fd.append("currency", form.currency);
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
        )}

        <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: isPremium ? "var(--text)" : "var(--text-muted)", fontFamily: FONT_BODY }}>
              Instant Booking
            </span>
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase" as const,
              padding: "2px 7px",
              borderRadius: 20,
              border: isPremium ? `1px solid rgba(245,166,35,0.5)` : "1px solid var(--border)",
              color: isPremium ? ACCENT : "var(--text-muted)",
              background: isPremium ? "rgba(245,166,35,0.08)" : "transparent",
              fontFamily: FONT_BODY,
            }}>
              Premium
            </span>
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

        {!isPremium && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "-4px 0 0", fontFamily: FONT_BODY }}>
            Upgrade to a paid plan to enable instant booking.
          </p>
        )}

        {isInstant && (
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

  const serviceFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const activeFetcher = useFetcher();
  const reorderFetcher = useFetcher();

  const [services, setServices] = useState<Service[]>(initialServices);
  const [serviceModal, setServiceModal] = useState<{ open: boolean; editing: Service | null }>({
    open: false,
    editing: null,
  });

  // Keep local state in sync when loader re-runs (after add/delete/edit)
  useEffect(() => {
    setServices(initialServices);
  }, [initialServices]);

  const planId = profile.plan_id as number | null | undefined;
  const isPremium = !!planId && planId > 0;

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

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Services</h1>

      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 18 }}>Your Services</h2>

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
