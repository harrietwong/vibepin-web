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

/** discovery_method values that mean "found via the Pin's outbound product link".
 *  'outbound_link' is the current standard written by the product-supply expander;
 *  'outbound_link_bootstrap' is the historical label and stays supported. */
export const OUTBOUND_DISCOVERY_METHODS = ["outbound_link", "outbound_link_bootstrap"] as const;

/** Lifecycle column (pin_products, migrate_v46) + the ONE value that hides a row.
 *
 *  Soft retirement is orthogonal to discovery_method: a retired row keeps its
 *  provenance (discovery_method / parent_pin_id / source_url / source_pin_save_count
 *  / created_at are never rewritten) and stays in the table as evidence — it just
 *  must never surface in a product-discovery surface.
 *
 *  T10 retired the 798 historical 'outbound_link_bootstrap' rows: image_url was an
 *  i.pinimg.com Pin screenshot (a fake product image) on 798/798, and save_count was
 *  the SOURCE Pin's saves copied verbatim on 798/798. Salvage rate was ~17.8%, so the
 *  batch was retired rather than repaired. This replaces the old created_at-based
 *  containment (OUTBOUND_CLEAN_CORPUS_SINCE), which could only isolate them by TIME —
 *  unsafe, since the dirty batch spans 2026-06-01 → 2026-07-09 with no clean boundary.
 */
export const LIFECYCLE_STATUS_COLUMN = "lifecycle_status";
export const LIFECYCLE_RETIRED = "retired";

/** The PostgREST `or=` expression that keeps every row EXCEPT the soft-retired ones.
 *
 *  Semantics: `lifecycle_status IS DISTINCT FROM 'retired'`.
 *  It MUST be expressed as an OR (`is.null` OR `neq.retired`), NOT as a bare `.neq()`:
 *  PostgREST's `neq` on a NULL column does not match NULL rows, and every non-T10 row
 *  has lifecycle_status = NULL — a plain `.neq('retired')` would therefore hide the
 *  ENTIRE active corpus and surface nothing. Do not "simplify" this. */
export const NOT_RETIRED_FILTER =
  `${LIFECYCLE_STATUS_COLUMN}.is.null,${LIFECYCLE_STATUS_COLUMN}.neq.${LIFECYCLE_RETIRED}`;

/** Apply the NULL-safe "not retired" filter to a pin_products query.
 *
 *  Typed structurally (not with a self-referential `T extends { or: (f) => T }`, which
 *  makes tsc re-expand Supabase's deeply-recursive builder generics and blows the
 *  instantiation depth limit — TS2589). The cast is confined to this one helper so every
 *  call site stays fully typed.
 *
 *  Works for both the server and browser Supabase clients; this module stays DB-free. */
export function excludeRetired<T>(query: T): T {
  return (query as unknown as { or: (f: string) => T }).or(NOT_RETIRED_FILTER);
}

/** Public, user-facing source-type code. Derived server-side from provenance so the
 *  raw discovery_method / discovery_method_detail fields are never sent to the client. */
export type ProductSourceTypeCode =
  | "shop_the_look"
  | "product_pin"
  | "product_link_pin"
  | "pinterest_pin";

export function deriveProductSourceType(row: {
  discovery_method?: string | null;
  product_pin_id?: string | null;
}): ProductSourceTypeCode {
  const method = row.discovery_method ?? null;
  if (method === "stl") return "shop_the_look";
  if (method && (OUTBOUND_DISCOVERY_METHODS as readonly string[]).includes(method)) {
    return "product_link_pin";
  }
  if (row.product_pin_id) return "product_pin";
  return "pinterest_pin";
}

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
  /** Outbound-link product rows (discovery_method in OUTBOUND_DISCOVERY_METHODS),
   *  newest-first. Structurally unreachable through the three legacy tiers, so it
   *  gets its own tier. Identity-deduped on merge like bootstrapDetail. Optional so
   *  existing callers/tests keep working. */
  outbound?: RawProductRow[];
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
  for (const r of tiers.outbound ?? []) consider(r, true);
  return out;
}
