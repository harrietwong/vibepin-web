const BLOCKED_HOST_SUFFIXES = [
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca", "amazon.com.au",
  "temu.com", "shein.com", "aliexpress.com", "aliexpress.us",
  "instagram.com", "tiktok.com", "tiktokshop.com",
];

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

export function isBlockedMarketplace(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return BLOCKED_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (h.includes(":")) {
    if (h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd")) return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_IPV4.test(h);
  return false;
}

export function validateImportUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Empty URL" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are supported" };
  }

  if (isPrivateOrLocalHost(url.hostname)) {
    return { ok: false, error: "Internal or localhost URLs are not allowed" };
  }

  if (isBlockedMarketplace(url.hostname)) {
    return { ok: false, error: "This marketplace is not supported for URL import" };
  }

  return { ok: true, url };
}

export function sourceDomainFromUrl(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

export function isDirectImageUrl(url: URL): boolean {
  return /\.(jpe?g|png|webp)(\?.*)?$/i.test(url.pathname);
}
