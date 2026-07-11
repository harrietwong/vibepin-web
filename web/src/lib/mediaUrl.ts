/**
 * mediaUrl.ts — dependency-free predicates for locally-scoped image URLs.
 *
 * Extracted from mediaOffload so the image-bearing stores (productLibrary, asset,
 * basket) can import these WITHOUT creating a runtime import cycle with mediaOffload
 * (mediaOffload imports those stores' collectors + event names). This module imports
 * nothing.
 */

export function isDataUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("data:");
}

export function isBlobUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("blob:");
}

/** True for any locally-scoped image URL that must never be synced as-is. */
export function isLocalMediaUrl(url: string | null | undefined): boolean {
  return isDataUrl(url) || isBlobUrl(url);
}
