/**
 * amazonCardSource.ts — the per-card Amazon context (design §1.7, §2.3, §3.2).
 *
 * Pure, no network, no store access. The card persists the result on
 * `PinDraft.amazonSource` (rides the pin_drafts payload; no migration).
 *
 * Invariants:
 *  - `pastedUrl` is the user's input; the Pin's destination stays whatever the user put
 *    in Website URL. Nothing here ever returns a destinationUrl/title/description patch.
 *  - `manual` is user-declared and is NEVER overwritten by a fetch. The one exception
 *    is a first-time prefill of an EMPTY (never-set) Brand box from the page byline,
 *    so the user sees it and keeps it (then it is their declaration, design §3.2).
 *  - A failed fetch never erases an earlier successful extraction.
 *  - Price / availability / rating never enter the copy context.
 */

import type { AmazonMarketplace } from "@/lib/affiliate/amazon";
import { parseAmazonLink } from "@/lib/affiliate/amazonLink";
import type { AmazonImportMeta, MarketplaceId } from "@/lib/productUrlImport/types";
// Client bundle: must not import urlSecurity.ts (node:net + node:dns via fetch-og).
import { classifyManualMarketplace } from "@/lib/productUrlImport/marketplaceHosts";
import type { ProductContext } from "@/lib/ai-copy/types";

export type AmazonCardLinkStatus = "ok" | "no_asin" | "short_unexpanded" | "not_amazon" | "marketplace";
export type AmazonCardFetchStatus = "not_attempted" | "ok" | "blocked" | "failed" | "manual_only";

export type AmazonCardManual = {
  productName?: string;
  /** One selling point per line. */
  sellingPoints?: string;
  /** Structured declarations (ruling 9) — mapped exactly like the Shopify fields. */
  brand?: string;
  material?: string;
  /** Size / quantity, e.g. "40 oz". */
  size?: string;
};

export type AmazonCardSource = {
  version: 1;
  /** User's input, never rewritten. */
  pastedUrl: string;
  linkStatus: AmazonCardLinkStatus;
  host?: string;
  marketplace?: AmazonMarketplace | string | null;
  asin?: string | null;
  /** The original short link, when the import expanded amzn.to / a.co. */
  expandedFrom?: string;
  /** Normalised retail URL the import resolved (input for the suggestion chip only). */
  resolvedUrl?: string;
  fetch: { status: AmazonCardFetchStatus; reason?: string; at?: string };
  /** Page text only, from a successful fetch. */
  extracted?: { title?: string; bullets?: string[]; brand?: string };
  manual: AmazonCardManual;
  resolvedAt: string;
  /**
   * FR-04: set only when `linkStatus === "marketplace"` — which blocked marketplace
   * (Temu / Shein / AliExpress / TikTok Shop) this card's pasted link belongs to.
   * Distinct from `marketplace` above (that field is the Amazon *regional* site,
   * e.g. "amazon.com" vs "amazon.co.uk" — a different concept for a different link
   * kind). A card never has both set.
   */
  manualMarketplace?: MarketplaceId;
};

/** Minimal import-result shape the card consumes (ProductUrlImportResult subset). */
export type AmazonImportResultLike = {
  sourceUrl: string;
  normalizedUrl?: string;
  status?: string;
  amazon?: AmazonImportMeta;
};

const MAX_SELLING_POINTS = 10;
const MAX_POINT_CHARS = 200;
const MAX_PAGE_DESCRIPTION = 2000;

const clean = (v: string | null | undefined): string | undefined => {
  const t = (v ?? "").trim();
  return t ? t : undefined;
};

/** True when the text is an Amazon link we recognise (retail or short). */
export function isAmazonLink(url: string | null | undefined): boolean {
  return parseAmazonLink(url).ok;
}

/**
 * Card context for a (possibly new) Website URL value.
 * - not Amazon → null (caller leaves any stale source alone; it is ignored while the
 *   URL is not Amazon, see isAmazonAffiliateDraft)
 * - same pasted URL → previous source unchanged
 * - new Amazon URL → fresh link/fetch state; the user's manual fields are CARRIED
 *   (never discarded), extracted page text is dropped (different product).
 */
