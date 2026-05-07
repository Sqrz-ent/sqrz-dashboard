// Inline image attachment renderer for message bubbles.
// Displays a thumbnail (max 200px wide) that opens the full image in a new tab.

interface MessageAttachmentProps {
  url: string;
  fallback?: string;
}

export default function MessageAttachment({ url, fallback }: MessageAttachmentProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: "block", marginTop: 6 }}
      title={fallback ?? "Image attachment"}
    >
      <img
        src={url}
        alt={fallback ?? "Image attachment"}
        style={{
          display: "block",
          maxWidth: 200,
          maxHeight: 260,
          width: "auto",
          height: "auto",
          borderRadius: 8,
          border: "1px solid var(--border)",
          cursor: "pointer",
          objectFit: "contain",
        }}
      />
    </a>
  );
}
