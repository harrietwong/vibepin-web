/**
 * Lightweight image preloader. Warms the browser cache for a single image URL so a
 * component that mounts shortly after (e.g. the hover preview card, opened ~200ms
 * after pointer-enter) shows the decoded image immediately instead of a blank flash.
 *
 * Module-level de-duplication: a URL is fetched at most once; concurrent callers
 * share the same in-flight promise; already-loaded URLs resolve synchronously.
 * Never throws — a failed preload just resolves so the real <img> can retry/fallback.
 */

const preloaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

/** True once the URL has been successfully preloaded this session. */
export function isImagePreloaded(src: string): boolean {
  return preloaded.has(src);
}

export function preloadImage(src: string): Promise<void> {
  if (!src || typeof window === "undefined" || typeof Image === "undefined") return Promise.resolve();
  if (preloaded.has(src)) return Promise.resolve();
  const existing = loading.get(src);
  if (existing) return existing;

  const p = new Promise<void>(resolve => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { preloaded.add(src); loading.delete(src); resolve(); };
    img.onerror = () => { loading.delete(src); resolve(); }; // don't crash; allow <img> fallback
    img.src = src;
  });
  loading.set(src, p);
  return p;
}
