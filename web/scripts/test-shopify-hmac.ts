/**
 * Shopify HMAC verification unit tests (WP2).
 * Run: npx tsx scripts/test-shopify-hmac.ts
 *
 * Covers launch query HMAC (positive / tampered / reordered / missing param /
 * missing hmac / unicode value) and webhook body HMAC (positive / tampered body /
 * bad base64 header / empty header), plus timing-safe length-mismatch behaviour.
 * No network, no DB — only the client secret env is needed.
 */

import { createHmac } from "node:crypto";

const SECRET = "shpss_test_client_secret_value";
// Must be set BEFORE the hmac module loads (it reads SHOPIFY_CLIENT_SECRET).
process.env.SHOPIFY_CLIENT_SECRET = SECRET;

export {};

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
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

/** Reference launch-query signature: sorted keys, k=v joined by &, HMAC-SHA256 hex. */
function signQuery(pairs: Record<string, string>): string {
  const message = Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join("&");
  return createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
}

function signBody(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
}

async function main() {
  const { verifyLaunchQueryHmac, verifyWebhookHmac } = await import("../src/lib/server/shopify/hmac");

  console.log("\nShopify HMAC tests\n");

  const basePairs = {
    shop: "demo-store.myshopify.com",
    timestamp: "1720000000",
    host: "YWRtaW4uc2hvcGlmeS5jb20",
    code: "abc123",
  };

  test("launch: valid signature verifies", () => {
    const hmac = signQuery(basePairs);
    const params = new URLSearchParams({ ...basePairs, hmac });
    assert(verifyLaunchQueryHmac(params), "expected valid signature to verify");
  });

  test("launch: param order does not matter (keys are sorted)", () => {
    const hmac = signQuery(basePairs);
    // Insert in a deliberately different order, hmac first.
    const params = new URLSearchParams();
    params.set("hmac", hmac);
    params.set("code", basePairs.code);
    params.set("shop", basePairs.shop);
    params.set("host", basePairs.host);
    params.set("timestamp", basePairs.timestamp);
    assert(verifyLaunchQueryHmac(params), "reordered params should still verify");
  });

  test("launch: tampered value fails", () => {
    const hmac = signQuery(basePairs);
    const params = new URLSearchParams({ ...basePairs, hmac });
    params.set("shop", "evil-store.myshopify.com");
    assert(!verifyLaunchQueryHmac(params), "tampered value must fail");
  });

  test("launch: wrong hmac fails", () => {
    const params = new URLSearchParams({ ...basePairs, hmac: "deadbeef" });
    assert(!verifyLaunchQueryHmac(params), "wrong hmac must fail");
  });

  test("launch: missing hmac param fails", () => {
    const params = new URLSearchParams({ ...basePairs });
    assert(!verifyLaunchQueryHmac(params), "missing hmac must fail");
  });

  test("launch: dropping a signed param fails (message differs)", () => {
    const hmac = signQuery(basePairs);
    const params = new URLSearchParams({ ...basePairs, hmac });
    params.delete("code");
    assert(!verifyLaunchQueryHmac(params), "removing a signed param must fail");
  });

  test("launch: adding an unsigned param fails", () => {
    const hmac = signQuery(basePairs);
    const params = new URLSearchParams({ ...basePairs, hmac });
    params.set("injected", "1");
    assert(!verifyLaunchQueryHmac(params), "extra param must fail");
  });

  test("launch: unicode values verify (utf8 message)", () => {
    const uniPairs = { ...basePairs, name: "日本のお店 café" };
    const hmac = signQuery(uniPairs);
    const params = new URLSearchParams({ ...uniPairs, hmac });
    assert(verifyLaunchQueryHmac(params), "unicode value should verify");
  });

  test("webhook: valid signature verifies", () => {
    const body = JSON.stringify({ id: 12345, note: "café" });
    assert(verifyWebhookHmac(body, signBody(body)), "valid webhook hmac should verify");
  });

  test("webhook: tampered body fails", () => {
    const body = JSON.stringify({ id: 12345 });
    const header = signBody(body);
    assert(!verifyWebhookHmac(body + " ", header), "tampered body must fail");
  });

  test("webhook: bad base64 header fails (no throw)", () => {
    const body = "{}";
    assert(!verifyWebhookHmac(body, "!!!not-base64!!!"), "bad base64 header must fail safely");
  });

  test("webhook: empty / null header fails", () => {
    const body = "{}";
    assert(!verifyWebhookHmac(body, ""), "empty header must fail");
    assert(!verifyWebhookHmac(body, null), "null header must fail");
  });

  test("timing-safe: length-mismatched hmac fails without throwing", () => {
    const params = new URLSearchParams({ ...basePairs, hmac: "ab" });
    assert(!verifyLaunchQueryHmac(params), "short hmac must fail via length check");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
