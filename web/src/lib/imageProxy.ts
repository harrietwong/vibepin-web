/**
 * Resolve stored image URLs to a browser-loadable src.
 *
 * Draft/generated media is private. Always resolve owned storage objects to the
 * authenticated proxy; never turn a protected proxy back into a permanent public URL.
 */

function studioFilenameFromUrl(url: string): string | null {
  try {
    const configured = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "" : "";
    const parsed = new URL(url);
    if (!configured || parsed.origin !== new URL(configured).origin || parsed.search || parsed.hash) return null;
    const marker = "/storage/v1/object/generated-private/";
    const publicMarker = "/storage/v1/object/public/generated-private/";
    const prefix = parsed.pathname.startsWith(publicMarker) ? publicMarker : marker;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(parsed.pathname.slice(prefix.length));
    return path.startsWith("studio/") ? path.slice("studio/".length) : null;
  } catch { /* relative paths handled below */ }
  if (url.startsWith("studio/") && /\.(png|jpe?g|webp|gif|avif)$/i.test(url)) {
    return url.slice("studio/".length);
  }
  return null;
}

function proxyStorageUrl(filename: string): string {
  return `/api/storage-image?path=${encodeURIComponent(`studio/${filename}`)}`;
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

  // Protected proxy path must remain protected.
  if (url.startsWith("/api/storage-image") || url.includes("/api/storage-image?")) {
    return url;
  }

  const filename = studioFilenameFromUrl(url);
  if (filename) return proxyStorageUrl(filename);

  if (url.startsWith("/")) return url;

  return url;
}
