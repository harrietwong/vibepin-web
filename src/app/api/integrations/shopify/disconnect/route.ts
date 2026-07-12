/**
 * Shopify disconnect (WP2, §6.9). Bearer.
 *
 * Best-effort revokes the Admin API token at Shopify, then soft-disconnects the
 * connection (token dropped, status=disconnected) and tombstones all of that
 * connection's synced products. Draft references are intentionally kept and
 * render as stale (§3.8). Idempotent — always returns { ok: true }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserIdFromBearer } from "@/lib/server/authUser";
import {
  getConnection,
  disconnect,
  decryptAccessToken,
} from "@/lib/server/shopify/connectionStore";
import { tombstoneAll } from "@/lib/server/shopify/productStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVOKE_TIMEOUT_MS = 8_000;

/** Best-effort Admin API token revocation. Never throws to the caller. */
async function revokeToken(shopDomain: string, token: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  try {
    await fetch(`https://${shopDomain}/admin/api_permissions/current.json`, {
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": token },
      signal: controller.signal,
    });
  } catch (err) {
    console.warn("[shopify/disconnect] token revoke failed (non-fatal):", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  const uid = await getUserIdFromBearer(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  let connectionId: string | null = null;
  try {
    const body = (await req.json()) as { connectionId?: string };
    connectionId = body?.connectionId ?? null;
  } catch {
    /* invalid body → handled below */
  }
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required", code: "bad_request" }, { status: 400 });
  }

  // Best-effort revoke with the still-decryptable token BEFORE dropping it.
  try {
    const conn = await getConnection(uid, connectionId);
    if (conn?.access_token_encrypted) {
      await revokeToken(conn.shop_domain, decryptAccessToken(conn));
    }
  } catch (err) {
    console.warn("[shopify/disconnect] pre-revoke lookup failed (non-fatal):", (err as Error).message);
  }

  try {
    await disconnect(connectionId, uid);
    await tombstoneAll(connectionId);
  } catch (err) {
    console.error("[shopify/disconnect] disconnect failed:", (err as Error).message);
    return NextResponse.json(
      { error: "Shopify store storage is unavailable", code: "database_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
