/**
 * Persistence for synced Shopify products + images + variants (server-only, WP1).
 *
 * Non-transactional by design: supabase-js is a REST (PostgREST) client with no
 * transactions. upsertProductsBatch therefore writes parent rows first, then
 * diffs the child tables (delete rows missing from the incoming set, upsert the
 * rest) — every step is an idempotent onConflict upsert / keyed delete, so a
 * crash between steps leaves at worst a superset/subset of children that the
 * next re-run of the same chunk converges (§3.4 幂等 upsert; acceptable per plan).
 *
 * Missing v39 tables degrade gracefully on read paths (裁决 i): lists return
 * empty, lookups return null, counts return 0.
 */

import { createServerClient } from "../../supabase";
import { StoreDatabaseError, isMissingTableError } from "./connectionStore";

const PRODUCTS = "store_products";
const IMAGES = "store_product_images";
const VARIANTS = "store_product_variants";

/** Chunk size for `.in(...)` filters (keeps PostgREST query strings bounded). */
const IN_FILTER_CHUNK = 100;

// ── Types ─────────────────────────────────────────────────────────────────────

export type StoreProductStatus = "active" | "draft" | "archived" | "deleted";
export type StoreProductAvailability = "in_stock" | "out_of_stock" | "unknown";

export type StoreProductRow = {
  id: string;
  vibepin_user_id: string;
  store_connection_id: string;
  source: string;
  external_product_id: string;
  handle: string | null;
  title: string;
  description_text: string | null;
  product_url: string | null;
  status: StoreProductStatus;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  price_amount: number | null;
  compare_at_price: number | null;
  currency: string | null;
  availability: StoreProductAvailability;
  primary_image_url: string | null;
  image_count: number;
  created_at_source: string | null;
  updated_at_source: string | null;
  last_synced_at: string | null;
  sync_error: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  raw_source: unknown;
  raw_source_saved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StoreProductImageRow = {
  id: string;
  vibepin_user_id: string;
  product_id: string;
  external_image_id: string;
  source_image_url: string;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  position: number;
  variant_external_ids: string[];
  created_at: string;
  updated_at: string;
};

export type StoreProductVariantRow = {
  id: string;
  vibepin_user_id: string;
  product_id: string;
  external_variant_id: string;
  title: string | null;
  price_amount: number | null;
  sku: string | null;
  available_for_sale: boolean | null;
  external_image_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type ProductImageInput = {
  externalImageId: string;
  sourceImageUrl: string;
  width?: number | null;
  height?: number | null;
  altText?: string | null;
  position?: number;
  variantExternalIds?: string[];
};

export type ProductVariantInput = {
  externalVariantId: string;
  title?: string | null;
  priceAmount?: number | null;
  sku?: string | null;
  availableForSale?: boolean | null;
  externalImageId?: string | null;
  position?: number;
};

export type ProductUpsertInput = {
  externalProductId: string;
  title: string;
  handle?: string | null;
  descriptionText?: string | null;
  productUrl?: string | null;
  /** Incoming sync status — never "deleted" (deletion is tombstoneStale's job). */
  status: "active" | "draft" | "archived";
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  priceAmount?: number | null;
  compareAtPrice?: number | null;
  currency?: string | null;
  availability?: StoreProductAvailability;
  primaryImageUrl?: string | null;
  createdAtSource?: string | null;
  updatedAtSource?: string | null;
  /** Debug snapshot (30-day lazy retention per §4.2 note). */
  rawSource?: unknown;
  images?: ProductImageInput[];
  variants?: ProductVariantInput[];
};

export type UpsertedProductRef = { id: string; externalProductId: string };

export type ListProductsParams = {
  userId: string;
  connectionId?: string;
  q?: string;
  status?: "active" | "draft" | "archived";
  includeDeleted?: boolean;
  cursor?: string | null;
  limit?: number;
};

export type ListProductsResult = {
  products: StoreProductRow[];
  nextCursor: string | null;
};

export type ProductWithImages = {
  product: StoreProductRow;
  images: StoreProductImageRow[];
};

// ── DB client (test-injectable) ───────────────────────────────────────────────

type DbClient = ReturnType<typeof createServerClient>;

let dbOverride: DbClient | null = null;

/** Test-only: inject a mock Supabase client (pass null to restore the real one). */
export function __setDbClientForTests(client: unknown): void {
  dbOverride = (client as DbClient | null) ?? null;
}

function db(): DbClient {
  return dbOverride ?? createServerClient();
}

function nowIso(): string {
  return new Date().toISOString();
}

function dbError(action: string, code: string | undefined, message: string): StoreDatabaseError {
  if (isMissingTableError(code, message)) {
    return new StoreDatabaseError("Shopify product storage is not set up");
  }
  console.error(`[shopify] failed to ${action}:`, message);
  return new StoreDatabaseError("Shopify product storage is unavailable");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Batch upsert (sync engine write path) ────────────────────────────────────

/**
 * Idempotently upsert one sync chunk: parent products (onConflict on the
 * (user, connection, external id) identity), then diff-sync the images and
 * variants child tables per product (delete children missing from the incoming
 * payload, upsert the rest). Re-running the same chunk converges — see module
 * header for the non-transactional rationale.
 *
 * `syncedAt` stamps last_synced_at and is what the completion tombstone sweep
 * compares against (rows a full run never touched get tombstoned).
 */
export async function upsertProductsBatch(
  userId: string,
  connectionId: string,
  products: ProductUpsertInput[],
  opts?: { syncedAt?: string },
): Promise<UpsertedProductRef[]> {
  if (products.length === 0) return [];
  const syncedAt = opts?.syncedAt ?? nowIso();

  const productRows = products.map((p) => ({
    vibepin_user_id: userId,
    store_connection_id: connectionId,
    source: "shopify",
    external_product_id: p.externalProductId,
    handle: p.handle ?? null,
    title: p.title ?? "",
    description_text: p.descriptionText ?? null,
    product_url: p.productUrl ?? null,
    status: p.status,
    vendor: p.vendor ?? null,
    product_type: p.productType ?? null,
    tags: p.tags ?? [],
    price_amount: p.priceAmount ?? null,
    compare_at_price: p.compareAtPrice ?? null,
    currency: p.currency ?? null,
    availability: p.availability ?? "unknown",
    primary_image_url: p.primaryImageUrl ?? null,
    image_count: p.images?.length ?? 0,
    created_at_source: p.createdAtSource ?? null,
    updated_at_source: p.updatedAtSource ?? null,
    last_synced_at: syncedAt,
    sync_error: null,
    archived_at: p.status === "archived" ? syncedAt : null,
    deleted_at: null, // reappearing product un-tombstones
    ...(p.rawSource !== undefined
      ? { raw_source: p.rawSource, raw_source_saved_at: syncedAt }
      : {}),
    updated_at: syncedAt,
  }));

  const { data, error } = await db()
    .from(PRODUCTS)
    .upsert(productRows, { onConflict: "vibepin_user_id,store_connection_id,external_product_id" })
    .select("id, external_product_id");

  if (error) throw dbError("upsert products", error.code, error.message);

  const refs = ((data ?? []) as Array<{ id: string; external_product_id: string }>).map((r) => ({
    id: r.id,
    externalProductId: r.external_product_id,
  }));
  const idByExternal = new Map(refs.map((r) => [r.externalProductId, r.id]));

  // ── Child tables: diff-sync per product ────────────────────────────────────
  const imageRows: Array<Record<string, unknown>> = [];
  const variantRows: Array<Record<string, unknown>> = [];
  const keepImageKeys = new Set<string>();
  const keepVariantKeys = new Set<string>();

  for (const p of products) {
    const productId = idByExternal.get(p.externalProductId);
    if (!productId) continue; // defensive: parent upsert returned no row

    for (const img of p.images ?? []) {
      keepImageKeys.add(`${productId} ${img.externalImageId}`);
      imageRows.push({
        vibepin_user_id: userId,
        product_id: productId,
        external_image_id: img.externalImageId,
        source_image_url: img.sourceImageUrl,
        width: img.width ?? null,
        height: img.height ?? null,
        alt_text: img.altText ?? null,
        position: img.position ?? 0,
        variant_external_ids: img.variantExternalIds ?? [],
        updated_at: syncedAt,
      });
    }
    for (const v of p.variants ?? []) {
      keepVariantKeys.add(`${productId} ${v.externalVariantId}`);
      variantRows.push({
        vibepin_user_id: userId,
        product_id: productId,
        external_variant_id: v.externalVariantId,
        title: v.title ?? null,
        price_amount: v.priceAmount ?? null,
        sku: v.sku ?? null,
        available_for_sale: v.availableForSale ?? null,
        external_image_id: v.externalImageId ?? null,
        position: v.position ?? 0,
        updated_at: syncedAt,
      });
    }
  }

  const productIds = refs.map((r) => r.id);
  await diffSyncChildren(IMAGES, "external_image_id", productIds, keepImageKeys, imageRows, "product_id,external_image_id");
  await diffSyncChildren(VARIANTS, "external_variant_id", productIds, keepVariantKeys, variantRows, "product_id,external_variant_id");

  return refs;
}

/** Delete child rows absent from the incoming set, then upsert the incoming set. */
async function diffSyncChildren(
  table: string,
  externalIdColumn: string,
  productIds: string[],
  keepKeys: Set<string>,
  incomingRows: Array<Record<string, unknown>>,
  onConflict: string,
): Promise<void> {
  if (productIds.length === 0) return;

  // 1. Read existing children for the touched products, find rows to delete.
  const staleIds: string[] = [];
  for (const ids of chunk(productIds, IN_FILTER_CHUNK)) {
    const { data, error } = await db()
      .from(table)
      .select(`id, product_id, ${externalIdColumn}`)
      .in("product_id", ids);
    if (error) throw dbError(`read ${table}`, error.code, error.message);
    // Cast via unknown: the dynamic column name defeats supabase-js's
    // template-literal select parser (it types the result as ParserError).
    for (const row of (data ?? []) as unknown as Array<Record<string, string>>) {
      if (!keepKeys.has(`${row.product_id} ${row[externalIdColumn]}`)) {
        staleIds.push(row.id);
      }
    }
  }

  // 2. Delete children the source no longer has.
  for (const ids of chunk(staleIds, IN_FILTER_CHUNK)) {
    const { error } = await db().from(table).delete().in("id", ids);
    if (error) throw dbError(`prune ${table}`, error.code, error.message);
  }

  // 3. Upsert the incoming children (idempotent on the external identity).
  if (incomingRows.length > 0) {
    const { error } = await db().from(table).upsert(incomingRows, { onConflict });
    if (error) throw dbError(`upsert ${table}`, error.code, error.message);
  }
}

// ── Queries (picker read path) ───────────────────────────────────────────────

type CursorPayload = { u: string | null; id: string };

function encodeCursor(row: StoreProductRow): string {
  const payload: CursorPayload = { u: row.updated_at_source ?? null, id: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed?.id !== "string") return null;
    return { u: typeof parsed.u === "string" ? parsed.u : null, id: parsed.id };
  } catch {
    return null;
  }
}

/** Escape LIKE wildcards in user-supplied search text. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Picker query: newest updated_at_source first (nulls last, id as tiebreaker),
 * keyset cursor pagination, optional title search / status filter. Tombstoned
 * rows are hidden unless includeDeleted (决策 8). Missing table → empty page.
 */
export async function listProducts(params: ListProductsParams): Promise<ListProductsResult> {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

  let query = db()
    .from(PRODUCTS)
    .select("*")
    .eq("vibepin_user_id", params.userId);

  if (params.connectionId) query = query.eq("store_connection_id", params.connectionId);
  if (params.status) query = query.eq("status", params.status);
  if (!params.includeDeleted) query = query.is("deleted_at", null);
  const q = params.q?.trim();
  if (q) query = query.ilike("title", `%${escapeLike(q)}%`);

  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (cursor) {
    if (cursor.u === null) {
      // Already inside the nulls-last tail: continue by id.
      query = query.is("updated_at_source", null).gt("id", cursor.id);
    } else {
      query = query.or(
        `updated_at_source.lt."${cursor.u}",` +
          `and(updated_at_source.eq."${cursor.u}",id.gt."${cursor.id}"),` +
          "updated_at_source.is.null",
      );
    }
  }

  const { data, error } = await query
    .order("updated_at_source", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(limit + 1);

  if (error) {
    if (isMissingTableError(error.code, error.message)) {
      return { products: [], nextCursor: null };
    }
    throw dbError("list products", error.code, error.message);
  }

  const rows = (data ?? []) as StoreProductRow[];
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
  return { products: page, nextCursor };
}

/** Product detail + ordered images, scoped to the user. Missing table → null. */
export async function getProductWithImages(
  userId: string,
  id: string,
): Promise<ProductWithImages | null> {
  const { data, error } = await db()
    .from(PRODUCTS)
    .select("*")
    .eq("id", id)
    .eq("vibepin_user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error.code, error.message)) return null;
    throw dbError("read product", error.code, error.message);
  }
  const product = (data as StoreProductRow | null) ?? null;
  if (!product) return null;

  const { data: images, error: imgError } = await db()
    .from(IMAGES)
    .select("*")
    .eq("product_id", id)
    .order("position", { ascending: true });

  if (imgError) {
    if (isMissingTableError(imgError.code, imgError.message)) {
      return { product, images: [] };
    }
    throw dbError("read product images", imgError.code, imgError.message);
  }
  return { product, images: (images ?? []) as StoreProductImageRow[] };
}

// ── Tombstones ───────────────────────────────────────────────────────────────

/**
 * Completion sweep (§3.4 删除检测): tombstone every live product of the
 * connection the finished full run did NOT touch (last_synced_at < run start).
 * Returns the number of rows tombstoned.
 */
export async function tombstoneStale(connectionId: string, before: string): Promise<number> {
  const now = nowIso();
  const { data, error } = await db()
    .from(PRODUCTS)
    .update({ deleted_at: now, status: "deleted", updated_at: now })
    .eq("store_connection_id", connectionId)
    .is("deleted_at", null)
    .lt("last_synced_at", before)
    .select("id");

  if (error) {
    if (isMissingTableError(error.code, error.message)) return 0;
    throw dbError("tombstone stale products", error.code, error.message);
  }
  return (data ?? []).length;
}

/**
 * Disconnect/uninstall: tombstone ALL live products of the connection. Draft
 * references stay intact and render as stale (§3.8). Missing table → 0
 * (webhook path must never 500 on an unapplied migration).
 */
export async function tombstoneAll(connectionId: string): Promise<number> {
  const now = nowIso();
  const { data, error } = await db()
    .from(PRODUCTS)
    .update({ deleted_at: now, status: "deleted", updated_at: now })
    .eq("store_connection_id", connectionId)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    if (isMissingTableError(error.code, error.message)) return 0;
    throw dbError("tombstone products", error.code, error.message);
  }
  return (data ?? []).length;
}

// ── Aggregates / allowlist ───────────────────────────────────────────────────

/** Live (non-tombstoned) synced products across all of the user's connections. */
export async function countActive(userId: string): Promise<number> {
  const { count, error } = await db()
    .from(PRODUCTS)
    .select("id", { count: "exact", head: true })
    .eq("vibepin_user_id", userId)
    .is("deleted_at", null);

  if (error) {
    if (isMissingTableError(error.code, error.message)) return 0;
    throw dbError("count products", error.code, error.message);
  }
  return count ?? 0;
}

/**
 * SSRF allowlist check (§3.7): true only when the URL is one of THIS user's
 * synced product image URLs. Missing table / empty url → false.
 */
export async function isOwnedProductImageUrl(userId: string, url: string): Promise<boolean> {
  const trimmed = url?.trim();
  if (!trimmed) return false;

  const { data, error } = await db()
    .from(IMAGES)
    .select("id")
    .eq("vibepin_user_id", userId)
    .eq("source_image_url", trimmed)
    .limit(1);

  if (error) {
    if (isMissingTableError(error.code, error.message)) return false;
    throw dbError("check product image url", error.code, error.message);
  }
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}
