import { useState, useRef, useCallback } from "react";
import { supabase } from "~/lib/supabase.client";

const MAX_SIZE_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const BUCKET = "profile-media";

const FONT_BODY = "'DM Sans', ui-sans-serif, sans-serif";
const ACCENT = "#F5A623";

interface LinkCoverUploaderProps {
  profileId: string;
  linkId: string;
  currentUrl: string | null;
  onSaved?: (url: string | null) => void;
}

export default function LinkCoverUploader({
  profileId,
  linkId,
  currentUrl,
  onSaved,
}: LinkCoverUploaderProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrlRef = useRef<string | null>(null);

  const storagePath = `${profileId}/links/${linkId}.webp`;

  function isSupabaseStorageUrl(url: string) {
    return url.includes("/storage/v1/object/public/profile-media/");
  }

  async function uploadFile(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Only JPEG, PNG, WebP, or GIF allowed.");
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError("File must be under 3 MB.");
      return;
    }

    setError(null);
    setUploading(true);

    // Show local preview immediately
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const blob = URL.createObjectURL(file);
    blobUrlRef.current = blob;
    setPreviewUrl(blob);

    // Upload to storage (upsert — same path always overwrites)
    const { error: storageError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file, { contentType: file.type, upsert: true });

    if (storageError) {
      setPreviewUrl(null);
      setError(storageError.message);
      setUploading(false);
      return;
    }

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

    const { error: dbError } = await supabase
      .from("private_booking_links")
      .update({ cover_image_url: publicUrl })
      .eq("id", linkId);

    if (dbError) {
      // Rollback storage
      await supabase.storage.from(BUCKET).remove([storagePath]);
      setPreviewUrl(null);
      setError(dbError.message);
      setUploading(false);
      return;
    }

    // Clear blob preview — the real URL is now active
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    setPreviewUrl(null);
    setUploading(false);
    onSaved?.(publicUrl);
  }

  async function removeImage() {
    setError(null);
    setUploading(true);

    const { error: dbError } = await supabase
      .from("private_booking_links")
      .update({ cover_image_url: null })
      .eq("id", linkId);

    if (dbError) {
      setError(dbError.message);
      setUploading(false);
      return;
    }

    // Delete from storage only if the current URL is a Supabase URL (i.e. was uploaded, not a pasted URL)
    if (currentUrl && isSupabaseStorageUrl(currentUrl)) {
      await supabase.storage.from(BUCKET).remove([storagePath]);
    }

    setUploading(false);
    onSaved?.(null);
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
      const file = e.dataTransfer.files?.[0];
      if (file) uploadFile(file);
    },
    [profileId, linkId, currentUrl]
  );

  const displayUrl = previewUrl ?? currentUrl;

  return (
    <div style={{ fontFamily: FONT_BODY }}>
      {displayUrl ? (
        // Image preview with replace/remove controls
        <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
          <img
            src={displayUrl}
            alt="Cover"
            style={{ width: "100%", aspectRatio: "16/7", objectFit: "cover", display: "block" }}
          />
          {uploading && (
            <div style={{
              position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>Uploading…</span>
            </div>
          )}
          {!uploading && (
            <div style={{
              position: "absolute", top: 8, right: 8, display: "flex", gap: 6,
            }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Replace image"
                style={overlayBtn}
              >
                Replace
              </button>
              <button
                type="button"
                onClick={removeImage}
                title="Remove image"
                style={{ ...overlayBtn, background: "rgba(229,62,62,0.85)" }}
              >
                Remove
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_TYPES.join(",")}
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { uploadFile(f); e.target.value = ""; } }}
          />
        </div>
      ) : (
        // Empty drop zone
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? ACCENT : "var(--border)"}`,
            borderRadius: 10,
            padding: "18px 16px",
            textAlign: "center",
            cursor: uploading ? "default" : "pointer",
            background: dragOver ? "rgba(245,166,35,0.06)" : "var(--bg)",
            transition: "border-color 0.15s, background 0.15s",
          }}
        >
          {uploading ? (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Uploading…</span>
          ) : (
            <>
              <div style={{ fontSize: 18, opacity: 0.45, marginBottom: 4 }}>🖼️</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
                Drop image or click to upload
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                JPEG, PNG, WebP, GIF · Max 3 MB
              </div>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_TYPES.join(",")}
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { uploadFile(f); e.target.value = ""; } }}
          />
        </div>
      )}
      {error && (
        <p style={{ fontSize: 12, color: "#ef4444", marginTop: 5, marginBottom: 0 }}>{error}</p>
      )}
    </div>
  );
}

const overlayBtn: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 700,
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "'DM Sans', ui-sans-serif, sans-serif",
};
