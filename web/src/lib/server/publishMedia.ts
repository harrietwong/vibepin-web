import { canonicalStorageReference } from "./storagePathAuth";

export function requiresPublishAsset(mediaUrl: string, requestOrigin: string): boolean {
  const value = mediaUrl.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value, requestOrigin);
    if (parsed.origin === requestOrigin && (parsed.pathname === "/api/storage-image" || parsed.pathname === "/api/storage-media")) return true;
    const ref = canonicalStorageReference(value);
    return Boolean(ref && ref.bucket === (process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private"));
  } catch {
    return false;
  }
}
