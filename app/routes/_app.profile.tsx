import { useState, useRef, useEffect } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Route } from "./+types/_app.profile";
import { createSupabaseServerClient, createSupabaseAdminClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { supabase as browserSupabase } from "~/lib/supabase.client";
import Modal from "~/components/Modal";

const ACCENT = "#F5A623";
const FONT_DISPLAY = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";

const SKILL_CATEGORIES = [
  "Performing Arts & Entertainment",
  "Media & Creative Arts",
  "Web & App Development",
  "Academic & Scholar",
] as const;

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

function SortableVideoRow({
  video,
  onEdit,
  onDelete,
}: {
  video: Record<string, unknown>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: video.id as string });
  return (
    <div
      ref={setNodeRef}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        <button
          {...attributes}
          {...listeners}
          style={{ background: "none", border: "none", cursor: "grab", color: "var(--text-muted)", fontSize: 16, padding: "0 4px", touchAction: "none", opacity: 0.4, lineHeight: 1, flexShrink: 0 }}
          title="Drag to reorder"
        >
          ⠿
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{video.title as string}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{video.url as string}</div>
        </div>
      </div>
      <MenuDots onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });

  const [profileSkillsRes, videosRes, refsRes, allSkillsRes, allLangsRes, profileLangsRes, photosRes] = await Promise.all([
    supabase
      .from("profile_skills")
      .select("skill_id")
      .eq("profile_id", profile.id as string),
    supabase
      .from("profile_videos")
      .select("*")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
    supabase
      .from("profile_references")
      .select("*")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
    supabase
      .from("skills")
      .select("id, name, category")
      .eq("type", "skill")
      .eq("is_visible", true)
      .order("name", { ascending: true }),
    supabase
      .from("skills")
      .select("id, name")
      .eq("type", "language")
      .eq("is_visible", true)
      .order("name", { ascending: true }),
    supabase
      .from("profile_languages")
      .select("skill_id")
      .eq("profile_id", profile.id as string),
    supabase
      .from("profile_photos")
      .select("url")
      .eq("profile_id", profile.id as string)
      .order("sort_order", { ascending: true }),
  ]);

  return Response.json(
    {
      profile,
      skillIds: (profileSkillsRes.data ?? []).map((r) => (r as { skill_id: number }).skill_id),
      allSkills: allSkillsRes.data ?? [],
      languageIds: (profileLangsRes.data ?? []).map((r) => (r as { skill_id: number }).skill_id),
      allLanguages: allLangsRes.data ?? [],
      videos: videosRes.data ?? [],
      references: refsRes.data ?? [],
      galleryUrls: (photosRes.data ?? []).map((r) => (r as { url: string }).url),
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

  if (intent === "update_basic") {
    const firstName = formData.get("first_name") as string;
    const lastName = formData.get("last_name") as string;
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { error } = await supabase.from("profiles").update({
      brand_name: (formData.get("brand_name") as string) || null,
      first_name: firstName,
      last_name: lastName,
      name: name || null,
      bio: formData.get("bio") as string,
      city: formData.get("city") as string,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_socials") {
    const { error } = await supabase.from("profiles").update({
      website_url: formData.get("website_url") as string,
      social_youtube: formData.get("social_youtube") as string,
      social_facebook: formData.get("social_facebook") as string,
      social_instagram: formData.get("social_instagram") as string,
      social_linkedin: formData.get("social_linkedin") as string,
      social_tiktok: formData.get("social_tiktok") as string,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_widgets") {
    const { error } = await supabase.from("profiles").update({
      widget_spotify: formData.get("widget_spotify") as string,
      widget_soundcloud: formData.get("widget_soundcloud") as string,
      widget_bandsintown: formData.get("widget_bandsintown") as string,
      widget_muso: formData.get("widget_muso") as string,
      widget_mixcloud: formData.get("widget_mixcloud") as string,
    }).eq("id", profile.id as string);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_gallery") {
    const transformUrl = (url: string) => {
      if (url.includes("dropbox.com")) {
        return url
          .replace("?dl=0", "?raw=1")
          .replace("?dl=1", "?raw=1")
          .replace("www.dropbox.com", "dl.dropboxusercontent.com");
      }
      return url;
    };
    let urls: string[] = [];
    try { urls = (JSON.parse(formData.get("urls") as string) as string[]).map(transformUrl); } catch { urls = []; }
    const admin = createSupabaseAdminClient();
    await admin.from("profile_photos").delete().eq("profile_id", profile.id as string);
    if (urls.length > 0) {
      const rows = urls.map((url, i) => ({ profile_id: profile.id as string, url, sort_order: i }));
      const { error } = await admin.from("profile_photos").insert(rows);
      return Response.json({ ok: !error, error: error?.message }, { headers });
    }
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "update_business") {
    const { error } = await supabase.from("profiles").update({
      company_name: formData.get("company_name") as string,
      company_address: formData.get("company_address") as string,
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

  const adminClient = createSupabaseAdminClient();

  if (intent === "add_video") {
    const url = formData.get("url") as string;
    const title = (formData.get("title") as string) || url;
    const { error } = await adminClient.from("profile_videos").insert({
      profile_id: profile.id as string,
      url,
      title,
      sort_order: 0,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_video") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_videos").delete().eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_video") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_videos").update({
      url: formData.get("url") as string,
      title: formData.get("title") as string,
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "reorder_videos") {
    const order = JSON.parse(formData.get("order") as string) as { id: string; sort_order: number }[];
    await Promise.all(
      order.map(({ id, sort_order }) =>
        adminClient.from("profile_videos").update({ sort_order }).eq("id", id)
      )
    );
    return Response.json({ ok: true }, { headers });
  }

  if (intent === "add_reference") {
    const isCurrent = formData.get("is_current") === "true";
    const { error } = await adminClient.from("profile_references").insert({
      profile_id: profile.id as string,
      company: formData.get("company") as string,
      role: formData.get("role") as string,
      date_start: formData.get("date_start") as string || null,
      date_end: isCurrent ? null : (formData.get("date_end") as string || null),
      is_current: isCurrent,
      sort_order: 0,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "delete_reference") {
    const id = formData.get("id") as string;
    const { error } = await adminClient.from("profile_references").delete().eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "update_reference") {
    const id = formData.get("id") as string;
    const isCurrent = formData.get("is_current") === "true";
    const { error } = await adminClient.from("profile_references").update({
      company: formData.get("company") as string,
      role: formData.get("role") as string,
      date_start: (formData.get("date_start") as string) || null,
      date_end: isCurrent ? null : ((formData.get("date_end") as string) || null),
      is_current: isCurrent,
    }).eq("id", id);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "add_skill") {
    const skillId = Number(formData.get("skill_id"));
    const { error } = await adminClient.from("profile_skills").insert({
      profile_id: profile.id as string,
      skill_id: skillId,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "remove_skill") {
    const skillId = Number(formData.get("skill_id"));
    const { error } = await adminClient
      .from("profile_skills")
      .delete()
      .eq("profile_id", profile.id as string)
      .eq("skill_id", skillId);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "add_language") {
    const skillId = Number(formData.get("skill_id"));
    const { error } = await adminClient.from("profile_languages").insert({
      profile_id: profile.id as string,
      skill_id: skillId,
    });
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  if (intent === "remove_language") {
    const skillId = Number(formData.get("skill_id"));
    const { error } = await adminClient
      .from("profile_languages")
      .delete()
      .eq("profile_id", profile.id as string)
      .eq("skill_id", skillId);
    return Response.json({ ok: !error, error: error?.message }, { headers });
  }

  return Response.json({ ok: false, error: "Unknown intent" }, { headers });
}

export default function ProfilePage() {
  const { profile, skillIds, allSkills, languageIds, allLanguages, videos, references, galleryUrls: initialGalleryUrls } = useLoaderData<typeof loader>() as {
    profile: Record<string, unknown>;
    skillIds: number[];
    allSkills: { id: number; name: string; category: string }[];
    languageIds: number[];
    allLanguages: { id: number; name: string }[];
    videos: Record<string, unknown>[];
    references: Record<string, unknown>[];
    galleryUrls: string[];
  };

  const basicFetcher = useFetcher();
  const socialsFetcher = useFetcher();
  const widgetsFetcher = useFetcher();
  const galleryFetcher = useFetcher();
  const businessFetcher = useFetcher();
  const videoFetcher = useFetcher();
  const videoReorderFetcher = useFetcher();
  const refFetcher = useFetcher();
  const skillFetcher = useFetcher();
  const langFetcher = useFetcher();

  // Videos local state for drag reorder
  const [localVideos, setLocalVideos] = useState<Record<string, unknown>[]>(videos);
  useEffect(() => { setLocalVideos(videos); }, [videos]);
  const videoSensors = useSensors(useSensor(PointerSensor));

  function handleVideoDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocalVideos((prev) => {
      const oldIndex = prev.findIndex((v) => v.id === active.id);
      const newIndex = prev.findIndex((v) => v.id === over.id);
      const reordered = arrayMove(prev, oldIndex, newIndex);
      const order = reordered.map((v, i) => ({ id: v.id as string, sort_order: i }));
      const fd = new FormData();
      fd.append("intent", "reorder_videos");
      fd.append("order", JSON.stringify(order));
      videoReorderFetcher.submit(fd, { method: "post" });
      return reordered;
    });
  }

  // Skills + languages state
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<number>>(() => new Set(skillIds));
  const [selectedLangIds, setSelectedLangIds] = useState<Set<number>>(() => new Set(languageIds));
  const [activeSkillTab, setActiveSkillTab] = useState<string>(SKILL_CATEGORIES[0]);

  function toggleSkill(skillId: number) {
    const isSelected = selectedSkillIds.has(skillId);
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.delete(skillId); else next.add(skillId);
      return next;
    });
    const fd = new FormData();
    fd.append("intent", isSelected ? "remove_skill" : "add_skill");
    fd.append("skill_id", String(skillId));
    skillFetcher.submit(fd, { method: "post" });
  }

  function toggleLanguage(skillId: number) {
    const isSelected = selectedLangIds.has(skillId);
    setSelectedLangIds((prev) => {
      const next = new Set(prev);
      if (isSelected) next.delete(skillId); else next.add(skillId);
      return next;
    });
    const fd = new FormData();
    fd.append("intent", isSelected ? "remove_language" : "add_language");
    fd.append("skill_id", String(skillId));
    langFetcher.submit(fd, { method: "post" });
  }

  // Avatar state
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Social edit states
  const [socialEdit, setSocialEdit] = useState<Record<string, boolean>>({});
  const [socialValues, setSocialValues] = useState({
    website_url: (profile.website_url as string) ?? "",
    social_youtube: (profile.social_youtube as string) ?? "",
    social_facebook: (profile.social_facebook as string) ?? "",
    social_instagram: (profile.social_instagram as string) ?? "",
    social_linkedin: (profile.social_linkedin as string) ?? "",
    social_tiktok: (profile.social_tiktok as string) ?? "",
  });

  // Widget edit states
  const [widgetEdit, setWidgetEdit] = useState<Record<string, boolean>>({});
  const [widgetErrors, setWidgetErrors] = useState<Record<string, string | null>>({});
  const [widgetValues, setWidgetValues] = useState({
    widget_spotify: (profile.widget_spotify as string) ?? "",
    widget_soundcloud: (profile.widget_soundcloud as string) ?? "",
    widget_bandsintown: (profile.widget_bandsintown as string) ?? "",
    widget_muso: (profile.widget_muso as string) ?? "",
    widget_mixcloud: (profile.widget_mixcloud as string) ?? "",
  });
  const [galleryUrls, setGalleryUrls] = useState<string[]>(initialGalleryUrls);
  const [selectedLegalForm, setSelectedLegalForm] = useState<string>((profile.legal_form as string) ?? "");

  // Modal state
  const [skillsModalOpen, setSkillsModalOpen] = useState(false);
  const [langsModalOpen, setLangsModalOpen] = useState(false);
  const [videoModal, setVideoModal] = useState<{ open: boolean; editing: Record<string, unknown> | null }>({ open: false, editing: null });
  const [refModal, setRefModal] = useState<{ open: boolean; editing: Record<string, unknown> | null }>({ open: false, editing: null });
  const [videoForm, setVideoForm] = useState({ url: "", title: "" });
  const [refForm, setRefForm] = useState({ company: "", role: "", date_start: "", date_end: "", is_current: false });

  function openVideoModal(editing?: Record<string, unknown>) {
    setVideoForm({
      url: (editing?.url as string) ?? "",
      title: (editing?.title as string) ?? "",
    });
    setVideoModal({ open: true, editing: editing ?? null });
  }

  function openRefModal(editing?: Record<string, unknown>) {
    setRefForm({
      company: (editing?.company as string) ?? "",
      role: (editing?.role as string) ?? "",
      date_start: (editing?.date_start as string) ?? "",
      date_end: (editing?.date_end as string) ?? "",
      is_current: (editing?.is_current as boolean) ?? false,
    });
    setRefModal({ open: true, editing: editing ?? null });
  }

  function handleVideoSubmit() {
    if (!videoForm.url.trim()) return;
    const fd = new FormData();
    if (videoModal.editing) {
      fd.append("intent", "update_video");
      fd.append("id", videoModal.editing.id as string);
    } else {
      fd.append("intent", "add_video");
    }
    fd.append("url", videoForm.url);
    fd.append("title", videoForm.title || videoForm.url);
    videoFetcher.submit(fd, { method: "post" });
    setVideoModal({ open: false, editing: null });
  }

  function handleRefSubmit() {
    if (!refForm.company.trim() || !refForm.role.trim()) return;
    const fd = new FormData();
    if (refModal.editing) {
      fd.append("intent", "update_reference");
      fd.append("id", refModal.editing.id as string);
    } else {
      fd.append("intent", "add_reference");
    }
    fd.append("company", refForm.company);
    fd.append("role", refForm.role);
    fd.append("date_start", refForm.date_start);
    fd.append("date_end", refForm.date_end);
    fd.append("is_current", String(refForm.is_current));
    refFetcher.submit(fd, { method: "post" });
    setRefModal({ open: false, editing: null });
  }

  const profileId = profile.id as string;
  const slug = (profile.slug as string) ?? "";

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    setAvatarStatus("Uploading…");
    const { data: { user: authUser } } = await browserSupabase.auth.getUser();
    if (!authUser) { setAvatarStatus("Upload failed."); setAvatarUploading(false); return; }
    const ext = file.name.split(".").pop();
    const path = `${authUser.id}/avatar.${ext}`;
    const { error: uploadError } = await browserSupabase.storage.from("profile-pictures").upload(path, file, { upsert: true });
    if (uploadError) {
      console.log("avatar upload error:", uploadError);
      setAvatarStatus("Upload failed.");
      setAvatarUploading(false);
      return;
    }
    const { data: urlData } = browserSupabase.storage.from("profile-pictures").getPublicUrl(path);
    const publicUrl = urlData.publicUrl;
    await browserSupabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", profileId);
    setAvatarStatus("Photo updated!");
    setAvatarUploading(false);
    setTimeout(() => setAvatarStatus(""), 3000);
  }

  // Completion counts
  const basicFilled = [profile.brand_name, profile.first_name, profile.last_name, profile.bio, profile.city].filter(Boolean).length;
  const socialFilled = [socialValues.social_youtube, socialValues.social_facebook, socialValues.social_instagram, socialValues.social_linkedin, socialValues.social_tiktok].filter(Boolean).length;
  const widgetFilled = [widgetValues.widget_spotify, widgetValues.widget_soundcloud, widgetValues.widget_bandsintown, widgetValues.widget_muso, widgetValues.widget_mixcloud].filter(Boolean).length;
  const businessFilled = [profile.company_name, profile.responsible_person, profile.vat_id].some(Boolean) ? 1 : 0;

  const TikTokIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style={{ display: "inline-block", verticalAlign: "middle" }}>
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.27 8.27 0 0 0 4.83 1.54V6.78a4.85 4.85 0 0 1-1.06-.09z"/>
    </svg>
  );

  const socialFields: { key: keyof typeof socialValues; emoji: React.ReactNode; label: string; placeholder?: string }[] = [
    { key: "social_youtube", emoji: "▶️", label: "YouTube" },
    { key: "social_facebook", emoji: "📘", label: "Facebook" },
    { key: "social_instagram", emoji: "📸", label: "Instagram" },
    { key: "social_linkedin", emoji: "💼", label: "LinkedIn" },
    { key: "social_tiktok", emoji: <TikTokIcon />, label: "TikTok", placeholder: "https://tiktok.com/@username" },
  ];

  const widgetFields: { key: keyof typeof widgetValues; emoji: string; label: string; placeholder?: string; validate?: (v: string) => string | null }[] = [
    { key: "widget_spotify", emoji: "🎵", label: "Spotify" },
    { key: "widget_soundcloud", emoji: "☁️", label: "SoundCloud" },
    { key: "widget_bandsintown", emoji: "🎤", label: "Bandsintown" },
    { key: "widget_muso", emoji: "🎼", label: "Muso" },
    { key: "widget_mixcloud", emoji: "🎧", label: "Mixcloud", placeholder: "https://www.mixcloud.com/username/mix-name/", validate: v => v && !v.includes("mixcloud.com") ? "Must be a valid Mixcloud URL" : null },
  ];

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 80px", fontFamily: FONT_BODY, color: "var(--text)" }}>
      <h1 style={sectionTitle}>Your Profile</h1>

      {/* Section 0: Profile Picture */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Profile Picture</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url as string}
              alt="Avatar"
              style={{ width: 120, height: 120, borderRadius: "50%", objectFit: "cover", border: `2px solid ${ACCENT}` }}
            />
          ) : (
            <div style={{ width: 120, height: 120, borderRadius: "50%", background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48 }}>
              🧑
            </div>
          )}
          <div>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              style={{ ...saveBtn, marginTop: 0, opacity: avatarUploading ? 0.6 : 1 }}
            >
              {avatarUploading ? "Uploading…" : "Choose photo"}
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: "none" }} />
            {avatarStatus && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: ACCENT, fontFamily: FONT_BODY }}>{avatarStatus}</p>
            )}
          </div>
        </div>
      </div>

      {/* Section 1: Basic Info */}
      <div style={card}>
        <CompletionBadge filled={basicFilled} total={5} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Basic Info</h2>
        <basicFetcher.Form method="post">
          <input type="hidden" name="intent" value="update_basic" />
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Brand name / Stage name</label>
            <input
              name="brand_name"
              defaultValue={(profile.brand_name as string) ?? ""}
              style={inputStyle}
              placeholder="e.g. DJ Bongo, Will Villa, Locura Sound"
            />
            <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "5px 0 0", fontFamily: "inherit" }}>
              This is your public name — how you appear on your profile
            </p>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Legal name (for invoicing)</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <input name="first_name" defaultValue={(profile.first_name as string) ?? ""} style={inputStyle} placeholder="First name" />
              <input name="last_name" defaultValue={(profile.last_name as string) ?? ""} style={inputStyle} placeholder="Last name" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Bio</label>
            <textarea
              name="bio"
              defaultValue={(profile.bio as string) ?? ""}
              rows={4}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
          <div>
            <label style={labelStyle}>City</label>
            <input name="city" defaultValue={(profile.city as string) ?? ""} style={inputStyle} />
          </div>
          <button type="submit" style={saveBtn} disabled={basicFetcher.state !== "idle"}>
            {basicFetcher.state !== "idle" ? "Saving…" : "Save"}
          </button>
        </basicFetcher.Form>
      </div>

      {/* Section 2: Skills */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Skills</h2>
        {selectedSkillIds.size > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {allSkills
              .filter((s) => selectedSkillIds.has(s.id))
              .map((skill) => (
                <span
                  key={skill.id}
                  style={{
                    padding: "5px 12px",
                    background: "rgba(245,166,35,0.1)",
                    border: `1.5px solid ${ACCENT}`,
                    borderRadius: 20,
                    fontSize: 13,
                    fontWeight: 600,
                    color: ACCENT,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {skill.name}
                </span>
              ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No skills added yet.</p>
        )}
        <button
          onClick={() => setSkillsModalOpen(true)}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          Edit Skills
        </button>
      </div>

      {/* Section 2b: Languages */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Languages</h2>
        {selectedLangIds.size > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {allLanguages
              .filter((l) => selectedLangIds.has(l.id))
              .map((lang) => (
                <span
                  key={lang.id}
                  style={{
                    padding: "5px 12px",
                    background: "rgba(245,166,35,0.1)",
                    border: `1.5px solid ${ACCENT}`,
                    borderRadius: 20,
                    fontSize: 13,
                    fontWeight: 600,
                    color: ACCENT,
                    fontFamily: FONT_BODY,
                  }}
                >
                  {lang.name}
                </span>
              ))}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No languages added yet.</p>
        )}
        <button
          onClick={() => setLangsModalOpen(true)}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          Edit Languages
        </button>
      </div>

      {/* Section 3: Socials */}
      <div style={card}>
        <CompletionBadge filled={socialFilled} total={5} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Socials</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {socialFields.map(({ key, emoji, label, placeholder }) => {
            const val = socialValues[key];
            const editing = !!socialEdit[key];
            return (
              <div key={key}>
                <div
                  onClick={() => !editing && setSocialEdit(s => ({ ...s, [key]: true }))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 0",
                    cursor: editing ? "default" : "pointer",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: 18, minWidth: 24 }}>{emoji}</span>
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: val ? ACCENT : "var(--text-muted)" }}>
                      {label}
                    </span>
                    {val && !editing && (
                      <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)", display: "inline-block", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>{val}</span>
                    )}
                  </div>
                  {!editing && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{val ? "Edit" : "Add"}</span>
                  )}
                </div>
                {editing && (
                  <div style={{ padding: "10px 0 14px 34px" }}>
                    <input
                      style={inputStyle}
                      value={socialValues[key]}
                      onChange={e => setSocialValues(v => ({ ...v, [key]: e.target.value }))}
                      placeholder={placeholder ?? `Enter ${label} URL`}
                      autoFocus
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        style={{ ...saveBtn, marginTop: 0, fontSize: 13, padding: "8px 16px" }}
                        onClick={() => {
                          setSocialEdit(s => ({ ...s, [key]: false }));
                          const fd = new FormData();
                          fd.append("intent", "update_socials");
                          Object.entries(socialValues).forEach(([k, v]) => fd.append(k, v));
                          socialsFetcher.submit(fd, { method: "post" });
                        }}
                      >
                        Save
                      </button>
                      <button
                        style={{ padding: "8px 16px", background: "none", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}
                        onClick={() => setSocialEdit(s => ({ ...s, [key]: false }))}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 4: Widgets */}
      <div style={card}>
        <CompletionBadge filled={widgetFilled} total={5} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Widgets</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {widgetFields.map(({ key, emoji, label, placeholder, validate }) => {
            const val = widgetValues[key];
            const editing = !!widgetEdit[key];
            const err = widgetErrors[key];
            return (
              <div key={key}>
                <div
                  onClick={() => !editing && setWidgetEdit(s => ({ ...s, [key]: true }))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 0",
                    cursor: editing ? "default" : "pointer",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: 18, minWidth: 24 }}>{emoji}</span>
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: val ? ACCENT : "var(--text-muted)" }}>
                      {label}
                    </span>
                    {val && !editing && (
                      <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)", display: "inline-block", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>{val}</span>
                    )}
                  </div>
                  {!editing && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{val ? "Edit" : "Add"}</span>
                  )}
                </div>
                {editing && (
                  <div style={{ padding: "10px 0 14px 34px" }}>
                    <input
                      style={inputStyle}
                      value={widgetValues[key]}
                      onChange={e => {
                        setWidgetValues(v => ({ ...v, [key]: e.target.value }));
                        setWidgetErrors(s => ({ ...s, [key]: null }));
                      }}
                      placeholder={placeholder ?? `Enter ${label} URL`}
                      autoFocus
                    />
                    {err && <p style={{ fontSize: 12, color: "#e05252", marginTop: 4 }}>{err}</p>}
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        disabled={widgetsFetcher.state !== "idle"}
                        style={{ ...saveBtn, marginTop: 0, fontSize: 13, padding: "8px 16px", opacity: widgetsFetcher.state !== "idle" ? 0.6 : 1 }}
                        onClick={() => {
                          const errMsg = validate ? validate(widgetValues[key]) : null;
                          if (errMsg) { setWidgetErrors(s => ({ ...s, [key]: errMsg })); return; }
                          setWidgetEdit(s => ({ ...s, [key]: false }));
                          const fd = new FormData();
                          fd.append("intent", "update_widgets");
                          Object.entries(widgetValues).forEach(([k, v]) => fd.append(k, v));
                          widgetsFetcher.submit(fd, { method: "post" });
                        }}
                      >
                        {widgetsFetcher.state !== "idle" ? "Saving…" : "Save"}
                      </button>
                      <button
                        style={{ padding: "8px 16px", background: "none", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text-muted)", cursor: "pointer", fontFamily: FONT_BODY }}
                        onClick={() => { setWidgetEdit(s => ({ ...s, [key]: false })); setWidgetErrors(s => ({ ...s, [key]: null })); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>

      {/* Section 4b: Photo Gallery */}
      <div style={card}>
        <CompletionBadge filled={galleryUrls.length > 0 ? 1 : 0} total={1} />
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Photo Gallery</h2>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {galleryUrls.length}/12 photos
          </span>
          {galleryUrls.length < 12 && (
            <button
              style={{ fontSize: 12, padding: "4px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", color: "var(--text-muted)", fontFamily: FONT_BODY }}
              onClick={() => setGalleryUrls(u => [...u, ""])}
            >
              + Add photo URL
            </button>
          )}
        </div>
        {galleryUrls.map((url, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input
              style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
              value={url}
              placeholder="https://example.com/photo.jpg"
              onChange={e => setGalleryUrls(u => u.map((x, j) => j === i ? e.target.value : x))}
            />
            <button
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16, padding: "4px 6px", flexShrink: 0 }}
              onClick={() => {
                const updated = galleryUrls.filter((_, j) => j !== i);
                setGalleryUrls(updated);
                const validUrls = updated.filter(u => u.startsWith("http"));
                const fd = new FormData();
                fd.append("intent", "update_gallery");
                fd.append("urls", JSON.stringify(validUrls));
                galleryFetcher.submit(fd, { method: "post" });
              }}
              title="Remove"
            >
              🗑️
            </button>
          </div>
        ))}
        {galleryUrls.length > 0 && (
          <button
            disabled={galleryFetcher.state !== "idle"}
            style={{ ...saveBtn, marginTop: 8, fontSize: 13, padding: "8px 16px", opacity: galleryFetcher.state !== "idle" ? 0.6 : 1 }}
            onClick={() => {
              const validUrls = galleryUrls.filter(u => u.startsWith("http"));
              const fd = new FormData();
              fd.append("intent", "update_gallery");
              fd.append("urls", JSON.stringify(validUrls));
              galleryFetcher.submit(fd, { method: "post" });
            }}
          >
            {galleryFetcher.state !== "idle" ? "Saving…" : "Save Gallery"}
          </button>
        )}
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          Make sure your images are publicly accessible and under 2MB. Right-click any image online and copy the image address, or use Google Photos, Dropbox, or any image host with a direct image URL.
        </p>
      </div>

      {/* Section 5: Videos */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Videos</h2>
        {localVideos.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No videos added yet.</p>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <DndContext sensors={videoSensors} collisionDetection={closestCenter} onDragEnd={handleVideoDragEnd}>
              <SortableContext items={localVideos.map((v) => v.id as string)} strategy={verticalListSortingStrategy}>
                {localVideos.map((video) => (
                  <SortableVideoRow
                    key={video.id as string}
                    video={video}
                    onEdit={() => openVideoModal(video)}
                    onDelete={() => {
                      const fd = new FormData();
                      fd.append("intent", "delete_video");
                      fd.append("id", video.id as string);
                      videoFetcher.submit(fd, { method: "post" });
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
        <button
          onClick={() => openVideoModal()}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          + Add Video
        </button>
      </div>

      {/* Section 6: References */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>References</h2>
        {references.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>No references added yet.</p>
        ) : (
          <div style={{ marginBottom: 16 }}>
            {references.map((ref) => (
              <div key={ref.id as string} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{ref.company as string}</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                    {ref.role as string} · {ref.date_start as string}{" "}
                    → {ref.is_current ? "Present" : (ref.date_end as string) ?? ""}
                  </div>
                </div>
                <MenuDots
                  onEdit={() => openRefModal(ref)}
                  onDelete={() => {
                    const fd = new FormData();
                    fd.append("intent", "delete_reference");
                    fd.append("id", ref.id as string);
                    refFetcher.submit(fd, { method: "post" });
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => openRefModal()}
          style={{ background: "none", border: `1px solid rgba(245,166,35,0.4)`, color: ACCENT, borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT_BODY }}
        >
          + Add Reference
        </button>
      </div>

      {/* Section 7: Business Details */}
      {(() => {
        const lf = selectedLegalForm.trim();
        const isFreelancer = ["Freelancer / Selbstständig", "Sole Trader"].includes(lf);
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

        return (
          <div style={card}>
            <CompletionBadge filled={businessFilled} total={1} />
            <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Business Details</h2>
            <businessFetcher.Form method="post">
              <input type="hidden" name="intent" value="update_business" />
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

                {/* Legal Form dropdown — always first */}
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

                {/* Company Name — shown for entity types */}
                {showCompanyName && (
                  <div>
                    <label style={labelStyle}>Company Name</label>
                    <input name="company_name" defaultValue={(profile.company_name as string) ?? ""} style={inputStyle} />
                  </div>
                )}

                {/* Company Address */}
                {showCompanyAddress ? (
                  <div>
                    <label style={labelStyle}>{companyAddressLabel}</label>
                    <input name="company_address" defaultValue={(profile.company_address as string) ?? ""} style={inputStyle} />
                  </div>
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
                  </>
                ) : null}

                {/* Hidden passthrough for fields not shown */}
                {!showCompanyName && hasForm && (
                  <input type="hidden" name="company_name" value={(profile.company_name as string) ?? ""} />
                )}
                {showCompanyAddress === false && hasForm && (
                  <input type="hidden" name="company_address" value={(profile.company_address as string) ?? ""} />
                )}

                {/* Legal & Compliance — shown when a form is selected */}
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
                          <input
                            name="responsible_person"
                            defaultValue={(profile.responsible_person as string) ?? ""}
                            placeholder="Full legal name"
                            style={inputStyle}
                          />
                        </div>
                      )}
                      {showVat && (
                        <div>
                          <label style={labelStyle}>{vatLabel}</label>
                          <input
                            name="vat_id"
                            defaultValue={(profile.vat_id as string) ?? ""}
                            placeholder={vatPlaceholder}
                            style={inputStyle}
                          />
                        </div>
                      )}
                      {showStateOfIncorporation && (
                        <div>
                          <label style={labelStyle}>State of Incorporation</label>
                          <input
                            name="trade_register_court"
                            defaultValue={(profile.trade_register_court as string) ?? ""}
                            placeholder="e.g. Delaware, Wyoming"
                            style={inputStyle}
                          />
                          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "4px 0 0", fontFamily: FONT_BODY }}>
                            Stored as "Registered in: [state]" in the legal footer.
                          </p>
                        </div>
                      )}
                      {showTradeRegister && (
                        <>
                          <div>
                            <label style={labelStyle}>Trade Register Court</label>
                            <input
                              name="trade_register_court"
                              defaultValue={(profile.trade_register_court as string) ?? ""}
                              placeholder="e.g. Amtsgericht Mannheim"
                              style={inputStyle}
                            />
                          </div>
                          <div>
                            <label style={labelStyle}>Trade Register Number</label>
                            <input
                              name="trade_register_number"
                              defaultValue={(profile.trade_register_number as string) ?? ""}
                              placeholder="e.g. HRB 12345"
                              style={inputStyle}
                            />
                          </div>
                        </>
                      )}
                      {showRegulatoryBody && (
                        <div>
                          <label style={labelStyle}>Professional Regulatory Body</label>
                          <input
                            name="regulatory_body"
                            defaultValue={(profile.regulatory_body as string) ?? ""}
                            style={inputStyle}
                          />
                        </div>
                      )}
                      {showDpo && (
                        <div>
                          <label style={labelStyle}>Data Protection Officer Email</label>
                          <input
                            type="email"
                            name="dpo_email"
                            defaultValue={(profile.dpo_email as string) ?? ""}
                            placeholder="datenschutz@example.com"
                            style={inputStyle}
                          />
                        </div>
                      )}
                      {showExternalPrivacy && (
                        <div>
                          <label style={labelStyle}>External Privacy Policy URL</label>
                          <input
                            type="url"
                            name="external_privacy_url"
                            defaultValue={(profile.external_privacy_url as string) ?? ""}
                            placeholder="https://..."
                            style={inputStyle}
                          />
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
        );
      })()}

      {/* Section 9: Publish */}
      <div style={card}>
        <h2 style={{ ...sectionTitle, fontSize: 22, marginBottom: 14 }}>Publish</h2>
        <a
          href={`https://${slug}.sqrz.com`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13, color: ACCENT, fontFamily: FONT_BODY, display: "block", marginBottom: 16 }}
        >
          {slug}.sqrz.com ↗
        </a>

      </div>

      {/* Skills Modal */}
      <Modal isOpen={skillsModalOpen} onClose={() => setSkillsModalOpen(false)} title="Edit Skills">
        {/* Category label */}
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 8px", fontFamily: FONT_BODY }}>
          Choose a category
        </p>
        <div style={{ display: "flex", gap: 6, marginBottom: 0, flexWrap: "wrap" }}>
          {SKILL_CATEGORIES.map((cat) => {
            const isActive = activeSkillTab === cat;
            return (
              <button
                key={cat}
                onClick={() => setActiveSkillTab(cat)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 20,
                  border: isActive ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
                  background: isActive ? "rgba(245,166,35,0.15)" : "var(--surface-muted)",
                  color: isActive ? ACCENT : "var(--text)",
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 600,
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>
        {/* Divider */}
        <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0 10px" }} />
        {/* Skills label */}
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 8px", fontFamily: FONT_BODY }}>
          Select your skills
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {allSkills
            .filter((s) => s.category === activeSkillTab)
            .map((skill) => {
              const isSelected = selectedSkillIds.has(skill.id);
              return (
                <button
                  key={skill.id}
                  onClick={() => toggleSkill(skill.id)}
                  style={{
                    padding: "6px 13px",
                    borderRadius: 20,
                    border: isSelected ? `1.5px solid ${ACCENT}` : "1.5px solid var(--border)",
                    background: isSelected ? "rgba(245,166,35,0.1)" : "transparent",
                    color: isSelected ? ACCENT : "var(--text-muted)",
                    fontSize: 13,
                    fontWeight: isSelected ? 600 : 400,
                    cursor: "pointer",
                    fontFamily: FONT_BODY,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {skill.name}
                  {isSelected && <span style={{ fontSize: 11, opacity: 0.8 }}>✕</span>}
                </button>
              );
            })}
        </div>
        {selectedSkillIds.size > 0 && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 14, marginBottom: 0, fontFamily: FONT_BODY }}>
            {selectedSkillIds.size} skill{selectedSkillIds.size !== 1 ? "s" : ""} selected
          </p>
        )}
      </Modal>

      {/* Languages Modal */}
      <Modal isOpen={langsModalOpen} onClose={() => setLangsModalOpen(false)} title="Edit Languages">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {allLanguages
            .filter((l) => selectedLangIds.has(l.id))
            .map((lang) => (
              <button
                key={lang.id}
                onClick={() => toggleLanguage(lang.id)}
                style={{
                  padding: "6px 13px",
                  borderRadius: 20,
                  border: `1.5px solid ${ACCENT}`,
                  background: "rgba(245,166,35,0.1)",
                  color: ACCENT,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                {lang.name}
                <span style={{ fontSize: 11, opacity: 0.8 }}>✕</span>
              </button>
            ))}
          {allLanguages
            .filter((l) => !selectedLangIds.has(l.id))
            .map((lang) => (
              <button
                key={lang.id}
                onClick={() => toggleLanguage(lang.id)}
                style={{
                  padding: "6px 13px",
                  borderRadius: 20,
                  border: "1.5px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 400,
                  cursor: "pointer",
                  fontFamily: FONT_BODY,
                }}
              >
                {lang.name}
              </button>
            ))}
        </div>
        {selectedLangIds.size > 0 && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 14, marginBottom: 0, fontFamily: FONT_BODY }}>
            {selectedLangIds.size} language{selectedLangIds.size !== 1 ? "s" : ""} selected
          </p>
        )}
      </Modal>

      {/* Video Modal */}
      <Modal
        isOpen={videoModal.open}
        onClose={() => setVideoModal({ open: false, editing: null })}
        title={videoModal.editing ? "Edit Video" : "Add Video"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>YouTube URL</label>
            <input
              style={inputStyle}
              value={videoForm.url}
              onChange={(e) => setVideoForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://youtube.com/watch?v=..."
              autoFocus
            />
          </div>
          <div>
            <label style={labelStyle}>Title (optional)</label>
            <input
              style={inputStyle}
              value={videoForm.title}
              onChange={(e) => setVideoForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Video title"
            />
          </div>
          <button
            onClick={handleVideoSubmit}
            disabled={videoFetcher.state !== "idle"}
            style={{ ...saveBtn, marginTop: 0, alignSelf: "flex-start" }}
          >
            {videoFetcher.state !== "idle" ? "Saving…" : videoModal.editing ? "Save Changes" : "Add Video"}
          </button>
        </div>
      </Modal>

      {/* Reference Modal */}
      <Modal
        isOpen={refModal.open}
        onClose={() => setRefModal({ open: false, editing: null })}
        title={refModal.editing ? "Edit Reference" : "Add Reference"}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Company</label>
              <input
                style={inputStyle}
                value={refForm.company}
                onChange={(e) => setRefForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Company name"
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Role</label>
              <input
                style={inputStyle}
                value={refForm.role}
                onChange={(e) => setRefForm((f) => ({ ...f, role: e.target.value }))}
                placeholder="Your role"
              />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Start Date</label>
              <input
                type="date"
                style={inputStyle}
                value={refForm.date_start}
                onChange={(e) => setRefForm((f) => ({ ...f, date_start: e.target.value }))}
              />
            </div>
            <div>
              <label style={labelStyle}>End Date</label>
              <input
                type="date"
                style={inputStyle}
                value={refForm.date_end}
                onChange={(e) => setRefForm((f) => ({ ...f, date_end: e.target.value }))}
                disabled={refForm.is_current}
              />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer", fontFamily: FONT_BODY }}>
            <input
              type="checkbox"
              checked={refForm.is_current}
              onChange={(e) => setRefForm((f) => ({ ...f, is_current: e.target.checked }))}
            />
            Currently working here
          </label>
          <button
            onClick={handleRefSubmit}
            disabled={refFetcher.state !== "idle"}
            style={{ ...saveBtn, marginTop: 4, alignSelf: "flex-start" }}
          >
            {refFetcher.state !== "idle" ? "Saving…" : refModal.editing ? "Save Changes" : "Add Reference"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
