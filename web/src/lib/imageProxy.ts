/**
 * Resolve stored image URLs to a browser-loadable src.
 *
 * The "generated" bucket is public — prefer the Supabase public object URL
 * directly so images load in the browser without going through /api/storage-image
 * (which can 502 in local dev when the server-side fetch to Supabase fails).
 *
 * Falls back to the proxy route for edge cases (relative paths, legacy entries).
 */

const SUPABASE_URL =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
    : "";

const PUBLIC_MARKER  = "/storage/v1/object/public/generated/studio/";
const AUTH_MARKER    = "/storage/v1/object/generated/studio/";

function studioFilenameFromUrl(url: string): string | null {
  for (const marker of [PUBLIC_MARKER, AUTH_MARKER]) {
    const idx = url.indexOf(marker);
    if (idx !== -1) {
      return url.slice(idx + marker.length).split("?")[0] || null;
    }
  }
  if (url.startsWith("studio/") && /\.(png|jpe?g|webp)$/i.test(url)) {
    return url.slice("studio/".length);
  }
  return null;
}

function publicStorageUrl(filename: string): string {
  if (!SUPABASE_URL) return `/api/storage-image?path=studio/${filename}`;
  return `${SUPABASE_URL}/storage/v1/object/public/generated/studio/${filename}`;
}

/**
 * Display-only thumbnail URL. Resolves like {@link toProxyUrl}, then — for
 * Pinterest-hosted images — swaps the multi-MB `originals/` asset for a
 * pre-generated size variant (`236x`/`474x`/`736x`). Pinterest always renders
 * these variants, and at tile/hover-card sizes they're visually identical while
 * downloading ~10–50× faster.
 *
 * IMPORTANT: use this ONLY for on-screen previews, never for the stored
 * `imageUrl` or the publish payload — the published Pin must keep full res.
 */
export function toThumbUrl(url: string, size: "236x" | "474x" | "736x" = "736x"): string {
  const resolved = toProxyUrl(url);
  return resolved.replace(/(\/\/i\.pinimg\.com\/)originals\//, `$1${size}/`);
}

export function toProxyUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  // Legacy proxy path → convert to direct public URL
  if (url.startsWith("/api/storage-image") || url.includes("/api/storage-image?")) {
    try {
      const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      const path = new URLSearchParams(qs).get("path");
      if (path?.startsWith("studio/")) {
        const filename = path.slice("studio/".length);
        if (filename) return publicStorageUrl(filename);
      }
    } catch { /* fall through */ }
    return url;
  }

  const filename = studioFilenameFromUrl(url);
  if (filename) return publicStorageUrl(filename);

  if (url.startsWith("/")) return url;

  return url;
}
