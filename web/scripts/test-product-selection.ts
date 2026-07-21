/**
 * Canonical ProductSelection tests (create-pin PRD Sections A + J).
 * Run: npx tsx scripts/test-product-selection.ts
 *
 * Covers: field preservation across the picker boundary (the fields the AI drawer
 * used to discard), public-URL derivation per source, the Shopify Admin-URL guard,
 * unsafe-scheme rejection, and the LinkedProduct round trip.
 */

import assert from "node:assert";
import {
  resolveProductPublicUrl,
  selectionFromAsset,
  selectionFromLinkedProduct,
  toLinkedProduct,
  type CanonicalProductSelection,
} from "../src/lib/studio/productSelection";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

// ── Field preservation ──────────────────────────────────────────────────────

test("asset -> selection keeps every commerce field the drawer used to drop", () => {
  const s = selectionFromAsset({
    id: "a1",
    title: "Linen Throw",
    imageUrl: "https://cdn/img.png",
    productUrl: "https://shop.example/products/linen-throw",
    canonicalUrl: "https://shop.example/products/linen-throw?variant=1",
    source: "shopify",
    store: "Shop Example",
    price: "48.00",
    currency: "USD",
  });
  assert.equal(s.id, "a1");
  assert.equal(s.title, "Linen Throw");
  assert.equal(s.imageUrl, "https://cdn/img.png");
  assert.equal(s.publicUrl, "https://shop.example/products/linen-throw");
  assert.equal(s.store, "Shop Example");
  assert.equal(s.price, "48.00");
  assert.equal(s.currency, "USD");
  assert.equal(s.source, "shopify");
});

test("asset -> selection falls back to sourceUrl when productUrl is absent", () => {
  const s = selectionFromAsset({ title: "T", sourceUrl: "https://example.com/p/1", source: "url" });
  assert.equal(s.publicUrl, "https://example.com/p/1");
  assert.equal(s.source, "url_imported");
});

test("source strings are normalised to the canonical kind", () => {
  assert.equal(selectionFromAsset({ title: "T", source: "product_signal" }).source, "product_ideas");
  assert.equal(selectionFromAsset({ title: "T", source: "upload" }).source, "upload");
  assert.equal(selectionFromAsset({ title: "T", source: "url_imported" }).source, "url_imported");
});

// ── Section J: public URL derivation per source ─────────────────────────────

test("Shopify prefers the canonical/storefront URL", () => {
  const s: CanonicalProductSelection = {
    title: "T", source: "shopify",
    publicUrl: "https://shop.example/products/a",
    canonicalUrl: "https://shop.example/products/a?ref=canonical",
  };
  assert.equal(resolveProductPublicUrl(s), "https://shop.example/products/a?ref=canonical");
});

test("Shopify NEVER returns an Admin URL", () => {
  const s: CanonicalProductSelection = {
    title: "T", source: "shopify",
    canonicalUrl: "https://admin.shopify.com/store/acme/products/123",
    publicUrl: "https://acme.myshopify.com/products/widget",
  };
  assert.equal(resolveProductPublicUrl(s), "https://acme.myshopify.com/products/widget");
});

test("Shopify with ONLY an Admin URL yields nothing rather than a bad link", () => {
  const s: CanonicalProductSelection = {
    title: "T", source: "shopify",
    canonicalUrl: "https://admin.shopify.com/store/acme/products/123",
  };
  assert.equal(resolveProductPublicUrl(s), undefined);
});

test("URL import uses the imported URL", () => {
  const s: CanonicalProductSelection = { title: "T", source: "url_imported", publicUrl: "https://brand.example/p/9" };
  assert.equal(resolveProductPublicUrl(s), "https://brand.example/p/9");
});

test("manual product uses the manually entered URL", () => {
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: "https://my.example/thing" };
  assert.equal(resolveProductPublicUrl(s), "https://my.example/thing");
});

test("Product Idea without a public URL stays empty — never invented", () => {
  const s: CanonicalProductSelection = { title: "Trending Mug", source: "product_ideas" };
  assert.equal(resolveProductPublicUrl(s), undefined);
});

test("Product Idea WITH a valid public URL uses it", () => {
  const s: CanonicalProductSelection = { title: "T", source: "product_ideas", publicUrl: "https://shop.example/p/7?tag=aff-20" };
  assert.equal(resolveProductPublicUrl(s), "https://shop.example/p/7?tag=aff-20", "attribution params preserved");
});

test("unsafe and non-http schemes are rejected", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "blob:https://a/b", "file:///etc/passwd", "ftp://x/y", "  "]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: bad };
    assert.equal(resolveProductPublicUrl(s), undefined, `${bad} must be rejected`);
  }
});

test("whitespace around a URL is trimmed", () => {
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: "  https://x.example/p  " };
  assert.equal(resolveProductPublicUrl(s), "https://x.example/p");
});

// ── LinkedProduct mapping ───────────────────────────────────────────────────

test("toLinkedProduct carries the derived public URL, not the raw admin one", () => {
  const lp = toLinkedProduct({
    id: "p1", title: "Widget", source: "shopify",
    canonicalUrl: "https://admin.shopify.com/store/a/products/1",
    publicUrl: "https://acme.myshopify.com/products/widget",
    imageUrl: "https://cdn/w.png", store: "Acme", price: "10", currency: "USD",
  });
  assert.equal(lp.productUrl, "https://acme.myshopify.com/products/widget");
  assert.equal(lp.productId, "p1");
  assert.equal(lp.store, "Acme");
  assert.equal(lp.linkType, "manual", "a picker choice is user-made, not auto-detected");
});

test("linkType is auto/manual and does NOT encode primary", () => {
  const asPrimary = toLinkedProduct({ title: "A", source: "manual", asPrimary: true });
  const asTagged = toLinkedProduct({ title: "A", source: "manual", asPrimary: false });
  assert.equal(asPrimary.linkType, "manual");
  assert.equal(asTagged.linkType, "manual", "primary is decided by primaryProductId, not linkType");
});

test("LinkedProduct round trip preserves the identifying fields", () => {
  const original = toLinkedProduct({
    id: "p9", title: "Round Trip", source: "url_imported",
    publicUrl: "https://x.example/p/9", imageUrl: "https://cdn/9.png",
    store: "X", price: "5", currency: "EUR",
  });
  const back = selectionFromLinkedProduct(original);
  assert.equal(back.id, "p9");
  assert.equal(back.title, "Round Trip");
  assert.equal(back.publicUrl, "https://x.example/p/9");
  assert.equal(back.imageUrl, "https://cdn/9.png");
  assert.equal(back.store, "X");
  assert.equal(back.price, "5");
  assert.equal(back.currency, "EUR");
  assert.equal(back.source, "url_imported");
});

test("a product with no URL produces a LinkedProduct with no productUrl", () => {
  const lp = toLinkedProduct({ title: "No Link", source: "product_ideas" });
  assert.equal(lp.productUrl, undefined, "empty, never a placeholder string");
  assert.equal(lp.title, "No Link");
});

console.log(`\nProduct selection: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
