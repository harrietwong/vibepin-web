/**
 * Shopify connection status (WP2, §6.5). Bearer-or-cookie.
 *
 * Returns { configured, connections: [safe status…], plan }. Token material never
 * appears (toSafeStatus). Missing v39 tables degrade to connections: [] (裁决 i) —
 * never a 500.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { resolvePlan, getEntitlements } from "@/lib/server/entitlements";
import { listConnections, toSafeStatus } from "@/lib/server/shopify/connectionStore";
import { isShopifyConfigured } from "@/lib/server/shopify/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await getUserIdFromBearerOrCookies(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const plan = await resolvePlan(uid);
  const { maxStores, maxSyncedProducts } = getEntitlements(plan);

  let connections: ReturnType<typeof toSafeStatus>[] = [];
  try {
    const rows = await listConnections(uid); // degrades to [] on missing table
    connections = rows.map(toSafeStatus);
  } catch (err) {
    // Any unexpected storage error → present as not-connected rather than 500.
    console.error("[shopify/status] list failed:", (err as Error).message);
    connections = [];
  }

  return NextResponse.json({
    configured: isShopifyConfigured(),
    connections,
    plan: { key: plan, maxStores, maxSyncedProducts },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
