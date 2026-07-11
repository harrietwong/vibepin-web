/**
 * Shared §6.7/§6.8 product serialisation for the products routes (WP3).
 * Colocated non-route module — route files may only export HTTP handlers.
 */

import type { StoreProductRow } from "@/lib/server/shopify/productStore";

/** Read-time admin deep link (§4.2): not stored, derived from the owning shop. */
function adminUrl(shopDomain: string | undefined, externalProductId: string): string | null {
  return shopDomain ? `https://${shopDomain}/admin/products/${externalProductId}` : null;
}

export function serializeProduct(row: StoreProductRow, shopDomain: string | undefined) {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    productUrl: row.product_url,
    adminUrl: adminUrl(shopDomain, row.external_product_id),
    status: row.status,
    availability: row.availability,
    vendor: row.vendor,
    productType: row.product_type,
    tags: row.tags ?? [],
    price: {
      amount: row.price_amount,
      currency: row.currency,
      compareAt: row.compare_at_price,
    },
    primaryImageUrl: row.primary_image_url,
    imageCount: row.image_count,
    updatedAtSource: row.updated_at_source,
    deletedAt: row.deleted_at,
  };
}
