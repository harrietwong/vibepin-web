/**
 * Shopify webhooks (WP2, §6.10). Single endpoint, dispatched by X-Shopify-Topic.
 *
 * Verifies the raw-body HMAC first (fail → 401). Then, per topic:
 *   app/uninstalled  → mark every active connection for the shop uninstalled +
 *                      disconnected, tombstone their products.
 *   shop/redact      → same as uninstalled, plus PHYSICALLY purge all store_*
 *                      rows for the shop (GDPR erasure).
 *   customers/data_request, customers/redact → no customer data is stored; log
 *                      and 200.
 *   (unknown topic)  → 200 ignore.
 *
 * All post-HMAC outcomes return 200 and are idempotent (safe on redelivery).
 * Missing v39 tables never 500 (store helpers degrade to no-ops).
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { verifyWebhookHmac } from "@/lib/server/shopify/hmac";
import {
  markUninstalled,
  normalizeShopDomain,
  isMissingTableError,
} from "@/lib/server/shopify/connectionStore";
import { tombstoneAll } from "@/lib/server/shopify/productStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ok = () => NextResponse.json({ ok: true });

/** Uninstall handling shared by app/uninstalled and shop/redact. */
async function handleUninstall(shopDomain: string): Promise<void> {
  const affected = await markUninstalled(shopDomain);
  for (const conn of affected) {
    await tombstoneAll(conn.id);
  }
}

/**
 * GDPR erasure: physically delete every store_connection for the shop. The v39
 * FKs cascade to store_products → store_product_images / store_product_variants,
 * so one delete purges the whole tree. Idempotent + missing-table safe.
 */
async function purgeShopData(shopDomain: string): Promise<void> {
  const supa = createServerClient();
  const norm = normalizeShopDomain(shopDomain);
  const { data, error } = await supa
    .from("store_connections")
    .select("id")
    .eq("shop_domain", norm);
  if (error) {
    if (isMissingTableError(error.code, error.message)) return;
    console.error("[shopify/webhooks] purge lookup failed:", error.message);
    return;
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return;
  const { error: delError } = await supa.from("store_connections").delete().in("id", ids);
  if (delError && !isMissingTableError(delError.code, delError.message)) {
    console.error("[shopify/webhooks] purge delete failed:", delError.message);
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  const header = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyWebhookHmac(raw, header)) {
    return NextResponse.json({ error: "Invalid HMAC signature", code: "hmac_invalid" }, { status: 401 });
  }

  const topic = (req.headers.get("x-shopify-topic") ?? "").toLowerCase();
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? "";

  try {
    switch (topic) {
      case "app/uninstalled":
        await handleUninstall(shopDomain);
        break;
      case "shop/redact":
        await handleUninstall(shopDomain);
        await purgeShopData(shopDomain);
        break;
      case "customers/data_request":
      case "customers/redact":
        // No customer PII is stored by this app — acknowledge only.
        console.log(`[shopify/webhooks] ${topic} acknowledged (no customer data stored)`);
        break;
      default:
        // Unknown/unhandled topic — acknowledge and ignore.
        break;
    }
  } catch (err) {
    // Never surface a 5xx once the HMAC is valid: handlers are idempotent, so a
    // 200 avoids Shopify retry storms while the failure is logged for follow-up.
    console.error(`[shopify/webhooks] handler error for ${topic}:`, (err as Error).message);
  }

  return ok();
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
