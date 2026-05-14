export function normalizeImageUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;

  let value = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    if (parsed.hostname.includes("dropbox.com")) {
      parsed.hostname = "dl.dropboxusercontent.com";
      parsed.searchParams.delete("dl");
      parsed.searchParams.set("raw", "1");
      return parsed.toString();
    }

    if (parsed.pathname.includes("/storage/v1/object/sign/")) {
      parsed.pathname = parsed.pathname.replace("/storage/v1/object/sign/", "/storage/v1/object/public/");
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }

    if (parsed.pathname.includes("/storage/v1/render/image/public/")) {
      parsed.pathname = parsed.pathname.replace("/storage/v1/render/image/public/", "/storage/v1/object/public/");
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }

    return parsed.toString();
  } catch {
    return null;
  }
}
