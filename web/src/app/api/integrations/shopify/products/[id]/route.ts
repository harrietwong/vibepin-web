/**
 * Shopify product detail + freshness (WP3, §6.8). Bearer.
 *
 * GET → row fields + images[] + stale{ deleted, archived, unavailable }.
 * Unknown / purged id → 404 not_found (client treats as deleted). Missing table
 * degrades to 404 (getProductWithImages → null).
 */

import { NextResponse } from "next/server";
import { getUserIdFromBearer } from "@/lib/server/authUser";
import { listConnections, StoreDatabaseError } from "@/lib/server/shopify/connectionStore";
import { getProductWithImages } from "@/lib/server/shopify/productStore";
import { serializeProduct } from "../serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id is required", code: "bad_request" }, { status: 400 });
  }

  try {
    const found = await getProductWithImages(uid, id);
    if (!found) {
      return NextResponse.json({ error: "Product not found", code: "not_found" }, { status: 404 });
    }
    const { product, images } = found;

    const shopByConn = new Map<string, string>();
    for (const conn of await listConnections(uid)) shopByConn.set(conn.id, conn.shop_domain);

    return NextResponse.json({
      ...serializeProduct(product, shopByConn.get(product.store_connection_id)),
      images: images.map((img) => ({
        id: img.id,
        url: img.source_image_url,
        width: img.width,
        height: img.height,
        altText: img.alt_text,
        position: img.position,
      })),
      stale: {
        deleted: product.deleted_at != null || product.status === "deleted",
        archived: product.status === "archived",
        unavailable: product.availability === "out_of_stock",
      },
    });
  } catch (err) {
    if (err instanceof StoreDatabaseError) {
      return NextResponse.json(
        { error: "Shopify store storage is unavailable", code: "database_unavailable" },
        { status: 503 },
      );
    }
    console.error("[shopify/products/[id]] read failed:", (err as Error).message);
    return NextResponse.json({ error: "Product not found", code: "not_found" }, { status: 404 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
