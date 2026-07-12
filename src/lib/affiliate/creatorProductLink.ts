/**
 * creatorProductLink.ts — Reusable, creator-owned affiliate product link.
 *
 * A CreatorProductLink binds a product (by productId) to the creator's own
 * affiliate destination URL. It is reused across every Pin generated from that
 * product, so the product identity, image, and affiliate URL stay stable until
 * publish. One link per (productId + trackingId + marketplace).
 *
 * Persistence is a localStorage MVP. The core logic accepts an injectable repo
 * so it is deterministic and unit-testable without a browser.
 */

import {
  buildAmazonAffiliateUrl,
  buildCanonicalProductUrl,
  extractAsin,
  isAmazonUrl,
  normalizeMarketplace,
} from "./amazon";
import {
  hasUsableAmazonSettings,
  type AmazonAffiliateSettings,
} from "./amazonAffiliateSettings";

export type CreatorProductLinkStatus = "ready" | "needs_setup" | "failed";

export type CreatorProductLink = {
  id: string;
  userId?: string;
  productId: string;
  provider: "amazon";
  marketplace: string;
  asin: string;
  trackingId: string;
  canonicalProductUrl: string;
  affiliateUrl: string;
  status: CreatorProductLinkStatus;
  createdAt: string;
  updatedAt: string;
};

/** Structural product input — works for LibraryProduct, ProductSnapshot, LinkedProduct. */
export type AffiliateProductInput = {
  id?: string;
  productId?: string;
  provider?: string;
  asin?: string;
  productUrl?: string;
  canonicalUrl?: string;
  imageUrl?: string | null;
};

// ── Repository abstraction (localStorage by default, in-memory for tests) ───────

export type CreatorProductLinkRepo = {
  all(): CreatorProductLink[];
  find(key: { productId: string; trackingId: string; marketplace: string }): CreatorProductLink | null;
  getById(id: string): CreatorProductLink | null;
  save(link: CreatorProductLink): CreatorProductLink;
};

const STORE_KEY = "vp:creator_product_links:v1";
export const CREATOR_PRODUCT_LINK_EVENT = "vp:creator_product_links_updated";

function loadAll(): Record<string, CreatorProductLink> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CreatorProductLink>;
  } catch { return {}; }
}

function persistAll(map: Record<string, CreatorProductLink>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event(CREATOR_PRODUCT_LINK_EVENT));
  } catch { /* quota exceeded — ignore */ }
}

/** Default repo backed by localStorage. SSR/node calls are no-ops that return empty. */
export const localStorageRepo: CreatorProductLinkRepo = {
  all() { return Object.values(loadAll()); },
  getById(id) { return loadAll()[id] ?? null; },
  find(key) {
    return this.all().find(l =>
      l.productId === key.productId &&
      l.trackingId === key.trackingId &&
      l.marketplace === key.marketplace,
    ) ?? null;
  },
  save(link) {
    const map = loadAll();
    map[link.id] = link;
    persistAll(map);
    return link;
  },
};

/**
 * Account-level sync adapter (WP-B). Collection under storeKey
 * `creator_product_links` (doc_id = link id). LWW per id on `updatedAt`, tombstone
 * per id. Reuses loadAll/persistAll so a merge does a single persist + single
 * CREATOR_PRODUCT_LINK_EVENT emit; the localStorage shape is untouched.
 */
export const creatorProductLinksSyncAdapter: import("../userStoreSync").StoreSyncAdapter<CreatorProductLink> = {
  storeKey: "creator_product_links",
  eventName: CREATOR_PRODUCT_LINK_EVENT,
  getAll() {
    return Object.values(loadAll()).map((l) => ({ id: l.id, updatedAt: l.updatedAt, doc: l }));
  },
  mergeServer(live, deleted) {
    if (typeof window === "undefined") return;
    const map = loadAll();
    let changed = false;
    for (const inc of live) {
      if (!inc || typeof inc.id !== "string" || !inc.id) continue;
      const local = map[inc.id];
      if (local && cplTsMs(inc.updatedAt) <= cplTsMs(local.updatedAt)) continue; // local wins / equal
      map[inc.id] = inc;
      changed = true;
    }
    for (const t of deleted) {
      if (!t || typeof t.id !== "string") continue;
      const local = map[t.id];
      if (!local) continue;
      if (cplTsMs(local.updatedAt) >= cplTsMs(t.deletedAt)) continue; // newer local edit survives
      delete map[t.id];
      changed = true;
    }
    if (changed) persistAll(map); // single persist + single emit
  },
};

