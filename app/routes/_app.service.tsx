import { useEffect, useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import type { Route } from "./+types/_app.service";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { normalizeTaxPresets, type TaxPreset } from "~/lib/tax-presets";
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

// ── Credentials ───────────────────────────────────────────────────────────────

const CREDENTIAL_TYPES = [
  { value: "passport", label: "Passport" },
  { value: "seafarer_id", label: "Seafarer ID" },
  { value: "stcw_certificate", label: "STCW Certificate" },
  { value: "work_permit", label: "Work Permit" },
  { value: "insurance", label: "Insurance" },
  { value: "driving_license", label: "Driving License" },
  { value: "health_certificate", label: "Health Certificate" },
  { value: "certification", label: "Certifications" },
  { value: "other", label: "Other" },
] as const;

type Credential = {
  id: string;
  profile_id: string;
  type: string;
  status: "self_declared" | "upload_requested" | "uploaded" | "verified" | "expired";
  summary_text: string | null;
  issuer: string | null;
  issuer_country: string | null;
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  visibility: "private" | "shared";
  upload_enabled: boolean;
  upload_context: string | null;
  file_url: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  created_at: string;
};

const CRED_STATUS_MAP: Record<string, { label: string; color: string; bg: string; border: string }> = {
  self_declared:    { label: "Declared",         color: "#F5A623",  bg: "rgba(245,166,35,0.15)",  border: "#F5A623" },
  upload_requested: { label: "Upload Requested",  color: "#60a5fa",  bg: "rgba(59,130,246,0.12)",  border: "#60a5fa" },
  uploaded:         { label: "Uploaded",          color: "#ca8a04",  bg: "rgba(234,179,8,0.12)",   border: "#eab308" },
  verified:         { label: "Verified",          color: "#22c55e",  bg: "rgba(34,197,94,0.12)",   border: "#22c55e" },
  expired:          { label: "Expired",           color: "#f87171",  bg: "rgba(239,68,68,0.12)",   border: "#ef4444" },
};

function credPillStyle(cred: Credential | undefined): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'DM Sans', ui-sans-serif, sans-serif",
  };
  if (!cred) {
    return { ...base, border: "1.5px dashed var(--border)", background: "transparent", color: "var(--text-muted)" };
  }
  const s = CRED_STATUS_MAP[cred.status] ?? CRED_STATUS_MAP.self_declared;
  return { ...base, border: `1.5px solid ${s.border}`, background: s.bg, color: s.color };
}

