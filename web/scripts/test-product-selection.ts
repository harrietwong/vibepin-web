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

test("localhost / private / link-local hosts are rejected (PRD Section J)", () => {
  const bad = [
    "http://localhost:3000/p/1",
    "https://localhost/p",
    "http://127.0.0.1:8080/x",
    "http://0.0.0.0/x",
    "http://10.0.0.5/x",
    "http://192.168.1.10/x",
    "http://172.16.4.2/x",
    "http://169.254.1.1/x",
    "http://dev.local/p",
  ];
  for (const u of bad) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} is not a public destination`);
  }
});

test("malformed URLs are rejected", () => {
  for (const u of ["https://", "https:// example.com/p", "https://exa mple.com/p", "http://nohost"]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} must be rejected`);
  }
});

test("genuine public URLs still pass", () => {
  for (const u of ["https://shop.example.com/products/a", "http://brand.co.uk/p/1?ref=x"]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), u, `${u} must be accepted`);
  }
});

test("public IPv6 destinations are NOT rejected (regression guard)", () => {
  // Requiring a dot in the hostname rejected every IPv6 literal, since they use colons.
  const u = "https://[2606:4700:4700::1111]/product";
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
  assert.equal(resolveProductPublicUrl(s), u);
});

test("IPv4-mapped private/loopback addresses are rejected", () => {
  // The URL parser NORMALISES the dotted quad to hex — "::ffff:127.0.0.1" arrives as
  // "::ffff:7f00:1" — so a dotted-quad check alone silently lets these through.
  for (const u of [
    "https://[::ffff:127.0.0.1]/p",
    "https://[::ffff:10.0.0.1]/p",
    "https://[::ffff:192.168.1.1]/p",
    "https://[::ffff:172.16.0.1]/p",
    "https://[::ffff:169.254.1.1]/p",
  ]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} smuggles a private IPv4`);
  }
});

test("IPv4-compatible and 6to4 wrappers of private IPv4 are rejected", () => {
  // Two further ways to smuggle a private IPv4 through the IPv6 path:
  //   ::a.b.c.d           IPv4-compatible (normalised to ::7f00:1)
  //   2002:xxxx:yyyy::/16 6to4 — the two groups after 2002: ARE the IPv4
  for (const u of [
    "https://[::127.0.0.1]/",
    "https://[::10.0.0.1]/",
    "https://[2002:7f00:1::]/",     // 127.0.0.1
    "https://[2002:a00:1::]/",      // 10.0.0.1
    "https://[2002:c0a8:101::]/",   // 192.168.1.1
  ]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} wraps a private IPv4`);
  }
});

test("IPv4-translated, NAT64 and Teredo wrappers of private IPv4 are rejected", () => {
  // Matching each textual variant with its own regex kept missing new ones, so the
  // address is now expanded into eight groups and the embedded IPv4 read directly.
  for (const u of [
    "https://[::ffff:0:127.0.0.1]/",   // ::ffff:0:0/96 IPv4-translated
    "https://[64:ff9b::127.0.0.1]/",   // 64:ff9b::/96 NAT64
    "https://[2001:0:0:0::7f00:1]/",   // 2001:0::/32 Teredo
  ]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} wraps 127.0.0.1`);
  }
});

test("a public address in a wrapper range is still accepted", () => {
  // Teredo/NAT64 prefixes are only rejected when what they WRAP is private.
  const u = "https://[2001:4860:4860::8888]/";
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
  assert.equal(resolveProductPublicUrl(s), u);
});

test("6to4 wrapping a PUBLIC IPv4 is still accepted", () => {
  const u = "https://[2002:0808:0808::]/";   // 8.8.8.8
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
  assert.equal(resolveProductPublicUrl(s), u, "only PRIVATE wrapped addresses are rejected");
});

test("an IPv4-mapped PUBLIC address is still accepted", () => {
  const u = "https://[::ffff:8.8.8.8]/p";
  const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
  assert.equal(resolveProductPublicUrl(s), u);
});

test("non-public IPv6 ranges are rejected (brackets must not hide them)", () => {
  // URL.hostname keeps the brackets; matching only the bare literal "::1" let
  // link-local and unique-local addresses through as if they were public.
  for (const u of [
    "https://[::1]/product",        // loopback
    "https://[::]/product",         // unspecified
    "https://[fe80::1]/product",    // fe80::/10 link-local
    "https://[fc00::1]/product",    // fc00::/7 unique-local
    "https://[fd12:3456::1]/product",
  ]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), undefined, `${u} is not a public destination`);
  }
});

test("ports, uppercase hosts and punycode survive", () => {
  for (const u of ["https://Shop.Example.COM:8443/p/1", "https://xn--80ak6aa92e.com/p"]) {
    const s: CanonicalProductSelection = { title: "T", source: "manual", publicUrl: u };
    assert.equal(resolveProductPublicUrl(s), u, `${u} must be accepted`);
  }
});

test("the SERVER commerce id becomes LinkedProduct.productId, not the local asset id", () => {
  const s = selectionFromAsset({
    id: "local_asset_123", title: "Widget", source: "shopify",
    imageUrl: "https://cdn/w.png", productUrl: "https://acme.example/products/w",
    shopifyProductId: "sp_999",
  });
  assert.equal(s.id, "local_asset_123", "the local id is still carried");
  assert.deepEqual(s.commerceIds, { shopify: "sp_999" }, "server id kept SEPARATE");
  const lp = toLinkedProduct(s);
  assert.equal(lp.productId, "sp_999", "the link references the merchant's catalogue id");
});

test("a product with no server id still links by its local id", () => {
  const s = selectionFromAsset({ id: "local_1", title: "Upload", source: "upload", imageUrl: "https://cdn/u.png" });
  assert.equal(s.commerceIds, undefined);
  assert.equal(toLinkedProduct(s).productId, "local_1");
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
