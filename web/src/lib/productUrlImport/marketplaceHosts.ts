import type { MarketplaceId, RawCandidate } from "./types";

/**
 * FR-04: recognise the four marketplaces that get a manual-entry fallback card
 * instead of a plain "not supported" failure. Pure hostname classification, no
 * network. Country subdomains (e.g. `m.tiktok.com`, `www.aliexpress.us`) match via
 * the same suffix logic as `isBlockedMarketplace`. `tiktok.com` and `tiktokshop.com`
 * both classify as `tiktok_shop` — TikTok Shop listings are reachable from either
 * host and the PRD names only Instagram (a different property) as the carve-out.
 * Returns null for everything else, including Instagram (not a marketplace — stays
 * a generic `failed` result) and Amazon (its own text-only channel).
 *
 * Lives in its own module (not urlSecurity.ts) because the Studio card imports it in
 * the browser bundle; urlSecurity.ts pulls in `node:net` and the fetch-og DNS guard
 * (`node:dns/promises`), which a client chunk cannot contain.
 */
export function classifyManualMarketplace(hostname: string): MarketplaceId | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const matches = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  if (matches("temu.com")) return "temu";
  if (matches("shein.com")) return "shein";
  if (matches("aliexpress.com") || matches("aliexpress.us")) return "aliexpress";
  if (matches("tiktok.com") || matches("tiktokshop.com")) return "tiktok_shop";
  return null;
}

const MAX_SUGGESTED_TITLE = 150;

/** Trailing product-id segment each marketplace appends to its slug, stripped before
 *  title-casing so the id never leaks into the suggested name. */
const TRAILING_ID_SUFFIX: Record<MarketplaceId, RegExp | null> = {
  temu:        /-g-\d+$/,
  shein:       /-p-\d+$/,
  aliexpress:  null, // /item/<digits>.html has no slug segment at all
  tiktok_shop: null, // /pdp/<slug>/<id> — the id is its own path segment, not a suffix
};

/**
 * Last path segment, `.html` stripped, decoded. Never throws on a malformed percent
 * sequence. Empty/absent segments return null.
 */
function lastPathSegment(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1].replace(/\.html?$/i, "");
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** `some-slug-here` / `Some_Slug_Here` → `Some slug here` (first letter capitalised
 *  only — the rest keeps whatever casing the slug already had, e.g. Shein's mixed
 *  case). Collapses repeated separators/whitespace. Caps at 150 chars. */
function titleFromSlug(slug: string): string | null {
  const spaced = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return null;
  const capitalised = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return capitalised.slice(0, MAX_SUGGESTED_TITLE);
}

function suggestedTitleForTemuOrShein(marketplace: "temu" | "shein", url: URL): string | null {
  const segment = lastPathSegment(url.pathname);
  if (!segment) return null;
  const suffix = TRAILING_ID_SUFFIX[marketplace];
  const withoutId = suffix ? segment.replace(suffix, "") : segment;
  return titleFromSlug(withoutId);
}

function suggestedTitleForTikTokShop(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  // /product/<slug> — the whole trailing segment is the slug, no numeric id to strip.
  const productIdx = parts.indexOf("product");
  if (productIdx !== -1 && parts[productIdx + 1]) {
    return titleFromSlug(decodeURIComponent(parts[productIdx + 1]).replace(/\.html?$/i, ""));
  }
  // /pdp/<slug>/<id> — id is its own segment, drop it before titlecasing the slug.
  const pdpIdx = parts.indexOf("pdp");
  if (pdpIdx !== -1 && parts[pdpIdx + 1]) {
    return titleFromSlug(decodeURIComponent(parts[pdpIdx + 1]).replace(/\.html?$/i, ""));
  }
  return null;
}

function suggestedTitleFor(marketplace: MarketplaceId, url: URL): string | undefined {
  let title: string | null;
  switch (marketplace) {
    case "temu":
    case "shein":
      title = suggestedTitleForTemuOrShein(marketplace, url);
      break;
    case "tiktok_shop":
      title = suggestedTitleForTikTokShop(url);
      break;
    case "aliexpress":
      title = null; // /item/<digits>.html carries no slug to derive a name from
      break;
  }
  return title ?? undefined;
}

const KWCDN_IMAGE_PATH_RE = /\.(jpe?g|png|webp)$/i;

/**
 * Only Temu's `top_gallery_url` query param is trusted as a direct image URL — it is
 * the image the user's own browser was already showing when they copied the link, so
 * reading it back out of the pasted URL is not a fetch of anything. Must be `https:`,
 * host must be `img.kwcdn.com` or any `*.kwcdn.com` subdomain, and the path must end
 * in a plain image extension — otherwise it is dropped, never guessed at.
 */
function trustedImageUrlFor(marketplace: MarketplaceId, url: URL): string | undefined {
  if (marketplace !== "temu") return undefined;
  const raw = url.searchParams.get("top_gallery_url");
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host !== "img.kwcdn.com" && !host.endsWith(".kwcdn.com")) return undefined;
  if (!KWCDN_IMAGE_PATH_RE.test(parsed.pathname)) return undefined;
  return parsed.toString();
}

export type MarketplaceUrlHints = {
  /** Derived from the pasted URL's own slug. Never returned as an empty string —
   *  absent means "could not derive one", not "derived an empty title". */
  suggestedTitle?: string;
  /** Only ever set for Temu, and only from its own `top_gallery_url` query param
   *  (never fetched — the value is read straight out of the pasted URL). */
  imageUrl?: string;
};

/**
 * FR-04 follow-up (0925 real-user report): the four manual-entry marketplaces still
 * put useful information in the URL itself — a readable product-name slug, and (Temu
 * only) a direct CDN image URL the site embeds as a query param for its own share
 * links. Reading these back out of the pasted URL is zero network calls: nothing here
 * ever contacts temu.com, shein.com, kwcdn.com, or any other host.
 */
export function hintsFromMarketplaceUrl(url: URL, marketplace: MarketplaceId): MarketplaceUrlHints {
  const suggestedTitle = suggestedTitleFor(marketplace, url);
  const imageUrl = trustedImageUrlFor(marketplace, url);
  return { ...(suggestedTitle ? { suggestedTitle } : {}), ...(imageUrl ? { imageUrl } : {}) };
}

/** One `RawCandidate` for the trusted direct image URL, or none. Shaped so the caller
 *  can hand it straight to `finalizeCandidates`/`toProductCandidates` like every other
 *  provider's raw candidates. */
export function marketplaceImageCandidates(hints: MarketplaceUrlHints): RawCandidate[] {
  return hints.imageUrl ? [{ imageUrl: hints.imageUrl, score: 0.7, reason: "direct_image_url" }] : [];
}
