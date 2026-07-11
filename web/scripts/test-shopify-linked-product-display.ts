/**
 * WP7 unit tests — PinDetailsDrawer linked-product display + destination safety
 * (Phase 1 implementation plan §7.5/§7.6/§10 WP7). Run: npx tsx
 * scripts/test-shopify-linked-product-display.ts
 *
 * Covers:
 *  - freshnessFromProductDetail: stale{deleted,archived,unavailable} → state,
 *    with deleted > archived > unavailable priority when more than one is set.
 *  - shopifyFreshnessBadge: state → badge text/tone mapping (the three visible
 *    strings from §7.5: amber "Product no longer in your store" / amber
 *    "Product archived" / gray "Out of stock"; null → no badge).
 *  - getShopifyProductFreshness: 404 → "deleted" (purged product), any other
 *    failure (5xx/network) rejects so the caller (PinDetailsDrawer) can stay
 *    silent per §7.5 ("请求失败→静默不显示" — freshness is an enhancement, never
 *    a gate); 60s cache hit does not re-issue the network request; different
 *    product ids never share a cache entry; invalidate forces a refetch.
 *  - buildUseAsDestinationConfirm: confirm copy for "Use as destination URL" —
 *    zero regression on the pre-existing fresh-product paths (§4G: warnings
 *    never block) plus the new stale-product warning suffix, including the
 *    previously-silent empty-destination path now getting one confirm when
 *    the product is stale/deleted (§7.5 "空 URL 直填场景...也弹一次 confirm").
 *  - BatchEditDrawer.tsx "product" URL mode source is untouched (§7.6: zero
 *    code changes there — WP7 only adds test coverage + copy verification).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Dummy env so importing the Supabase browser client chain never throws.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

export {};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── Mock fetch for /api/integrations/shopify/products/[id] ──────────────────

type Call = { url: string };
const calls: Call[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function staleFlags(overrides: Partial<{ deleted: boolean; archived: boolean; unavailable: boolean }> = {}) {
  return { deleted: false, archived: false, unavailable: false, ...overrides };
}

/** id → response script. Missing id → { status: 404 } (unknown/purged product). */
const PRODUCT_SCRIPT: Record<string, { status: number; body?: Record<string, unknown> }> = {
  "p-fresh":     { status: 200, body: { id: "p-fresh", stale: staleFlags() } },
  "p-deleted":   { status: 200, body: { id: "p-deleted", stale: staleFlags({ deleted: true, archived: true, unavailable: true }) } },
  "p-archived":  { status: 200, body: { id: "p-archived", stale: staleFlags({ archived: true, unavailable: true }) } },
  "p-oos":       { status: 200, body: { id: "p-oos", stale: staleFlags({ unavailable: true }) } },
  "p-error":     { status: 500, body: { error: "Shopify store storage is unavailable", code: "database_unavailable" } },
};

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  calls.push({ url });
  const m = url.match(/\/api\/integrations\/shopify\/products\/([^/?]+)/);
  const id = m ? decodeURIComponent(m[1]) : "";
  const entry = PRODUCT_SCRIPT[id];
  if (!entry) return jsonResponse(404, { error: "Product not found", code: "not_found" });
  return jsonResponse(entry.status, entry.body ?? {});
};

function countCalls(match: string): number {
  return calls.filter(c => c.url.includes(match)).length;
}

