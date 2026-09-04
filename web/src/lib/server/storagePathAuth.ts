export type StudioStoragePathAuthorization =
  | { ok: true; path: string; scope: "owned-upload" | "legacy-job" }
  | { ok: false; status: 400 | 403 };

const INVALID_PATH_CHARACTER = /[\\%\u0000-\u001f\u007f]/;

export function authorizeStudioStoragePath(
  path: string,
  userId: string,
): StudioStoragePathAuthorization {
  if (
    !path
    || !userId
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("//")
    || path.includes("..")
    || INVALID_PATH_CHARACTER.test(path)
  ) {
    return { ok: false, status: 400 };
  }

  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    return { ok: false, status: 400 };
  }

  if (segments[0] !== "studio") {
    return { ok: false, status: 400 };
  }

  if (segments.length === 2) {
    return { ok: true, path, scope: "legacy-job" };
  }

  if (segments[1] !== "uploads" || segments.length < 4) {
    return { ok: false, status: 400 };
  }

  if (segments[2] !== userId) {
    return { ok: false, status: 403 };
  }

  return { ok: true, path, scope: "owned-upload" };
}

type GenerationJobResult = {
  status?: unknown;
  imageUrl?: unknown;
};

type GenerationJobRow = {
  results?: unknown;
};

export function pathFromGeneratedImageUrl(value: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string | null {
  try {
    if (value.startsWith("/api/storage-image?")) {
      const parsed = new URL(value, "https://vibepin.invalid");
      if (
        parsed.origin !== "https://vibepin.invalid"
        || parsed.pathname !== "/api/storage-image"
        || parsed.hash
        || [...parsed.searchParams.keys()].some(key => key !== "path")
        || parsed.searchParams.getAll("path").length !== 1
      ) return null;
      return parsed.searchParams.get("path");
    }

    const configured = new URL(supabaseUrl);
    const parsed = new URL(value);
    if (parsed.origin !== configured.origin || parsed.search || parsed.hash) return null;
    const prefixes = [
      "/storage/v1/object/public/generated/",
      "/storage/v1/object/generated/",
      "/storage/v1/object/public/generated-private/",
      "/storage/v1/object/generated-private/",
    ];
    const prefix = prefixes.find(candidate => parsed.pathname.startsWith(candidate));
    return prefix ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : null;
  } catch {
    return null;
  }
}

/** Parse only exact-origin Supabase object URLs or the exact app proxy route. */
export function canonicalStorageReference(value: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""):
  { bucket: string; path: string; legacy: boolean } | null {
  try {
    const appBase = "https://vibepin.invalid";
    const parsed = new URL(value, appBase);
    if (
      parsed.origin === appBase
      && parsed.pathname === "/api/storage-image"
      && !parsed.hash
      && parsed.searchParams.getAll("path").length === 1
      && [...parsed.searchParams.keys()].every(key => key === "path")
    ) {
      const path = parsed.searchParams.get("path");
      return path ? { bucket: process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private", path, legacy: false } : null;
    }
    const configured = new URL(supabaseUrl);
    const parsedHost = parsed.hostname.replace(/\.$/, "").toLowerCase();
    const configuredHost = configured.hostname.replace(/\.$/, "").toLowerCase();
    // Any HTTP(S) spelling of the configured Storage host remains protected:
    // fragments are client-only, and http/default-port variants may redirect to
    // the same signed object without changing its bucket/path identity.
    if (!/^https?:$/.test(parsed.protocol) || !parsedHost || parsedHost !== configuredHost) return null;
    const match = parsed.pathname.match(/^\/storage\/v1\/(?:object|render\/image)\/(?:(?:public|authenticated|sign)\/)?([^/]+)\/(.+)$/);
    if (!match) return null;
    return { bucket: match[1], path: decodeURIComponent(match[2]), legacy: match[1] === "generated" };
  } catch { return null; }
}

export function generationJobImageUrls(row: GenerationJobRow): string[] {
  if (!Array.isArray(row.results)) return [];

  return row.results.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const result = item as GenerationJobResult;
    return result.status === "done" && typeof result.imageUrl === "string" && result.imageUrl
      ? [result.imageUrl]
      : [];
  });
}

export function generationJobImageProxyUrls(
  row: GenerationJobRow,
  userId: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
): string[] {
  return [...new Set(generationJobImageUrls(row).flatMap(url => {
    const ref = canonicalStorageReference(url, supabaseUrl);
    if (!ref) return [];
    if (ref.legacy) {
      // Legacy compatibility is deliberately narrower than private-media
      // classification: only the canonical public object URL is retained.
      try {
        const parsed = new URL(url);
        const configured = new URL(supabaseUrl);
        if (parsed.origin !== configured.origin || parsed.search || parsed.hash) return [];
      } catch { return []; }
      return [url]; // exact-origin legacy public object remains legacy debt
    }
    if (ref.bucket !== (process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private")) return [];
    if (!authorizeStudioStoragePath(ref.path, userId).ok) return [];
    return [`/api/storage-image?path=${encodeURIComponent(ref.path)}`];
  }))];
}

/**
 * Legacy `studio/<file>` objects pre-date owner-scoped upload paths. They may be
 * served only when a service-role-only generation_jobs row for this exact user
 * proves that the worker produced the requested object. Client-writable draft or
 * history payloads are deliberately not accepted as ownership evidence.
 */
export function ownedGenerationJobsContainPath(
  rows: readonly GenerationJobRow[],
  requestedPath: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
): boolean {
  return rows.some(row => generationJobImageUrls(row).some(url =>
    pathFromGeneratedImageUrl(url, supabaseUrl) === requestedPath,
  ));
}
