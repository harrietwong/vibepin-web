/**
 * Server-side validation for publish payloads. Pinterest must be able to fetch
 * the image over the public internet, so localhost / blob / data / private hosts
 * are rejected. All validation runs server-side — never trust the client.
 */

export type PublishValidationError = { field: string; message: string };

const PRIVATE_HOST_RE =
  /^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]|172\.(1[6-9]|2\d|3[0-1])\.)/i;

/** Validate that a URL is a public https?: URL Pinterest's servers can reach. */
export function validatePublicImageUrl(raw: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, message: "imageUrl is required" };
  }
  const value = raw.trim();

  if (value.startsWith("data:") || value.startsWith("blob:")) {
    return { ok: false, message: "imageUrl must be a public URL, not a data:/blob: URL" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "imageUrl is not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "imageUrl must use http(s)" };
  }
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    return { ok: false, message: "imageUrl host is not publicly reachable (localhost/private network)" };
  }
  // Hostnames must be fully-qualified so Pinterest can resolve them.
  if (!url.hostname.includes(".")) {
    return { ok: false, message: "imageUrl host is not a public domain" };
  }
  return { ok: true, url: url.toString() };
}

/** Optional destination/link URL: when present, must be a valid public http(s) URL. */
export function validateOptionalLink(raw: unknown): { ok: true; url: string | undefined } | { ok: false; message: string } {
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    return { ok: true, url: undefined };
  }
  if (typeof raw !== "string") return { ok: false, message: "link must be a string" };
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "link is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "link must use http(s)" };
  }
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    return { ok: false, message: "link host is not publicly reachable" };
  }
  return { ok: true, url: url.toString() };
}