export function amazonSourceForUrl(
  url: string | null | undefined,
  prev: AmazonCardSource | undefined,
  now: string = new Date().toISOString(),
): AmazonCardSource | null {
  const pasted = (url ?? "").trim();
  const parsed = parseAmazonLink(pasted);
  if (!parsed.ok) return null;
  if (prev && prev.pastedUrl === pasted) return prev;
  const base = {
    version: 1 as const,
    pastedUrl: pasted,
    fetch: { status: "not_attempted" as const },
    manual: { ...(prev?.manual ?? {}) },
    resolvedAt: now,
  };
  if (parsed.kind === "short") {
    return { ...base, linkStatus: "short_unexpanded", host: parsed.host };
  }
  // Same product on the same site (e.g. the user accepted the clean-link chip, or the
  // expanded form of their short link): keep what was already fetched — no refetch.
  if (prev && parsed.asin && prev.asin === parsed.asin && prev.host === parsed.host) {
    return { ...prev, pastedUrl: pasted, linkStatus: "ok", marketplace: parsed.marketplace, resolvedAt: now };
  }
  return {
    ...base,
    linkStatus: parsed.asin ? "ok" : "no_asin",
    host: parsed.host,
    marketplace: parsed.marketplace,
    asin: parsed.asin,
  };
}

/**
 * Merge an import response into the card source. Returns `prev` unchanged when the
 * response is for a URL the card no longer holds (the user edited meanwhile).
 */
export function applyAmazonImportResult(
  prev: AmazonCardSource,
  result: AmazonImportResultLike,
  now: string = new Date().toISOString(),
): AmazonCardSource {
  if ((result.sourceUrl ?? "").trim() !== prev.pastedUrl) return prev;
  const meta = result.amazon;
  if (!meta) {
    return { ...prev, fetch: { status: "failed", reason: "no_amazon_result", at: now } };
  }
  const ok = meta.fetch.status === "ok";
  const extracted = ok && meta.extracted ? { ...meta.extracted } : prev.extracted;
  const manual: AmazonCardManual = { ...prev.manual };
  const byline = clean(meta.extracted?.brand);
  // First-time visible prefill only: `undefined` means the box was never set. An
  // empty string means the user cleared it on purpose — never refill that.
  if (ok && byline && manual.brand === undefined) manual.brand = byline;  return {
    ...prev,
    linkStatus: meta.linkStatus,
    host: meta.host,
    marketplace: meta.marketplace,
    asin: meta.asin,
    ...(meta.expandedFrom ? { expandedFrom: meta.expandedFrom } : {}),
    ...(result.normalizedUrl ? { resolvedUrl: result.normalizedUrl } : {}),
    fetch: { status: meta.fetch.status, ...(meta.fetch.reason ? { reason: meta.fetch.reason } : {}), at: now },
    ...(extracted ? { extracted } : {}),
    manual,
  };
}

/** The request itself failed (401 / 429 / offline). Fields untouched; manual mode. */
export function applyAmazonImportError(prev: AmazonCardSource, now: string = new Date().toISOString()): AmazonCardSource {
  return { ...prev, fetch: { status: "failed", reason: "request_failed", at: now } };
}

/** Product name the card shows: the user's value once set, else the fetched title. */
export function effectiveAmazonProductName(src: AmazonCardSource | undefined): string {
  if (!src) return "";
  if (src.manual.productName !== undefined) return src.manual.productName.trim();
  return src.extracted?.title?.trim() ?? "";
}

/** Generation gate (design §2.3): a product name (manual or fetched title) is required. */
export function canGenerateAmazonCopy(src: AmazonCardSource | undefined): boolean {
  return effectiveAmazonProductName(src).length > 0;
}

/**
 * Card presentation state:
 *  - "idle"    — not fetched yet
 *  - "fetched" — page text available (title present)
 *  - "manual"  — fetch failed/blocked, or only bullets came back (partial: name needed)
 */
