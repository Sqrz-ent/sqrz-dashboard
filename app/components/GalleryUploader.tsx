import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "~/lib/supabase.client";

const MAX_PHOTOS = 4;
const MAX_SIZE_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const BUCKET = "profile-media";

const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const ACCENT = "#F5A623";

interface LocalPhoto {
  id: string;
  url: string;
  sort_order: number;
  preview?: string;
  uploading?: boolean;
  error?: string;
}

interface GalleryUploaderProps {
  profileId: string;
  photos: { id: string; url: string; sort_order: number }[];
  onSaved?: () => void;
}

export default function GalleryUploader({ profileId, photos: initialPhotos, onSaved }: GalleryUploaderProps) {
  const [photos, setPhotos] = useState<LocalPhoto[]>(initialPhotos);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    setPhotos(initialPhotos);
  }, [initialPhotos]);

  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function isSupabaseStorageUrl(url: string) {
    return url.includes("/storage/v1/object/public/profile-media/");
  }

  function getStoragePath(url: string): string {
    const marker = "/storage/v1/object/public/profile-media/";
    const idx = url.indexOf(marker);
    if (idx === -1) return "";
    return decodeURIComponent(url.slice(idx + marker.length).split("?")[0]);
  }

  async function uploadFile(file: File, sortOrder: number) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return { error: "Only JPEG, PNG, WebP, or GIF allowed." };
    }
    if (file.size > MAX_SIZE_BYTES) {
      return { error: "File must be under 3 MB." };
    }

    const uuid = crypto.randomUUID();
    const path = `${profileId}/gallery/${uuid}.webp`;
    const preview = URL.createObjectURL(file);
    blobUrlsRef.current.push(preview);
    const tempId = `temp-${uuid}`;

    setPhotos((prev) => [
      ...prev,
      { id: tempId, url: "", sort_order: sortOrder, preview, uploading: true },
    ]);

    const { error: storageError } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });

    if (storageError) {
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === tempId ? { ...p, uploading: false, error: storageError.message } : p
        )
      );
      return { error: storageError.message };
    }

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);

    const { data: inserted, error: dbError } = await supabase
      .from("profile_photos")
      .insert({ profile_id: profileId, url: publicUrl, sort_order: sortOrder })
      .select("id, url, sort_order")
      .single();

    if (dbError || !inserted) {
      await supabase.storage.from(BUCKET).remove([path]);
      setPhotos((prev) => prev.filter((p) => p.id !== tempId));
      return { error: dbError?.message ?? "Failed to save photo." };
    }

    const row = inserted as { id: string; url: string; sort_order: number };
    setPhotos((prev) =>
      prev.map((p) => (p.id === tempId ? { id: row.id, url: row.url, sort_order: row.sort_order } : p))
    );
    onSaved?.();
    return { error: null };
  }

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    const confirmed = photos.filter((p) => !p.uploading && !p.error);
    const slots = MAX_PHOTOS - confirmed.length;
    if (slots <= 0) return;

    let nextSort = confirmed.length;
    for (const file of arr.slice(0, slots)) {
      await uploadFile(file, nextSort++);
    }
  }

  async function deletePhoto(photo: LocalPhoto) {
    if (photo.uploading) return;
    if (photo.error) {
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      return;
    }

    const { error } = await supabase.from("profile_photos").delete().eq("id", photo.id);
    if (error) return;

    if (isSupabaseStorageUrl(photo.url)) {
      const storagePath = getStoragePath(photo.url);
      if (storagePath) await supabase.storage.from(BUCKET).remove([storagePath]);
    }

    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    onSaved?.();
  }

  async function movePhoto(index: number, direction: "up" | "down") {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= photos.length) return;

    const next = [...photos];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    const updated = next.map((p, i) => ({ ...p, sort_order: i }));
    setPhotos(updated);

    await Promise.all([
      supabase.from("profile_photos").update({ sort_order: updated[index].sort_order }).eq("id", updated[index].id),
      supabase.from("profile_photos").update({ sort_order: updated[swapIndex].sort_order }).eq("id", updated[swapIndex].id),
    ]);
    onSaved?.();
  }

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [photos]
  );

  const confirmed = photos.filter((p) => !p.error);
  const canAdd = confirmed.length < MAX_PHOTOS;

  return (
    <div style={{ fontFamily: FONT_BODY }}>
      {/* Photo grid */}
      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          {photos.map((photo, i) => {
            const imgSrc = photo.preview ?? photo.url;
            return (
              <div
                key={photo.id}
                style={{
                  position: "relative",
                  borderRadius: 10,
                  overflow: "hidden",
                  border: `1px solid ${photo.error ? "#e53e3e" : "var(--border)"}`,
                  background: "var(--bg)",
                  aspectRatio: "1",
                }}
              >
                {imgSrc && (
                  <img
                    src={imgSrc}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                )}

                {/* Uploading overlay */}
                {photo.uploading && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0,0,0,0.5)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>Uploading…</span>
                  </div>
                )}

                {/* Error overlay */}
                {photo.error && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(229,62,62,0.85)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 6,
                    }}
                  >
                    <span style={{ color: "#fff", fontSize: 10, textAlign: "center" }}>{photo.error}</span>
                  </div>
                )}

                {/* Controls overlay */}
                {!photo.uploading && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "4px 6px",
                      background: "rgba(0,0,0,0.55)",
                      gap: 2,
                    }}
                  >
                    <div style={{ display: "flex", gap: 2 }}>
                      <button
                        disabled={i === 0}
                        onClick={() => movePhoto(i, "up")}
                        title="Move left"
                        style={arrowBtn(i === 0)}
                      >
                        ‹
                      </button>
                      <button
                        disabled={i === photos.length - 1}
                        onClick={() => movePhoto(i, "down")}
                        title="Move right"
                        style={arrowBtn(i === photos.length - 1)}
                      >
                        ›
                      </button>
                    </div>
                    <button
                      onClick={() => deletePhoto(photo)}
                      title="Remove"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#ff6b6b",
                        fontSize: 14,
                        lineHeight: 1,
                        padding: "2px 4px",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Drop zone */}
      {canAdd && (
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? ACCENT : "var(--border)"}`,
            borderRadius: 12,
            padding: "20px 16px",
            textAlign: "center",
            cursor: "pointer",
            background: dragOver ? "rgba(245,166,35,0.06)" : "var(--bg)",
            transition: "border-color 0.15s, background 0.15s",
          }}
        >
          <div style={{ fontSize: 22, marginBottom: 6, opacity: 0.5 }}>📷</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
            Drop photos here or click to upload
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            JPEG, PNG, WebP, GIF · Max 3 MB · {MAX_PHOTOS - confirmed.length} slot{MAX_PHOTOS - confirmed.length !== 1 ? "s" : ""} left
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_TYPES.join(",")}
            multiple
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files) { handleFiles(e.target.files); e.target.value = ""; } }}
          />
        </div>
      )}

      {!canAdd && (
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
          Maximum {MAX_PHOTOS} photos reached. Remove one to add another.
        </p>
      )}
    </div>
  );
}

function arrowBtn(disabled: boolean): React.CSSProperties {
  return {
    background: "none",
    border: "none",
    cursor: disabled ? "default" : "pointer",
    color: disabled ? "rgba(255,255,255,0.3)" : "#fff",
    fontSize: 16,
    lineHeight: 1,
    padding: "2px 4px",
    fontWeight: 700,
  };
}