async function main() {
  const client = await import("../src/lib/shopifyClient");
  const drawer = await import("../src/components/studio/PinDetailsDrawer");

  console.log("\nshopify linked-product display (WP7) tests\n");

  // ── freshnessFromProductDetail: stale flags → state, priority order ──────

  await test("all stale flags false → null (fresh product)", () => {
    assertEq(client.freshnessFromProductDetail({ stale: staleFlags() }), null, "fresh product must map to null");
  });

  await test("deleted true → \"deleted\", even when archived/unavailable are also true", () => {
    assertEq(
      client.freshnessFromProductDetail({ stale: staleFlags({ deleted: true, archived: true, unavailable: true }) }),
      "deleted",
      "deleted must take priority over archived/unavailable",
    );
  });

  await test("archived true (deleted false) → \"archived\", even when unavailable is also true", () => {
    assertEq(
      client.freshnessFromProductDetail({ stale: staleFlags({ archived: true, unavailable: true }) }),
      "archived",
      "archived must take priority over unavailable when not deleted",
    );
  });

  await test("unavailable true alone → \"unavailable\"", () => {
    assertEq(
      client.freshnessFromProductDetail({ stale: staleFlags({ unavailable: true }) }),
      "unavailable",
      "unavailable alone must map to unavailable",
    );
  });

  // ── shopifyFreshnessBadge: state → visible badge text/tone (§7.5) ───────

  await test("null state → no badge", () => {
    assertEq(drawer.shopifyFreshnessBadge(null), null, "fresh product must show no badge");
  });

  await test("deleted → amber \"Product no longer in your store\"", () => {
    const badge = drawer.shopifyFreshnessBadge("deleted");
    assert(badge !== null, "deleted must produce a badge");
    assertEq(badge!.text, "Product no longer in your store", "deleted badge text must match §7.5");
    assertEq(badge!.tone, "amber", "deleted badge must be amber");
  });

  await test("archived → amber \"Product archived\"", () => {
    const badge = drawer.shopifyFreshnessBadge("archived");
    assert(badge !== null, "archived must produce a badge");
    assertEq(badge!.text, "Product archived", "archived badge text must match §7.5");
    assertEq(badge!.tone, "amber", "archived badge must be amber");
  });

  await test("unavailable → gray \"Out of stock\"", () => {
    const badge = drawer.shopifyFreshnessBadge("unavailable");
    assert(badge !== null, "unavailable must produce a badge");
    assertEq(badge!.text, "Out of stock", "unavailable badge text must match §7.5");
    assertEq(badge!.tone, "gray", "unavailable badge must be gray, not amber");
  });

  // ── getShopifyProductFreshness: network mapping + 404 + silent-failure contract ──

  await test("fresh product resolves null", async () => {
    client.invalidateShopifyProductFreshnessCache();
    calls.length = 0;
    const state = await client.getShopifyProductFreshness("p-fresh");
    assertEq(state, null, "fresh product must resolve null");
  });

  await test("deleted product resolves \"deleted\"", async () => {
    client.invalidateShopifyProductFreshnessCache();
    const state = await client.getShopifyProductFreshness("p-deleted");
    assertEq(state, "deleted", "deleted product must resolve deleted");
  });

  await test("archived product resolves \"archived\"", async () => {
    client.invalidateShopifyProductFreshnessCache();
    const state = await client.getShopifyProductFreshness("p-archived");
    assertEq(state, "archived", "archived product must resolve archived");
  });

  await test("out-of-stock product resolves \"unavailable\"", async () => {
    client.invalidateShopifyProductFreshnessCache();
    const state = await client.getShopifyProductFreshness("p-oos");
    assertEq(state, "unavailable", "out-of-stock product must resolve unavailable");
  });

  await test("404 (purged/unknown product) resolves \"deleted\", does not throw", async () => {
    client.invalidateShopifyProductFreshnessCache();
    const state = await client.getShopifyProductFreshness("p-does-not-exist");
    assertEq(state, "deleted", "404 must resolve deleted, matching the products/[id] route's documented contract");
  });

  await test("a non-404 failure rejects — callers must catch it and stay silent (§7.5)", async () => {
    client.invalidateShopifyProductFreshnessCache();
    let threw = false;
    try {
      await client.getShopifyProductFreshness("p-error");
    } catch {
      threw = true;
    }
    assert(threw, "a 5xx/network failure must reject so PinDetailsDrawer's .catch(() => {}) is what silences it — never resolve to a false state");
  });

  await test("a cache hit within 60s does not re-issue the network request", async () => {
    client.invalidateShopifyProductFreshnessCache();
    calls.length = 0;
    await client.getShopifyProductFreshness("p-fresh");
    assertEq(countCalls("p-fresh"), 1, "first call must hit the network");
    calls.length = 0;
    await client.getShopifyProductFreshness("p-fresh");
    assertEq(countCalls("p-fresh"), 0, "second call within TTL must be served from cache");
  });

  await test("cache expires after 60s and refetches", async () => {
    client.invalidateShopifyProductFreshnessCache();
    const realNow = Date.now;
    let fakeNow = realNow();
    (Date as unknown as { now: () => number }).now = () => fakeNow;
    try {
      calls.length = 0;
      await client.getShopifyProductFreshness("p-fresh");
      assertEq(countCalls("p-fresh"), 1, "sanity: first call hits network");
      fakeNow += 61_000;
      calls.length = 0;
      await client.getShopifyProductFreshness("p-fresh");
      assertEq(countCalls("p-fresh"), 1, "must refetch once the 60s TTL has elapsed");
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
  });

  await test("different product ids never share a cache entry", async () => {
    client.invalidateShopifyProductFreshnessCache();
    calls.length = 0;
    const [fresh, deleted] = await Promise.all([
      client.getShopifyProductFreshness("p-fresh"),
      client.getShopifyProductFreshness("p-deleted"),
    ]);
    assertEq(fresh, null, "p-fresh must resolve its own state");
    assertEq(deleted, "deleted", "p-deleted must resolve its own state, not p-fresh's cached value");
    assertEq(countCalls("p-fresh"), 1, "p-fresh must be fetched once");
    assertEq(countCalls("p-deleted"), 1, "p-deleted must be fetched once");
  });

  await test("invalidateShopifyProductFreshnessCache(id) forces the next call for that id to refetch", async () => {
    client.invalidateShopifyProductFreshnessCache();
    await client.getShopifyProductFreshness("p-fresh"); // populate cache
    calls.length = 0;
    client.invalidateShopifyProductFreshnessCache("p-fresh");
    await client.getShopifyProductFreshness("p-fresh");
    assertEq(countCalls("p-fresh"), 1, "invalidating one id must force a fresh network read for it");
  });

  await test("3 concurrent callers for the same id coalesce into 1 network request", async () => {
    client.invalidateShopifyProductFreshnessCache();
    calls.length = 0;
    const [a, b, c] = await Promise.all([
      client.getShopifyProductFreshness("p-archived"),
      client.getShopifyProductFreshness("p-archived"),
      client.getShopifyProductFreshness("p-archived"),
    ]);
    assertEq(countCalls("p-archived"), 1, "concurrent callers for the same id must coalesce into one request");
    assertEq(a, "archived", "all concurrent callers must see the resolved state");
    assertEq(b, "archived", "all concurrent callers must see the resolved state");
    assertEq(c, "archived", "all concurrent callers must see the resolved state");
  });

  // ── buildUseAsDestinationConfirm: confirm copy incl. zero-regression paths ──

  await test("empty destination + fresh product → null (silent direct fill, unchanged from before WP7)", () => {
    const msg = drawer.buildUseAsDestinationConfirm({ destinationIsFilled: false, freshness: null });
    assertEq(msg, null, "the pre-existing silent-fill behavior for a fresh product must not regress");
  });

  await test("filled destination + fresh product → the exact pre-existing confirm text (zero regression)", () => {
    const msg = drawer.buildUseAsDestinationConfirm({ destinationIsFilled: true, freshness: null });
    assertEq(msg, "Replace the current destination URL with the primary product URL?",
      "the confirm text for a fresh product must match the original literal exactly");
  });

  await test("empty destination + deleted product → now shows one confirm mentioning the product is gone", () => {
    const msg = drawer.buildUseAsDestinationConfirm({ destinationIsFilled: false, freshness: "deleted" });
    assert(msg !== null, "§7.5: an empty-fill against a deleted product must no longer be fully silent");
    assert(msg!.startsWith("Use the primary product URL as the destination?"), "base question must still be asked");
    assert(msg!.includes("no longer in your store"), "warning must explain the product is gone");
  });

  await test("filled destination + archived product → original question plus an archived warning suffix", () => {
    const msg = drawer.buildUseAsDestinationConfirm({ destinationIsFilled: true, freshness: "archived" });
    assert(msg!.startsWith("Replace the current destination URL with the primary product URL?"),
      "original replace-confirm question must be preserved verbatim as a prefix");
    assert(msg!.includes("archived"), "warning must mention the product was archived");
  });

  await test("filled destination + out-of-stock product → warning mentions stock, not link failure", () => {
    const msg = drawer.buildUseAsDestinationConfirm({ destinationIsFilled: true, freshness: "unavailable" });
    assert(msg!.includes("out of stock"), "out-of-stock warning must mention stock status, not a broken link");
  });

  // ── §7.6: BatchEditDrawer.tsx "product" URL mode must be untouched ───────

  const batchEditSource = readFileSync(join(process.cwd(), "src/components/studio/BatchEditDrawer.tsx"), "utf8");

  await test("BatchEditDrawer 'product' destination mode still uses each Pin's own primary product URL", () => {
    assert(
      batchEditSource.includes("Set each selected Pin's Website URL to its own primary product URL, where one"),
      "the per-Pin primary-product-URL semantics comment must be present and unchanged",
    );
    assert(
      batchEditSource.includes("exists. Never fails the whole batch — Pins without a product URL are left as-is."),
      "the 'skip Pins without a product URL' semantics comment must be present and unchanged",
    );
    assert(batchEditSource.includes('if (mode === "product")'), "the product mode branch must still exist");
    assert(
      batchEditSource.includes("effProducts(p, rowEdits).primary?.productUrl?.trim()"),
      "product mode must still read each Pin's own primary product URL via effProducts()",
    );
    assert(batchEditSource.includes("if (!productUrl) { missing++; continue; }"),
      "Pins without a product URL must still be skipped (counted as missing), not fail the batch");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
