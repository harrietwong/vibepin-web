/**
 * amazonLink.ts — pure parsing / normalisation for Amazon links a user pastes into a
 * Pin's Website URL. No network (short-link expansion lives server-side in
 * productUrlImport/amazonShortLink.ts).
 *
 * Product rules (Fable rulings 2026-09-24, design §1):
 *  - Host decisions are exact-match on the parsed hostname (amazonHosts.ts).
 *  - A pasted affiliate link is only ever ADDED to, never stripped of attribution:
 *    `tag`, `linkCode`, `linkId` (and `ascsubtag`) are always kept (ruling 2).
 *    Only an explicit list of non-attribution tracking junk is removed.
 *  - The pasted URL is never silently replaced: callers get a SUGGESTION to show as a
 *    chip, the user clicks to accept (ruling 6).
 *  - The marketplace comes from the link's own host, never from Settings, and the host
 *    is never rewritten across marketplaces (tags are per-marketplace).
 */

import { extractAsinFromUrl, type AmazonMarketplace } from "./amazon";
import type { AmazonAffiliateSettings } from "./amazonAffiliateSettings";
import { classifyAmazonHost, isOtherAmazonSubdomain } from "./amazonHosts";

export {
  AMAZON_RETAIL_HOSTS,
  AMAZON_SHORT_HOSTS,
  AMAZON_FETCHABLE_RETAIL_HOSTS,
  AMAZON_FETCHABLE_SHORT_HOSTS,
  classifyAmazonHost,
  type AmazonHostClass,
} from "./amazonHosts";

/** Longest input we will even try to parse. */
export const MAX_AMAZON_URL_LENGTH = 2048;

/** Associates tracking ID shape (e.g. `harriet-20`). */
export const AMAZON_TAG_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Query params removed during normalisation: search/navigation tracking that carries
 * no affiliate attribution. Everything NOT listed here is kept (unknown ≠ junk).
 * NOTE: `th`/`psc` (variant selectors) are intentionally KEPT per design §1.4 — the
 * ruling-2 wording lists them as junk; flagged for a one-word decision. Flipping is a
 * one-line change to this set.
 */
export const AMAZON_DROP_PARAMS: ReadonlySet<string> = new Set([
  "ref", "ref_", "qid", "sr", "keywords", "crid", "sprefix", "dib", "dib_tag",
  "_encoding", "smid", "content-id",
]);
export const AMAZON_DROP_PARAM_PREFIXES: readonly string[] = ["pd_rd_", "pf_rd_"];

/** Attribution params that must survive normalisation verbatim (ruling 2). */
export const AMAZON_ATTRIBUTION_PARAMS: readonly string[] = ["tag", "linkCode", "linkId", "ascsubtag"];

export type AmazonLinkFailReason = "not_amazon" | "invalid_url" | "unsupported_host" | "bad_scheme";

export type AmazonRetailParse = {
  ok: true;
  kind: "retail";
  /** Bare host, e.g. "amazon.co.uk". */
  host: string;
  marketplace: AmazonMarketplace | null;
  asin: string | null;
  /** Valid tag from the URL, or null. */
  tag: string | null;
  /** A `tag` param was present but malformed (dropped from normalizedUrl). */
  tagInvalid: boolean;
  /**
   * `https://www.<host>/dp/<ASIN>?<kept params>` when an ASIN was found; otherwise the
   * original link, only upgraded to https (not rebuilt — design §1.4 "no_asin").
   */
  normalizedUrl: string;
  droppedParams: string[];
};

export type AmazonShortParse = { ok: true; kind: "short"; host: string; shortUrl: string };

export type AmazonLinkParse =
  | AmazonRetailParse
  | AmazonShortParse
  | { ok: false; reason: AmazonLinkFailReason };

function isDropped(key: string): boolean {
  const k = key.toLowerCase();
  if (AMAZON_ATTRIBUTION_PARAMS.some(a => a.toLowerCase() === k)) return false;
  return AMAZON_DROP_PARAMS.has(k) || AMAZON_DROP_PARAM_PREFIXES.some(p => k.startsWith(p));
}

/**
 * Parse a pasted Amazon link. Never throws. Scheme-less input ("amazon.com/dp/…") is
 * read as https; http is upgraded; any other scheme is `bad_scheme`.
 */
