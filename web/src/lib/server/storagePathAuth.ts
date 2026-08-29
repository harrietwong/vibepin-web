export type StudioStoragePathAuthorization =
  | { ok: true; path: string }
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
    return { ok: true, path };
  }

  if (segments[1] !== "uploads" || segments.length < 4) {
    return { ok: false, status: 400 };
  }

  if (segments[2] !== userId) {
    return { ok: false, status: 403 };
  }

  return { ok: true, path };
}
