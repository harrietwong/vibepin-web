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
import type { AmazonImportMeta } from "@/lib/productUrlImport/types";
import type { ProductContext } from "@/lib/ai-copy/types";

export type AmazonCardLinkStatus = "ok" | "no_asin" | "short_unexpanded" | "not_amazon";
export type AmazonCardFetchStatus = "not_attempted" | "ok" | "blocked" | "failed";

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
  /** pageContext — fetched page text (page_metadata), never catalog assertions. */
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