export function parseAmazonLink(raw: string | null | undefined): AmazonLinkParse {
  const input = (raw ?? "").trim();
  if (!input || input.length > MAX_AMAZON_URL_LENGTH || /\s/.test(input)) return { ok: false, reason: "invalid_url" };

  const schemeMatch = input.match(/^([a-z][a-z\d+.-]*):/i);
  let withScheme = input;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    // "amazon.com:443/…" style would look like a scheme; only treat known forms as one.
    if (scheme !== "http" && scheme !== "https") {
      if (input.includes("://") || !/^[a-z0-9.-]+:\d+/i.test(input)) return { ok: false, reason: "bad_scheme" };
      withScheme = `https://${input}`;
    }
  } else {
    withScheme = `https://${input.replace(/^\/\//, "")}`;
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "bad_scheme" };
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };

  const cls = classifyAmazonHost(url.hostname);
  if (!cls) {
    return { ok: false, reason: isOtherAmazonSubdomain(url.hostname) ? "unsupported_host" : "not_amazon" };
  }
  const defaultPort = (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
  if (url.port && !defaultPort) return { ok: false, reason: "unsupported_host" };

  if (cls.kind === "short") {
    return { ok: true, kind: "short", host: cls.host, shortUrl: `https://${cls.host}${url.pathname}${url.search}` };
  }

  const asin = extractAsinFromUrl(url);
  const rawTag = url.searchParams.get("tag");
  const tag = rawTag !== null && AMAZON_TAG_RE.test(rawTag) ? rawTag : null;
  const tagInvalid = rawTag !== null && tag === null;

  const dropped: string[] = [];
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (key === "tag" && tagInvalid) { dropped.push(key); continue; }
    if (isDropped(key)) { if (!dropped.includes(key)) dropped.push(key); continue; }
    kept.push([key, value]);
  }

  let normalizedUrl: string;
  if (asin) {
    if (/\/ref=/i.test(url.pathname) && !dropped.includes("ref")) dropped.push("ref");
    const qs = new URLSearchParams(kept).toString();
    normalizedUrl = `https://www.${cls.host}/dp/${asin}${qs ? `?${qs}` : ""}`;
  } else {
    // Not a product page (search, store, …): keep the link as pasted, https only.
    const keep = new URL(url.href);
    keep.protocol = "https:";
    keep.port = "";
    normalizedUrl = keep.href;
    dropped.length = 0;
  }

  return {
    ok: true,
    kind: "retail",
    host: cls.host,
    marketplace: cls.marketplace,
    asin,
    tag,
    tagInvalid,
    normalizedUrl,
    droppedParams: dropped,
  };
}

export type AmazonLinkWarning =
  /** URL tag present, Settings has no default → offer "save T as default?" (non-blocking). */
  | "suggest_save_tag"
  /** URL tag differs from the Settings default — we keep the URL's tag. */
  | "tag_differs_from_default"
  /** Settings tag belongs to another marketplace (or host marketplace unknown) — not applied. */
  | "marketplace_mismatch"
  /** No usable tag anywhere — link earns no commission. Never blocks generate/publish. */
  | "no_tag_no_commission"
  /** A `tag` param was present but malformed; treated as no tag. */
  | "invalid_tag"
  /** Retail link without a product ASIN (search/store page). */
  | "no_asin";

export type AffiliateDestination = {
  url: string;
  tagSource: "url" | "settings" | "none";
  warnings: AmazonLinkWarning[];
};

/**
 * Decide the destination for a parsed retail link (design §1.3 tag-priority table).
 * The URL's own tag always wins and is never rewritten; the Settings tag is only
 * appended when the link has none AND the link host's marketplace equals the
 * Settings marketplace.
 */
export function resolveAffiliateDestination(
  p: AmazonRetailParse,
  settings: Pick<AmazonAffiliateSettings, "trackingId" | "marketplace"> | null | undefined,
): AffiliateDestination {
  const warnings: AmazonLinkWarning[] = [];
  if (p.tagInvalid) warnings.push("invalid_tag");
  if (!p.asin) warnings.push("no_asin");

  const settingsTag = (settings?.trackingId ?? "").trim();
  const usableSettingsTag = AMAZON_TAG_RE.test(settingsTag) ? settingsTag : "";

  if (p.tag) {
    if (!usableSettingsTag) warnings.push("suggest_save_tag");
    else if (usableSettingsTag !== p.tag) warnings.push("tag_differs_from_default");
    return { url: p.normalizedUrl, tagSource: "url", warnings };
  }

  if (usableSettingsTag) {
    if (p.marketplace !== null && p.marketplace === settings?.marketplace) {
      const out = new URL(p.normalizedUrl);
      out.searchParams.set("tag", usableSettingsTag);
      return { url: out.href, tagSource: "settings", warnings };
    }
    warnings.push("marketplace_mismatch");
    return { url: p.normalizedUrl, tagSource: "none", warnings };
  }

  warnings.push("no_tag_no_commission");
  return { url: p.normalizedUrl, tagSource: "none", warnings };
}

export type AmazonLinkSuggestion = {
  /** The user's input, untouched. */
  pastedUrl: string;
  /** What the chip offers. Written to the field ONLY when the user accepts. */
  suggestedUrl: string;
  tagSource: AffiliateDestination["tagSource"];
  warnings: AmazonLinkWarning[];
  droppedParams: string[];
  /** True when the suggestion differs from what was pasted (i.e. a chip is worth showing). */
  changed: boolean;
};

/**
 * Chip input for a pasted retail link (ruling 6: suggest, never silently replace).
 * Returns null for non-Amazon, invalid, and short links (short links need the
 * server-side expansion first; feed the expanded retail URL back in here).
 */
export function suggestAmazonLinkNormalization(
  raw: string | null | undefined,
  settings: Pick<AmazonAffiliateSettings, "trackingId" | "marketplace"> | null | undefined,
): AmazonLinkSuggestion | null {
  const parsed = parseAmazonLink(raw);
  if (!parsed.ok || parsed.kind !== "retail") return null;
  const dest = resolveAffiliateDestination(parsed, settings);
  const pastedUrl = (raw ?? "").trim();
  return {
    pastedUrl,
    suggestedUrl: dest.url,
    tagSource: dest.tagSource,
    warnings: dest.warnings,
    droppedParams: parsed.droppedParams,
    changed: dest.url !== pastedUrl,
  };
}
