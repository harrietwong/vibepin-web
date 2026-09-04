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
    ];
    const prefix = prefixes.find(candidate => parsed.pathname.startsWith(candidate));
    return prefix ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : null;
  } catch {
    return null;
  }
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
    const path = pathFromGeneratedImageUrl(url, supabaseUrl);
    if (!path || !authorizeStudioStoragePath(path, userId).ok) return [];
    return [`/api/storage-image?path=${encodeURIComponent(path)}`];
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