function cplTsMs(v: string | null | undefined): number {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** In-memory repo for unit tests (no window required). */
export function createInMemoryRepo(seed: CreatorProductLink[] = []): CreatorProductLinkRepo {
  const map = new Map<string, CreatorProductLink>(seed.map(l => [l.id, l]));
  return {
    all() { return [...map.values()]; },
    getById(id) { return map.get(id) ?? null; },
    find(key) {
      return [...map.values()].find(l =>
        l.productId === key.productId &&
        l.trackingId === key.trackingId &&
        l.marketplace === key.marketplace,
      ) ?? null;
    },
    save(link) { map.set(link.id, link); return link; },
  };
}

// ── Identity ────────────────────────────────────────────────────────────────────

function resolveProductId(product: AffiliateProductInput): string {
  return (product.productId ?? product.id ?? "").trim();
}

function isAmazonProduct(product: AffiliateProductInput): boolean {
  if ((product.provider ?? "").trim().toLowerCase() === "amazon") return true;
  return isAmazonUrl(product.productUrl) || isAmazonUrl(product.canonicalUrl);
}

function resolveAsin(product: AffiliateProductInput): string | null {
  return extractAsin(product.asin)
    ?? extractAsin(product.productUrl)
    ?? extractAsin(product.canonicalUrl);
}

/**
 * Deterministic id derived from the dedupe key, so the same product + tracking +
 * marketplace always maps to the same link id even across reloads / repos.
 */
function deterministicId(productId: string, trackingId: string, marketplace: string): string {
  const key = `${productId}|${trackingId}|${marketplace}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return `cpl_${Math.abs(hash).toString(36)}`;
}

// ── Core: getOrCreate ────────────────────────────────────────────────────────────

/**
 * Get (reuse) or create a reusable creator-owned affiliate link for a product.
 *
 * Returns:
 *  - null                      → product is not an Amazon product (unsupported).
 *  - status "needs_setup"      → user has no usable tracking id (not persisted).
 *  - status "failed"           → no resolvable ASIN (not persisted).
 *  - status "ready"            → reused or newly created + persisted link.
 *
 * Deterministic and duplicate-safe: one persisted link per
 * (productId + trackingId + marketplace).
 */
export function getOrCreateCreatorProductLink(
  product: AffiliateProductInput,
  amazonSettings: AmazonAffiliateSettings | null | undefined,
  repo: CreatorProductLinkRepo = localStorageRepo,
  opts: { userId?: string } = {},
): CreatorProductLink | null {
  if (!isAmazonProduct(product)) return null;

  const now = new Date().toISOString();
  const productId = resolveProductId(product);
  const marketplace = normalizeMarketplace(amazonSettings?.marketplace);
  const trackingId = (amazonSettings?.trackingId ?? "").trim();
  const asin = resolveAsin(product);

  // No usable tracking id → creator must finish Amazon setup first. Not persisted.
  if (!hasUsableAmazonSettings(amazonSettings)) {
    return {
      id: deterministicId(productId, trackingId || "no_tag", marketplace),
      userId: opts.userId,
      productId,
      provider: "amazon",
      marketplace,
      asin: asin ?? "",
      trackingId,
      canonicalProductUrl: asin ? buildCanonicalProductUrl(asin, marketplace) : "",
      affiliateUrl: "",
      status: "needs_setup",
      createdAt: now,
      updatedAt: now,
    };
  }

  // No ASIN → cannot build a real product link. Not persisted (avoids fake ASINs).
  if (!asin) {
    return {
      id: deterministicId(productId, trackingId, marketplace),
      userId: opts.userId,
      productId,
      provider: "amazon",
      marketplace,
      asin: "",
      trackingId,
      canonicalProductUrl: "",
      affiliateUrl: "",
      status: "failed",
      createdAt: now,
      updatedAt: now,
    };
  }

  // Reuse an existing ready link for the same product + tracking + marketplace.
  const existing = repo.find({ productId, trackingId, marketplace });
  if (existing && existing.status === "ready" && existing.asin === asin) {
    return existing;
  }

  const link: CreatorProductLink = {
    id: existing?.id ?? deterministicId(productId, trackingId, marketplace),
    userId: opts.userId,
    productId,
    provider: "amazon",
    marketplace,
    asin,
    trackingId,
    canonicalProductUrl: buildCanonicalProductUrl(asin, marketplace),
    affiliateUrl: buildAmazonAffiliateUrl({ asin, marketplace, trackingId }),
    status: "ready",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return repo.save(link);
}
