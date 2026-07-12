/**
 * Shopify product picker query (WP3, §6.7). Bearer.
 *
 * GET ?connectionId&q&status=active|draft|archived&includeDeleted=false&cursor&limit(≤30)
 *   → { products: [...], nextCursor }
 *
 * Tombstoned rows are hidden unless includeDeleted (决策8). Not connected / table
 * not applied → { products: [], nextCursor: null } (裁决 i) — never a 500.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearer } from "@/lib/server/authUser";
import { listConnections } from "@/lib/server/shopify/connectionStore";
import { listProducts, type ListProductsParams } from "@/lib/server/shopify/productStore";
import { serializeProduct } from "./serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 30;

function parseStatus(raw: string | null): "active" | "draft" | "archived" | undefined {
  return raw === "active" || raw === "draft" || raw === "archived" ? raw : undefined;
}

export async function GET(req: NextRequest) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const limitRaw = Number.parseInt(sp.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : MAX_LIMIT;

  const params: ListProductsParams = {
    userId: uid,
    connectionId: sp.get("connectionId") ?? undefined,
    q: sp.get("q") ?? undefined,
    status: parseStatus(sp.get("status")),
    includeDeleted: sp.get("includeDeleted") === "true",
    cursor: sp.get("cursor"),
    limit,
  };

  try {
    // shop_domain per connection for admin URL derivation (degrades to [] on missing table).
    const shopByConn = new Map<string, string>();
    for (const conn of await listConnections(uid)) shopByConn.set(conn.id, conn.shop_domain);

    const { products, nextCursor } = await listProducts(params);
    return NextResponse.json({
      products: products.map((row) => serializeProduct(row, shopByConn.get(row.store_connection_id))),
      nextCursor,
    });
  } catch (err) {
    // Any storage failure presents as an empty picker rather than a 500 (裁决 i).
    console.error("[shopify/products] list failed:", (err as Error).message);
    return NextResponse.json({ products: [], nextCursor: null });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
