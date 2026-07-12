/**
 * Shopify OAuth state seal/verify unit tests (WP2).
 * Run: npx tsx scripts/test-shopify-oauth-state.ts
 *
 * Covers: state generation, seal→verify roundtrip, expiry, uid mismatch,
 * shopDomain mismatch, state mismatch, single-use (missing cookie), tampered
 * cookie, shop-domain normalization on verify, and the returnTo /app/* allowlist.
 * Also asserts no plaintext (state/uid/shop) leaks into the sealed cookie value.
 */

import { randomBytes } from "node:crypto";

// Env must be set BEFORE the server modules load.
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

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
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER_UID = "22222222-2222-4222-8222-222222222222";
const SHOP = "demo-store.myshopify.com";

async function main() {
  const state = await import("../src/lib/server/shopify/oauthState");
  const { shopifyTokenCipher } = await import("../src/lib/server/shopify/connectionStore");

  console.log("\nShopify OAuth state tests\n");

  test("generateShopifyState returns 32 bytes of base64url", () => {
    const s = state.generateShopifyState();
    assert(/^[A-Za-z0-9_-]+$/.test(s), "base64url charset only");
    assertEq(Buffer.from(s, "base64url").length, 32, "decodes to 32 bytes");
  });

  test("seal → verify roundtrip returns uid, shopDomain, returnTo", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP, "/app/settings/shopify");
    const v = state.verifyShopifyState(cookie, s, UID, SHOP);
    assert(v.ok, "verdict ok");
    if (v.ok) {
      assertEq(v.uid, UID, "uid");
      assertEq(v.shopDomain, SHOP, "shopDomain");
      assertEq(v.returnTo, "/app/settings/shopify", "returnTo");
    }
  });

  test("verify fails on state mismatch", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP);
    const v = state.verifyShopifyState(cookie, "not-the-state", UID, SHOP);
    assert(!v.ok && v.reason === "mismatch", "state mismatch");
  });

  test("verify fails on uid mismatch", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP);
    const v = state.verifyShopifyState(cookie, s, OTHER_UID, SHOP);
    assert(!v.ok && v.reason === "user_mismatch", "uid mismatch");
  });

  test("verify fails on shopDomain mismatch", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP);
    const v = state.verifyShopifyState(cookie, s, UID, "other-store.myshopify.com");
    assert(!v.ok && v.reason === "shop_mismatch", "shop mismatch");
  });

  test("verify normalizes the shop param (scheme/case/trailing slash)", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP);
    const v = state.verifyShopifyState(cookie, s, UID, "https://Demo-Store.MyShopify.com/");
    assert(v.ok, "normalized shop param matches sealed domain");
  });

  test("verify fails when expired", () => {
    const s = state.generateShopifyState();
    // Craft a sealed payload with an already-past expiry.
    const cookie = shopifyTokenCipher.sealJson({
      state: s,
      uid: UID,
      shopDomain: SHOP,
      exp: Date.now() - 1000,
    });
    const v = state.verifyShopifyState(cookie, s, UID, SHOP);
    assert(!v.ok && v.reason === "expired", "expired");
  });

  test("single-use: a cleared (missing) cookie verifies as missing", () => {
    const s = state.generateShopifyState();
    const v = state.verifyShopifyState(undefined, s, UID, SHOP);
    assert(!v.ok && v.reason === "missing", "missing cookie");
  });

  test("tampered/garbage cookie unseals to missing", () => {
    const s = state.generateShopifyState();
    const v = state.verifyShopifyState("v1:not-real-ciphertext", s, UID, SHOP);
    assert(!v.ok && v.reason === "missing", "garbage cookie");
  });

  test("returnTo allowlist: only same-origin /app/* is kept", () => {
    assertEq(state.safeShopifyReturnTo("/app/settings/shopify"), "/app/settings/shopify", "app path kept");
    assertEq(state.safeShopifyReturnTo("/app/studio?x=1"), "/app/studio?x=1", "app path with query kept");
    assertEq(state.safeShopifyReturnTo("/settings"), undefined, "non-/app rejected");
    assertEq(state.safeShopifyReturnTo("//evil.com"), undefined, "protocol-relative rejected");
    assertEq(state.safeShopifyReturnTo("https://evil.com/app/x"), undefined, "absolute url rejected");
    assertEq(state.safeShopifyReturnTo(null), undefined, "null rejected");
  });

  test("seal drops a disallowed returnTo", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP, "https://evil.com/steal");
    const v = state.verifyShopifyState(cookie, s, UID, SHOP);
    assert(v.ok, "verify ok");
    if (v.ok) assertEq(v.returnTo, undefined, "disallowed returnTo dropped");
  });

  test("sealed cookie leaks no plaintext (state/uid/shop are encrypted)", () => {
    const s = state.generateShopifyState();
    const cookie = state.sealShopifyState(s, UID, SHOP, "/app/settings/shopify");
    assert(cookie.startsWith("v1:"), "v1 ciphertext prefix");
    assert(!cookie.includes(s), "no plaintext state");
    assert(!cookie.includes(UID), "no plaintext uid");
    assert(!cookie.includes(SHOP), "no plaintext shop domain");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
