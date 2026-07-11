// Pure, DB-free helpers for /api/products/top tier merging.
//
// Extracted so the tier-merge / dedup / category-resolution logic is unit-testable
// without a live Supabase client. The route fetches three tiers and merges them:
//   1. scored          — products with product_scores (primary ranking)
//   2. bootstrap        — legacy STL rows, top-N by source_pin_save_count
//   3. bootstrapDetail  — pinterest_product_card_bootstrap rows, newest first
// Tier 3 exists so freshly-inserted product-card bootstrap rows are NOT forced to
// compete inside the legacy top-300 source_pin_save_count window (where high-save
// legacy rows crowd them out).

export const STL_BOOTSTRAP_DETAIL = "pinterest_product_card_bootstrap";

export type RawProductRow = Record<string, unknown> & {
  id?: unknown;
  image_url?: string | null;
  product_url_hash?: string | null;
  canonical_product_url?: string | null;
  discovery_method_detail?: string | null;
  source_category?: string | null;
  seed_keyword?: string | null;
  source_pin_save_count?: number | null;
};

/** Stable product identity for cross-tier dedup: product_url_hash > canonical_product_url.
 *  Rows lacking both have no shared identity (return null) and are kept as-is. */
export function productIdentityKey(r: RawProductRow): string | null {
  const h = (r.product_url_hash as string | null) ?? null;
  if (h) return `h:${h}`;
  const c = (r.canonical_product_url as string | null) ?? null;
  if (c) return `c:${c}`;
  return null;
}

/** Derived (non-provenance) category used only for filtering.
 *  Bootstrap product-card rows carry their category in source_category and usually
 *  have no seed_keyword, so source_category is the only way they expose a category.
 *  Returns null when there is no derived category (legacy rows resolve category via
 *  seed_keyword → kwCatMap on the client, unchanged). */
export function resolveProductCategory(
  detail: string | null | undefined,
  sourceCategory: string | null | undefined,
): string | null {
  return detail === STL_BOOTSTRAP_DETAIL && sourceCategory ? sourceCategory : null;
}

/** Merge the three fetch tiers into one ordered, deduped raw-row list.
 *
 *  Order is preserved: scored → bootstrap → bootstrapDetail.
 *  Dedup rules:
 *    - never include the same row id twice;
 *    - drop any row without image_url (imageless cards must not surface);
 *    - the bootstrapDetail tier additionally skips a row whose product identity
 *      (hash > canonical) was already emitted by an earlier tier, so the same
 *      product is not duplicated across tiers.
 *  The scored/bootstrap tiers keep their existing id-only cross-tier behavior. */
export function mergeProductTiers(tiers: {
  scored: RawProductRow[];
  bootstrap: RawProductRow[];
  bootstrapDetail: RawProductRow[];
}): RawProductRow[] {
  const seenIds = new Set<unknown>();
  const seenIdentity = new Set<string>();
  const out: RawProductRow[] = [];

  const consider = (r: RawProductRow, dedupByIdentity: boolean): void => {
    if (seenIds.has(r.id)) return;
    if (!r.image_url) return; // imageless rows never surface
    const k = productIdentityKey(r);
    if (dedupByIdentity && k && seenIdentity.has(k)) return;
    seenIds.add(r.id);
    if (k) seenIdentity.add(k);
    out.push(r);
  };

  for (const r of tiers.scored) consider(r, false);
  for (const r of tiers.bootstrap) consider(r, false);
  for (const r of tiers.bootstrapDetail) consider(r, true);
  return out;
}
