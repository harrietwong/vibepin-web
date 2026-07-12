/**
 * test-pin-display-context.ts — the unified Pin Display Context Layer.
 * Run: npx tsx scripts/test-pin-display-context.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPinDisplayContext, type PinDisplayDeps } from "../src/lib/studio/pinDisplayContext";
import type { CreatorProductLink } from "../src/lib/affiliate/creatorProductLink";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

const readyLink: CreatorProductLink = {
  id: "cpl_1", productId: "prod_1", provider: "amazon", marketplace: "US",
  asin: "B08N5WRWNW", trackingId: "vibe-20",
  canonicalProductUrl: "https://www.amazon.com/dp/B08N5WRWNW",
  affiliateUrl: "https://www.amazon.com/dp/B08N5WRWNW?tag=vibe-20",
  status: "ready", createdAt: "2026-06-01", updatedAt: "2026-06-01",
};

const amazonProduct = {
  id: "prod_1", title: "Rattan Chair", imageUrl: "https://cdn/chair.jpg",
  productUrl: "https://www.amazon.com/dp/B08N5WRWNW", source: "url",
};

function deps(over: Partial<{ products: Record<string, unknown>; links: Record<string, CreatorProductLink> }> = {}): PinDisplayDeps {
  const products = over.products ?? { prod_1: amazonProduct };
  const links = over.links ?? { cpl_1: readyLink };
  return {
    getProductById: id => (products[id] as never) ?? null,
    getLinkById: id => links[id] ?? null,
  };
}

// ── Amazon Pin: full context ────────────────────────────────────────────────
test("Amazon Pin resolves title, image, ASIN, affiliate + destination URL", () => {
  const ctx = getPinDisplayContext({
    productId: "prod_1", creatorProductLinkId: "cpl_1",
    destinationUrl: "https://www.amazon.com/dp/B08N5WRWNW?tag=vibe-20",
  }, deps());
  assert.equal(ctx.productTitle, "Rattan Chair");
  assert.equal(ctx.productImage, "https://cdn/chair.jpg");
  assert.equal(ctx.asin, "B08N5WRWNW");
  assert.equal(ctx.affiliateUrl, "https://www.amazon.com/dp/B08N5WRWNW?tag=vibe-20");
  assert.equal(ctx.destinationUrl, "https://www.amazon.com/dp/B08N5WRWNW?tag=vibe-20");
  assert.equal(ctx.productSource, "amazon");
  assert.equal(ctx.hasProduct, true);
  assert.equal(ctx.linkStatus, "ready");
});

// ── destinationUrl always straight from the Pin ─────────────────────────────
test("destinationUrl comes from the Pin, never invented", () => {
  const ctx = getPinDisplayContext({ productId: "prod_1", destinationUrl: "https://custom.example/landing" }, deps());
  assert.equal(ctx.destinationUrl, "https://custom.example/landing");
  const none = getPinDisplayContext({ productId: "prod_1" }, deps());
  assert.equal(none.destinationUrl, null);
});

// ── ASIN from link preferred, else parsed from URL ──────────────────────────
test("ASIN falls back to parsing product URL when no link", () => {
  const ctx = getPinDisplayContext({ productId: "prod_1" }, deps({ links: {} }));
  assert.equal(ctx.asin, "B08N5WRWNW");
  assert.equal(ctx.affiliateUrl, null); // no ready link → no affiliate URL
  assert.equal(ctx.productSource, "amazon");
});

// ── Affiliate URL only from a ready link ────────────────────────────────────
test("needs_setup / failed link never surfaces an affiliate URL", () => {
  const needs: CreatorProductLink = { ...readyLink, status: "needs_setup", affiliateUrl: "" };
  const ctx = getPinDisplayContext({ productId: "prod_1", creatorProductLinkId: "cpl_1" }, deps({ links: { cpl_1: needs } }));
  assert.equal(ctx.affiliateUrl, null);
  assert.equal(ctx.linkStatus, "needs_setup");
  // ASIN still resolves from the link.
  assert.equal(ctx.asin, "B08N5WRWNW");
});

// ── linkedProducts (primary) resolution ─────────────────────────────────────
test("resolves product from linkedProducts primary", () => {
  const ctx = getPinDisplayContext({
    primaryProductId: "p2",
    linkedProducts: [
      { productId: "p1", title: "Other", source: "url_imported", linkType: "manual" },
      { productId: "p2", title: "Primary Lamp", imageUrl: "https://cdn/lamp.jpg", productUrl: "https://www.amazon.com/dp/B07XYZ1234", source: "url_imported", linkType: "manual" },
    ],
  }, deps({ products: {} }));
  assert.equal(ctx.productTitle, "Primary Lamp");
  assert.equal(ctx.productImage, "https://cdn/lamp.jpg");
  assert.equal(ctx.asin, "B07XYZ1234");
  assert.equal(ctx.productSource, "amazon");
});

// ── Batch row single-product fields ─────────────────────────────────────────
test("resolves product from Batch Edit row linkedProduct* fields", () => {
  const ctx = getPinDisplayContext({
    linkedProductId: "pX", linkedProductTitle: "Batch Product",
    linkedProductImageUrl: "https://cdn/b.jpg", linkedProductUrl: "https://www.amazon.com/dp/B00TEST123",
    linkedProductSource: "amazon",
  }, deps({ products: {} }));
  assert.equal(ctx.productTitle, "Batch Product");
  assert.equal(ctx.productImage, "https://cdn/b.jpg");
  assert.equal(ctx.asin, "B00TEST123");
  assert.equal(ctx.hasProduct, true);
});

// ── Non-Amazon product ──────────────────────────────────────────────────────
test("non-Amazon product → productSource other, no ASIN / affiliate", () => {
  const ctx = getPinDisplayContext({ productId: "etsy1" }, deps({
    products: { etsy1: { id: "etsy1", title: "Handmade Vase", imageUrl: "https://cdn/v.jpg", productUrl: "https://etsy.com/listing/9" } },
    links: {},
  }));
  assert.equal(ctx.productSource, "other");
  assert.equal(ctx.asin, null);
  assert.equal(ctx.affiliateUrl, null);
  assert.equal(ctx.productTitle, "Handmade Vase");
  assert.equal(ctx.hasProduct, true);
});

// ── sourceProductImageUrl image fallback ────────────────────────────────────
test("sourceProductImageUrl fills productImage when product record has none", () => {
  const ctx = getPinDisplayContext({
    productId: "prod_1", sourceProductImageUrl: "https://cdn/fallback.jpg",
  }, deps({ products: { prod_1: { id: "prod_1", title: "No Image Product", productUrl: "https://www.amazon.com/dp/B08N5WRWNW" } } }));
  assert.equal(ctx.productImage, "https://cdn/fallback.jpg");
});

// ── Orphan / empty Pin ──────────────────────────────────────────────────────
test("Pin with no product context returns empty, hasProduct false", () => {
  const ctx = getPinDisplayContext({ destinationUrl: "" }, deps({ products: {}, links: {} }));
  assert.equal(ctx.hasProduct, false);
  assert.equal(ctx.productTitle, null);
  assert.equal(ctx.productImage, null);
  assert.equal(ctx.productSource, "other");
});

test("null/undefined pin returns a safe empty context", () => {
  const ctx = getPinDisplayContext(null);
  assert.equal(ctx.hasProduct, false);
  assert.equal(ctx.destinationUrl, null);
});

// ── UI wiring (structure) ───────────────────────────────────────────────────
test("Edit Pin modal + Batch Edit + Plan drawer consume getPinDisplayContext", () => {
  const modal = readFileSync("src/components/pin-details/PinProductLinksSection.tsx", "utf8");
  const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
  const planDrawer = readFileSync("src/components/plan/DraftDetailsDrawer.tsx", "utf8");
  assert.match(modal, /getPinDisplayContext/);
  assert.match(batch, /getPinDisplayContext/);
  assert.match(planDrawer, /getPinDisplayContext/);
});

console.log(`\nPin display context: ${passed} passed, 0 failed`);
