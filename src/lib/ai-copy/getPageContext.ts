import type { PageContext } from "./types";
import { readCached, writeCached } from "./cache";

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function titleFromUrl(raw: string): PageContext {
  try {
    const url = new URL(raw);
    const slug = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const title = slug
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      pageTitle: title || url.hostname.replace(/^www\./, ""),
      domain: url.hostname.replace(/^www\./, ""),
      source: "url",
    };
  } catch {
    return { source: "none" };
  }
}

export async function getPageContext(destinationUrl: string): Promise<PageContext> {
  const normalized = normalizeUrl(destinationUrl);
  if (!normalized) return { source: "none" };
  const cached = readCached<PageContext>("page", normalized, 7 * 24 * 60 * 60 * 1000);
  if (cached) return { ...cached, source: "cached" };

  const fallback = titleFromUrl(normalized);
  writeCached("page", normalized, fallback);
  return fallback;
}