function CredStatusBadge({ status }: { status: string }) {
  const s = CRED_STATUS_MAP[status] ?? CRED_STATUS_MAP.self_declared;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: s.color, background: s.bg, padding: "3px 9px", borderRadius: 20, fontFamily: "'DM Sans', ui-sans-serif, sans-serif" }}>
      {s.label}
    </span>
  );
}

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

  const isBeta = !!(profile.is_beta as boolean | null);
  const { data: credentialRows } = isBeta
    ? await adminClient.from("credential_declarations").select("*").eq("profile_id", profile.id as string).order("created_at", { ascending: false })
    : { data: [] };

  return Response.json(
    {
      profile,
      services: services ?? [],
      credentials: credentialRows ?? [],
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
    // Services are quote/request only — no instant booking, no price fields.
    const { error } = await adminClient.from("profile_services").insert({
      profile_id: profile.id as string,
      title: formData.get("title") as string,
      description: formData.get("description") as string,
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

  if (intent === "update_tax_presets") {
    // Full-array replace of profiles.tax_presets. Client sends the normalized JSON.
    let presets: unknown = [];
    try {
      presets = JSON.parse((formData.get("tax_presets") as string) || "[]");
    } catch { /* keep [] */ }
    const clean = normalizeTaxPresets(presets);
    const { error } = await supabase
      .from("profiles")
      .update({ tax_presets: clean })
      .eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message, tax_presets: clean }, { headers });
  }

  if (intent === "update_service") {
    const id = formData.get("id") as string;
    // Services are quote/request only — only title/description are editable now.
    const { error } = await adminClient.from("profile_services").update({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      booking_type: "quote",
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_service") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_services").delete().eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "add_credential") {
    const validUntil = (formData.get("valid_until") as string) || null;
    const status = validUntil && new Date(validUntil) < new Date() ? "expired" : "self_declared";
    const { error } = await adminClient.from("credential_declarations").insert({
      profile_id: profile.id as string,
      type: formData.get("type") as string,
      summary_text: (formData.get("summary_text") as string) || null,
      issuer: (formData.get("issuer") as string) || null,
      issuer_country: (formData.get("issuer_country") as string) || null,
      valid_from: (formData.get("valid_from") as string) || null,
      valid_until: validUntil,
      notes: (formData.get("notes") as string) || null,
      visibility: (formData.get("visibility") as string) || "private",
      status,
      upload_enabled: false,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_credential") {
    const id = formData.get("id") as string;
    const validUntil = (formData.get("valid_until") as string) || null;
    const status = validUntil && new Date(validUntil) < new Date() ? "expired" : "self_declared";
    const { error } = await adminClient.from("credential_declarations").update({
      type: formData.get("type") as string,
      summary_text: (formData.get("summary_text") as string) || null,
      issuer: (formData.get("issuer") as string) || null,
      issuer_country: (formData.get("issuer_country") as string) || null,
      valid_from: (formData.get("valid_from") as string) || null,
      valid_until: validUntil,
      notes: (formData.get("notes") as string) || null,
      visibility: (formData.get("visibility") as string) || "private",
      status,
    }).eq("id", id).eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_credential") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("credential_declarations").delete().eq("id", id).eq("profile_id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_credential_file") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("credential_declarations").update({
      file_url: formData.get("file_url") as string,
      file_name: formData.get("file_name") as string,
      file_size_bytes: parseInt(formData.get("file_size_bytes") as string, 10) || null,
      status: "uploaded",
    }).eq("id", id).eq("profile_id", profile.id as string);
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
  const [form, setForm] = useState({
    title: "",
    description: "",
  });

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title ?? "",
        description: editing.description ?? "",
      });
    } else {
      setForm({ title: "", description: "" });
    }
  }, [editing, isOpen]);

  function handleSubmit() {
    if (!form.title.trim()) return;
    const fd = new FormData();
    fd.append("intent", editing ? "update_service" : "add_service");
    if (editing) fd.append("id", editing.id);
    fd.append("title", form.title);
    fd.append("description", form.description);
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
  const { profile, services: initialServices, credentials: initialCredentials } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    services: Service[];
    credentials: Credential[];
  };

  const serviceFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const activeFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const businessFetcher = useFetcher();
  const credFetcher = useFetcher();
  const credDeleteFetcher = useFetcher();
  const taxPresetsFetcher = useFetcher();

  // Tax presets (profiles.tax_presets) — edited locally, saved as a full-array replace.
  const [taxPresets, setTaxPresets] = useState<TaxPreset[]>(() => normalizeTaxPresets(profile.tax_presets));
  const [newTaxLabel, setNewTaxLabel] = useState("");
  const [newTaxRate, setNewTaxRate] = useState("");
  const [newTaxDefault, setNewTaxDefault] = useState(false);

  function persistTaxPresets(next: TaxPreset[]) {
    setTaxPresets(next);
    const fd = new FormData();
    fd.append("intent", "update_tax_presets");
    fd.append("tax_presets", JSON.stringify(next));
    taxPresetsFetcher.submit(fd, { method: "post" });
  }

  function addTaxPreset() {
    const label = newTaxLabel.trim();
    const rate = parseFloat(newTaxRate);
    if (!label || isNaN(rate) || rate < 0 || rate > 100) return;
    const next = [
      ...taxPresets.map((p) => (newTaxDefault ? { ...p, is_default: false } : p)),
      { label, rate, is_default: newTaxDefault },
    ];
    persistTaxPresets(next);
    setNewTaxLabel("");
    setNewTaxRate("");
    setNewTaxDefault(false);
  }

  function deleteTaxPreset(idx: number) {
    persistTaxPresets(taxPresets.filter((_, i) => i !== idx));
  }

  function setTaxPresetDefault(idx: number) {
    persistTaxPresets(taxPresets.map((p, i) => ({ ...p, is_default: i === idx })));
  }

  const [services, setServices] = useState<Service[]>(initialServices);
  const [serviceModal, setServiceModal] = useState<{ open: boolean; editing: Service | null }>({
    open: false,
    editing: null,
  });
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [selectedLegalForm, setSelectedLegalForm] = useState<string>((profile.legal_form as string) ?? "");

  // Credentials state
  const [credentials, setCredentials] = useState<Credential[]>(initialCredentials);
  const [credFormOpen, setCredFormOpen] = useState(false);
  const [credEditing, setCredEditing] = useState<Credential | null>(null);
  const [credForm, setCredForm] = useState({
    type: "passport",
    summary_text: "",
    issuer: "",
    issuer_country: "",
    valid_from: "",
    valid_until: "",
    notes: "",
    visibility: "private",
  });
  const [uploadingCredId, setUploadingCredId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Keep local state in sync when loader re-runs (after add/delete/edit)
  useEffect(() => {
    setServices(initialServices);
  }, [initialServices]);

  useEffect(() => {
    setCredentials(initialCredentials);
  }, [initialCredentials]);

  function openCredForm(cred: Credential | null, typeOverride?: string) {
    if (cred) {
      setCredEditing(cred);
      setCredForm({
        type: cred.type,
        summary_text: cred.summary_text ?? "",
        issuer: cred.issuer ?? "",
        issuer_country: cred.issuer_country ?? "",
        valid_from: cred.valid_from ?? "",
        valid_until: cred.valid_until ?? "",
        notes: cred.notes ?? "",
        visibility: cred.visibility,
      });
    } else {
      setCredEditing(null);
      setCredForm({
        type: typeOverride ?? "passport",
        summary_text: "",
        issuer: "",
        issuer_country: "",
        valid_from: "",
        valid_until: "",
        notes: "",
        visibility: "private",
      });
    }
    setCredFormOpen(true);
  }

  function handleCredSubmit() {
    const fd = new FormData();
    fd.append("intent", credEditing ? "update_credential" : "add_credential");
    if (credEditing) fd.append("id", credEditing.id);
    fd.append("type", credForm.type);
    fd.append("summary_text", credForm.summary_text);
    fd.append("issuer", credForm.issuer);
    fd.append("issuer_country", credForm.issuer_country);
    fd.append("valid_from", credForm.valid_from);
    fd.append("valid_until", credForm.valid_until);
    fd.append("notes", credForm.notes);
    fd.append("visibility", credForm.visibility);
    credFetcher.submit(fd, { method: "post" });
    setCredFormOpen(false);
    setCredEditing(null);
  }

  async function handleFileUpload(credId: string, file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("File must be under 10MB");
      return;
    }
    setUploadingCredId(credId);
    setUploadError(null);
    try {
      const { supabase: sbClient } = await import("~/lib/supabase.client");
      const { data: { user } } = await sbClient.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const path = `${user.id}/${credId}/${file.name}`;
      const { error: storageError } = await sbClient.storage.from("credentials").upload(path, file, { upsert: true });
      if (storageError) throw storageError;
      const { data: { publicUrl } } = sbClient.storage.from("credentials").getPublicUrl(path);
      const fd = new FormData();
      fd.append("intent", "update_credential_file");
      fd.append("id", credId);
      fd.append("file_url", publicUrl);
      fd.append("file_name", file.name);
      fd.append("file_size_bytes", String(file.size));
      credFetcher.submit(fd, { method: "post" });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingCredId(null);
    }
  }

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

      {/* ── TAX RATES ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 6 }}>Tax rates</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px", lineHeight: 1.5 }}>
          Define reusable tax rates (e.g. MwSt 19%). They appear as a dropdown when you create proposals.
        </p>

        {taxPresets.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {taxPresets.map((p, i) => (
              <div key={i} style={{ ...subtleCard, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY }}>{p.label}</span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{p.rate}%</span>
                  {p.is_default && (
                    <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "#111", background: ACCENT, borderRadius: 999, padding: "2px 8px" }}>
                      Default
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {!p.is_default && (
                    <button
                      type="button"
                      onClick={() => setTaxPresetDefault(i)}
                      style={{ background: "none", border: "none", color: ACCENT, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_BODY }}
                    >
                      Set as default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteTaxPreset(i)}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: FONT_BODY }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 16px" }}>No tax rates yet.</p>
        )}

        <div style={{ ...subtleCard }}>
          <p style={{ ...labelStyle, marginBottom: 10 }}>Add tax rate</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 160px" }}>
              <label style={labelStyle}>Label</label>
              <input
                style={inputStyle}
                value={newTaxLabel}
                onChange={(e) => setNewTaxLabel(e.target.value)}
                placeholder="e.g. MwSt"
              />
            </div>
            <div style={{ flex: "0 1 120px" }}>
              <label style={labelStyle}>Rate %</label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={newTaxRate}
                onChange={(e) => setNewTaxRate(e.target.value)}
                placeholder="19"
              />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", margin: "12px 0" }}>
            <input
              type="checkbox"
              checked={newTaxDefault}
              onChange={(e) => setNewTaxDefault(e.target.checked)}
              style={{ accentColor: ACCENT, width: 15, height: 15 }}
            />
            <span style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: FONT_BODY }}>Set as default</span>
          </label>
          <button
            type="button"
            onClick={addTaxPreset}
            disabled={!newTaxLabel.trim() || newTaxRate === "" || taxPresetsFetcher.state !== "idle"}
            style={{ ...saveBtn, opacity: (!newTaxLabel.trim() || newTaxRate === "") ? 0.6 : 1 }}
          >
            Add tax rate
          </button>
        </div>
      </div>

      {/* ── CREDENTIALS (beta only) ──────────────────────────────────────── */}
      {!!(profile.is_beta as boolean | null) && (
        <div style={card}>
          <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Credentials</h2>

          {/* Pill checklist */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
            {CREDENTIAL_TYPES.map(({ value, label }) => {
              const cred = credentials.find((c) => c.type === value);
              return (
                <button key={value} onClick={() => openCredForm(cred ?? null, value)} style={credPillStyle(cred)}>
                  {label}
                  {cred && <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.8 }}>· {CRED_STATUS_MAP[cred.status]?.label ?? cred.status}</span>}
                </button>
              );
            })}
          </div>

          {/* Add/Edit form */}
          {credFormOpen && (
            <div style={{ ...subtleCard, marginBottom: 16, border: "1px solid rgba(245,166,35,0.3)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <p style={{ ...labelStyle, margin: 0 }}>{credEditing ? "Edit Credential" : "Add Credential"}</p>
                <button onClick={() => { setCredFormOpen(false); setCredEditing(null); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Type</label>
                  <select style={{ ...inputStyle, appearance: "none", WebkitAppearance: "none", cursor: "pointer" }} value={credForm.type} onChange={(e) => setCredForm((f) => ({ ...f, type: e.target.value }))}>
                    {CREDENTIAL_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Summary</label>
                  <input style={inputStyle} value={credForm.summary_text} onChange={(e) => setCredForm((f) => ({ ...f, summary_text: e.target.value }))} placeholder='e.g. "Seafarer ID valid until 2029"' />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Issuer</label>
                    <input style={inputStyle} value={credForm.issuer} onChange={(e) => setCredForm((f) => ({ ...f, issuer: e.target.value }))} placeholder="e.g. DMCA" />
                  </div>
                  <div>
                    <label style={labelStyle}>Issuer Country</label>
                    <input style={inputStyle} value={credForm.issuer_country} onChange={(e) => setCredForm((f) => ({ ...f, issuer_country: e.target.value }))} placeholder="e.g. Germany" />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Valid From</label>
                    <input type="date" style={inputStyle} value={credForm.valid_from} onChange={(e) => setCredForm((f) => ({ ...f, valid_from: e.target.value }))} />
                  </div>
                  <div>
                    <label style={labelStyle}>Valid Until</label>
                    <input type="date" style={inputStyle} value={credForm.valid_until} onChange={(e) => setCredForm((f) => ({ ...f, valid_until: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Notes (private)</label>
                  <textarea rows={2} style={{ ...inputStyle, resize: "vertical" }} value={credForm.notes} onChange={(e) => setCredForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Private notes…" />
                </div>
                <div>
                  <label style={labelStyle}>Visibility</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["private", "shared"] as const).map((v) => (
                      <button key={v} type="button" onClick={() => setCredForm((f) => ({ ...f, visibility: v }))} style={{ padding: "5px 14px", borderRadius: 20, border: credForm.visibility === v ? `1.5px solid ${ACCENT}` : "1px solid var(--border)", background: credForm.visibility === v ? "rgba(245,166,35,0.1)" : "transparent", color: credForm.visibility === v ? ACCENT : "var(--text-muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_BODY }}>
                        {v === "private" ? "Private" : "Share in negotiations"}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={handleCredSubmit} disabled={credFetcher.state !== "idle"} style={{ ...saveBtn, marginTop: 4, alignSelf: "flex-start" }}>
                  {credFetcher.state !== "idle" ? "Saving…" : credEditing ? "Save Changes" : "Add Credential"}
                </button>
              </div>
            </div>
          )}

          {/* Credential cards */}
          {credentials.length === 0 && !credFormOpen && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", fontFamily: FONT_BODY }}>
              No credentials added yet. Click a pill above to get started.
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {credentials.map((cred) => {
              const typeLabel = CREDENTIAL_TYPES.find((t) => t.value === cred.type)?.label ?? cred.type;
              const expiryDaysLeft = cred.valid_until
                ? Math.ceil((new Date(cred.valid_until).getTime() - Date.now()) / 86400000)
                : null;
              const nearExpiry = expiryDaysLeft !== null && expiryDaysLeft >= 0 && expiryDaysLeft <= 90;
              return (
                <div key={cred.id} style={{ ...subtleCard, position: "relative" }}>
                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: FONT_BODY }}>{typeLabel}</span>
                      <CredStatusBadge status={cred.status} />
                      {cred.visibility === "shared" && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)", background: "var(--surface-muted)", padding: "2px 8px", borderRadius: 20, fontFamily: FONT_BODY }}>Shared</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => openCredForm(cred)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 10px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}>Edit</button>
                      <button
                        onClick={() => {
                          const fd = new FormData();
                          fd.append("intent", "delete_credential");
                          fd.append("id", cred.id);
                          credDeleteFetcher.submit(fd, { method: "post" });
                        }}
                        style={{ background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "4px 10px", fontSize: 12, color: "#f87171", cursor: "pointer", fontFamily: FONT_BODY }}
                      >Delete</button>
                    </div>
                  </div>

                  {cred.summary_text && (
                    <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 6px", fontFamily: FONT_BODY }}>{cred.summary_text}</p>
                  )}
                  {(cred.issuer || cred.issuer_country) && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px", fontFamily: FONT_BODY }}>
                      {[cred.issuer, cred.issuer_country].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {(cred.valid_from || cred.valid_until) && (
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 4px", fontFamily: FONT_BODY }}>
                      {cred.valid_from && new Date(cred.valid_from).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                      {cred.valid_from && cred.valid_until && " → "}
                      {cred.valid_until && new Date(cred.valid_until).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                    </p>
                  )}
                  {nearExpiry && expiryDaysLeft !== null && (
                    <p style={{ fontSize: 12, color: ACCENT, fontWeight: 700, margin: "4px 0 0", fontFamily: FONT_BODY }}>
                      ⚠️ Expires in {expiryDaysLeft} day{expiryDaysLeft !== 1 ? "s" : ""}
                    </p>
                  )}

                  {/* Upload section — only when upload_enabled */}
                  {cred.upload_enabled && (
                    <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "rgba(59,130,246,0.07)", border: "1px solid rgba(59,130,246,0.2)" }}>
                      {cred.upload_context && (
                        <p style={{ fontSize: 12, color: "#60a5fa", fontWeight: 600, margin: "0 0 8px", fontFamily: FONT_BODY }}>
                          Document requested: {cred.upload_context}
                        </p>
                      )}
                      {cred.file_name && (
                        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px", fontFamily: FONT_BODY }}>
                          📎 {cred.file_name}
                          {cred.file_url && (
                            <a href={cred.file_url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8, color: ACCENT, fontSize: 11 }}>View</a>
                          )}
                        </p>
                      )}
                      <label style={{ display: "inline-block", cursor: "pointer" }}>
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          style={{ display: "none" }}
                          disabled={uploadingCredId === cred.id}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (file) await handleFileUpload(cred.id, file);
                            e.target.value = "";
                          }}
                        />
                        <span style={{ display: "inline-block", padding: "6px 14px", borderRadius: 8, background: "rgba(59,130,246,0.15)", color: "#60a5fa", fontSize: 12, fontWeight: 600, cursor: uploadingCredId === cred.id ? "not-allowed" : "pointer", fontFamily: FONT_BODY, opacity: uploadingCredId === cred.id ? 0.6 : 1 }}>
                          {uploadingCredId === cred.id ? "Uploading…" : cred.file_name ? "Replace file" : "Upload document"}
                        </span>
                      </label>
                      {uploadError && uploadingCredId === null && (
                        <p style={{ fontSize: 11, color: "#f87171", margin: "6px 0 0", fontFamily: FONT_BODY }}>{uploadError}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!credFormOpen && (
            <button onClick={() => openCredForm(null)} style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY, marginTop: 12 }}>
              + Add Credential
            </button>
          )}
        </div>
      )}

      <ServiceModal
        isOpen={serviceModal.open}
        onClose={() => setServiceModal({ open: false, editing: null })}
        editing={serviceModal.editing}
        fetcher={serviceFetcher}
      />
    </div>
  );
}