export function amazonCardMode(src: AmazonCardSource): { mode: "idle" | "fetched" | "manual"; reason?: string } {
  if (src.fetch.status === "not_attempted") return { mode: "idle" };
  // FR-04: a manual-entry marketplace card never attempts a fetch — "manual" is its
  // steady state, not a failure, so it gets its own reason rather than falling into
  // the generic "failed" wording below.
  if (src.fetch.status === "manual_only") return { mode: "manual", reason: "marketplace_manual" };
  if (src.fetch.status === "ok") {
    return src.extracted?.title?.trim() ? { mode: "fetched" } : { mode: "manual", reason: "no_title" };
  }
  return { mode: "manual", reason: src.fetch.reason ?? "failed" };
}

function sellingPointList(raw: string | undefined): string[] | undefined {
  const list = (raw ?? "")
    .split(/\r?\n/)
    .map(s => s.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_SELLING_POINTS)
    .map(s => s.slice(0, MAX_POINT_CHARS));
  return list.length ? list : undefined;
}

export type AmazonCopyContext = {
  /** productContext — user-declared facts only (product_catalog / asserted). */
  product: ProductContext;
  /**
   * pageContext — fetched page text (page_metadata), never catalog assertions. It is the
   * seller-asserted listing text: a claim stated verbatim in one non-negated sentence of
   * it is grounded by validateCopy (seller-text path, P1 0925); nothing else is.
   */
  page?: { title?: string; description?: string };
};

/**
 * Design §3.2 mapping:
 *  manual name → product.title · selling points → product.attributes (≤10)
 *  Brand → vendor · Material → material · Size → quantity   (same as Shopify)
 *  fetched title → page.title · fetched bullets → page.description (≤2000)
 *  fetched byline brand → NOT passed (only prefilled into the visible Brand box)
 *  price / availability → never
 */
export function buildAmazonCopyContext(src: AmazonCardSource): AmazonCopyContext {
  const m = src.manual;
  const product: ProductContext = {
    title: clean(m.productName),
    attributes: sellingPointList(m.sellingPoints),
    vendor: clean(m.brand),
    material: clean(m.material),
    quantity: clean(m.size),
    price: undefined,
    availability: undefined,
    source: "amazon",
  };
  const pageTitle = clean(src.extracted?.title);
  const bullets = (src.extracted?.bullets ?? []).map(b => b.trim()).filter(Boolean);
  const pageDescription = bullets.length ? bullets.join("\n").slice(0, MAX_PAGE_DESCRIPTION) : undefined;
  return {
    product,
    ...(pageTitle || pageDescription ? { page: { title: pageTitle, description: pageDescription } } : {}),
  };
}

export type AmazonClaimHint = { field: "brand" | "material" | "size"; value: string };

const CLAIM_FIELD: Record<string, AmazonClaimHint["field"]> = {
  UNSUPPORTED_BRAND_CLAIM: "brand",
  UNSUPPORTED_MATERIAL_CLAIM: "material",
  UNSUPPORTED_NUMERIC_CLAIM: "size",
};

/**
 * 422 UX (design §3.2): which Brand / Material / Size box to point at, and the value
 * the copy mentioned. Reads the validator's issue code + its quoted message value.
 */
export function amazonClaimHints(report: { issues?: Array<{ code: string; message?: string }> } | null | undefined): AmazonClaimHint[] {
  const out: AmazonClaimHint[] = [];
  for (const issue of report?.issues ?? []) {
    const field = CLAIM_FIELD[issue.code];
    if (!field) continue;
    const value = /"([^"]+)"/.exec(issue.message ?? "")?.[1]?.trim() ?? "";
    if (!out.some(h => h.field === field && h.value === value)) out.push({ field, value });
  }
  return out;
}

/** The draft is an Amazon affiliate card: it has Amazon context AND its current URL is Amazon. */
export function isAmazonAffiliateDraft(draft: { destinationUrl?: string; amazonSource?: AmazonCardSource } | null | undefined): boolean {
  return !!draft?.amazonSource && draft.amazonSource.linkStatus !== "not_amazon" && isAmazonLink(draft.destinationUrl);
}

