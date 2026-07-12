/**
 * pinProducts.ts — canonical product resolution for a Pin.
 *
 * The single-Pin edit modal seeds products from `linkedProducts ?? setupSnapshot`,
 * but the Batch Edit row mappers previously read ONLY `metadataDraft`, so a Pin's
 * attached products silently disappeared in Batch Edit. This resolver is the ONE
 * place both surfaces agree on, checking every canonical source in priority order
 * so linked products never get dropped when converting a Pin into a Batch row.
 *
 * Pure + read-only: no store writes, no schema changes, no destinationUrl logic.
 */

import { normalizeProductSource, resolvePinProducts, type LinkedProduct, type PinMetadataDraft } from "@/lib/pinMetadata";
import type { ProductSnapshot } from "@/lib/studioPersistence";

export type CanonicalPinProductsInput = {
  /** Per-Pin metadata (primaryProduct/taggedProducts or legacy linkedProduct* mirror). */
  metadataDraft?:  PinMetadataDraft | null;
  /** Post-edit canonical product list (PinDraft.linkedProducts). */
  linkedProducts?: LinkedProduct[] | null;
  /** Which linkedProduct is primary. */
  primaryProductId?: string | null;
  /** Session-selected products (setupSnapshot.selectedProducts) — the modal's fallback. */
  setupProducts?:  ProductSnapshot[] | null;
  /** Amazon affiliate context — last-resort so an affiliate Pin still shows a product. */
  productId?:            string | null;
  creatorProductLinkId?: string | null;
  sourceProductImageUrl?: string | null;
};

export type ResolvedPinProducts = { primary: LinkedProduct | null; tagged: LinkedProduct[] };

function snapshotToLinked(s: ProductSnapshot): LinkedProduct {
  return {
    productId:  s.productId,
    title:      s.title?.trim() || "Product",
    imageUrl:   s.imageUrl ?? undefined,
    productUrl: s.productUrl,
    store:      s.sourceDomain ?? undefined,
    source:     normalizeProductSource(s.source),
    linkType:   "manual",
  };
}

function nonEmpty(r: ResolvedPinProducts): boolean {
  return !!r.primary || r.tagged.length > 0;
}

/**
 * Resolve a Pin's products from all canonical sources, in priority order:
 *  1. linkedProducts (post-edit source of truth — matches the edit modal)
 *  2. metadataDraft primary/tagged (generated / edited per-Pin products)
 *  3. setupSnapshot.selectedProducts (session products — the modal's fallback)
 *  4. Amazon affiliate context (so an affiliate Pin still shows a product, never blank)
 *
 * Returns the FIRST non-empty source so counts stay consistent with the single-Pin
 * edit modal. Never invents a product when none of the sources have one.
 */
export function resolveCanonicalPinProducts(input: CanonicalPinProductsInput): ResolvedPinProducts {
  // 1. linkedProducts (top-level, post-edit canonical).
  const linked = input.linkedProducts ?? [];
  if (linked.length) {
    const primary = (input.primaryProductId && linked.find(p => p.productId === input.primaryProductId)) || linked[0];
    const tagged = linked.filter(p => p !== primary);
    return { primary: primary ?? null, tagged };
  }

  // 2. metadataDraft (per-Pin generated / edited products).
  const fromMeta = resolvePinProducts(input.metadataDraft);
  if (nonEmpty(fromMeta)) return fromMeta;

  // 3. setupSnapshot.selectedProducts (session products — the modal's fallback source).
  const setup = (input.setupProducts ?? []).filter(p => p.title || p.imageUrl || p.productUrl);
  if (setup.length) {
    const mapped = setup.map(snapshotToLinked);
    return { primary: mapped[0] ?? null, tagged: mapped.slice(1) };
  }

  // 4. Amazon affiliate context — last resort so an affiliate Pin is never blank.
  if (input.creatorProductLinkId || input.productId || input.sourceProductImageUrl) {
    return {
      primary: {
        productId:  input.productId ?? undefined,
        title:      "Amazon product",
        imageUrl:   input.sourceProductImageUrl ?? undefined,
        source:     "url_imported",
        linkType:   "auto",
      },
      tagged: [],
    };
  }

  return { primary: null, tagged: [] };
}