// ── FR-04: manual-entry marketplaces (Temu / Shein / AliExpress / TikTok Shop) ─────
//
// These reuse the exact same card shape (`AmazonCardSource`, `AmazonCardManual`) and
// the exact same copy-context mapping as Amazon, but there is no fetch step at all:
// `classifyManualMarketplace` is a pure hostname check (zero network), so the card
// goes straight to manual mode. `isAmazonLink` / `isAmazonAffiliateDraft` /
// `amazonSourceForUrl` / `buildAmazonCopyContext` above are UNCHANGED — Amazon links
// still resolve through them exactly as before. The functions below only ADD the
// marketplace branch alongside.

/** Which blocked marketplace (if any) this URL belongs to. Null for Amazon, for
 *  every normal importable URL, and for Instagram (not a marketplace). */
export function classifyCardMarketplace(url: string | null | undefined): MarketplaceId | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  let hostname: string;
  try { hostname = new URL(trimmed).hostname; } catch { return null; }
  return classifyManualMarketplace(hostname);
}

/** True for an Amazon link OR one of the four manual-entry marketplaces — the set of
 *  URLs that get a card-level product context section at all. */
export function isCardMarketplaceLink(url: string | null | undefined): boolean {
  return isAmazonLink(url) || classifyCardMarketplace(url) !== null;
}

/**
 * Card context for a (possibly new) Website URL value, generalized over Amazon AND
 * the manual-entry marketplaces (FR-04 §3: "reuse the Amazon fill-in structure, not a
 * new component"). Amazon URLs go through `amazonSourceForUrl` untouched — this only
 * adds the marketplace branch: a fresh `linkStatus: "marketplace"` / `fetch.status:
 * "manual_only"` source with the user's manual fields carried across product changes,
 * exactly like the Amazon branch carries them across ASIN changes.
 */
export function cardSourceForUrl(
  url: string | null | undefined,
  prev: AmazonCardSource | undefined,
  now: string = new Date().toISOString(),
): AmazonCardSource | null {
  const amazon = amazonSourceForUrl(url, prev, now);
  if (amazon) return amazon;
  const pasted = (url ?? "").trim();
  const marketplace = classifyCardMarketplace(pasted);
  if (!marketplace) return null;
  if (prev && prev.pastedUrl === pasted && prev.linkStatus === "marketplace") return prev;
  return {
    version: 1,
    pastedUrl: pasted,
    linkStatus: "marketplace",
    manualMarketplace: marketplace,
    fetch: { status: "manual_only" },
    manual: { ...(prev?.manual ?? {}) },
    resolvedAt: now,
  };
}

/** The draft has a card-level product context section showing — Amazon OR one of the
 *  manual-entry marketplaces, and the source matches the CURRENT destination URL. */
export function isMarketplaceCardDraft(draft: { destinationUrl?: string; amazonSource?: AmazonCardSource } | null | undefined): boolean {
  if (isAmazonAffiliateDraft(draft)) return true;
  return !!draft?.amazonSource && draft.amazonSource.linkStatus === "marketplace" && classifyCardMarketplace(draft.destinationUrl) !== null;
}

/**
 * Copy-context mapping for a manual-entry marketplace card — same field mapping as
 * `buildAmazonCopyContext` (name → title, selling points → attributes, Brand/Material/
 * Size → vendor/material/quantity, price/availability never passed), but `source` is
 * the marketplace id and there is never a `page` (no fetch ever happens for these).
 */
export function buildMarketplaceCopyContext(src: AmazonCardSource): AmazonCopyContext {
  const m = src.manual;
  const product: ProductContext = {
    title: clean(m.productName),
    attributes: sellingPointList(m.sellingPoints),
    vendor: clean(m.brand),
    material: clean(m.material),
    quantity: clean(m.size),
    price: undefined,
    availability: undefined,
    source: src.manualMarketplace ?? "manual",
  };
  return { product };
}
