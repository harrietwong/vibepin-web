/**
 * test-product-link-display.ts — source-agnostic product-link display + the
 * neutral product UI across Create Pins / single Edit / Batch Edit.
 *
 * Run: npx tsx scripts/test-product-link-display.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveProductLinkDisplay, isAmazonProduct, linkDomain } from "../src/lib/studio/productLink";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK ${name}`); }

const AFF = "https://www.amazon.com/dp/B08N5WRWNW?tag=vibe-20";

// ── resolveProductLinkDisplay ───────────────────────────────────────────────
test("Amazon + affiliateUrl → Affiliate link", () => {
  const r = resolveProductLinkDisplay({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW", source: "amazon" }, AFF);
  assert.equal(r.url, AFF);
  assert.equal(r.label, "Affiliate link");
  assert.equal(r.isAffiliate, true);
});

test("Amazon without affiliateUrl → falls back to Product link", () => {
  const r = resolveProductLinkDisplay({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }, null);
  assert.equal(r.url, "https://www.amazon.com/dp/B08N5WRWNW");
  assert.equal(r.label, "Product link");
  assert.equal(r.isAffiliate, false);
});

test("Amazon detected by source text still uses affiliate", () => {
  const r = resolveProductLinkDisplay({ productUrl: "https://amzn.to/xyz", source: "Amazon" }, AFF);
  assert.equal(r.label, "Affiliate link");
});

test("non-Amazon product → Product link (original URL preserved, not hidden)", () => {
  const r = resolveProductLinkDisplay({ productUrl: "https://www.etsy.com/listing/123", source: "etsy" }, AFF);
  assert.equal(r.url, "https://www.etsy.com/listing/123"); // affiliate URL not applied to non-Amazon
  assert.equal(r.label, "Product link");
  assert.equal(r.isAffiliate, false);
});

test("no product URL → No product link (does not block anything)", () => {
  const r = resolveProductLinkDisplay({ source: "upload" }, null);
  assert.equal(r.url, null);
  assert.equal(r.label, "No product link");
});

test("isAmazonProduct: url / source / canonical", () => {
  assert.equal(isAmazonProduct({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }), true);
  assert.equal(isAmazonProduct({ canonicalUrl: "https://www.amazon.co.uk/dp/B08N5WRWNW" }), true);
  assert.equal(isAmazonProduct({ source: "amazon" }), true);
  assert.equal(isAmazonProduct({ productUrl: "https://etsy.com/x", source: "etsy" }), false);
});

test("linkDomain strips www", () => {
  assert.equal(linkDomain("https://www.etsy.com/listing/1"), "etsy.com");
  assert.equal(linkDomain(""), "");
});

// ── Create Pins: lower product card removed ─────────────────────────────────
test("Create Pins removed the lower 'Generating Pins for' card", () => {
  const studio = readFileSync("src/app/app/studio/page.tsx", "utf8");
  assert.doesNotMatch(studio, /Generating Pins for/);
  assert.doesNotMatch(studio, /data-testid="cp-affiliate-context"/);
});

// ── Single Pin Edit: neutral rows, no big Amazon banner ─────────────────────
test("Single Edit uses neutral per-row links (no dominant Amazon banner)", () => {
  const sec = readFileSync("src/components/pin-details/PinProductLinksSection.tsx", "utf8");
  assert.doesNotMatch(sec, /data-testid="pin-affiliate-context"/); // big banner gone
  assert.match(sec, /resolveProductLinkDisplay/);
  assert.match(sec, /data-testid="draft-product-link"/);
  assert.match(sec, /data-testid="draft-product-source-badge"/);
});

// ── Batch Edit: neutral summary + popover with per-product links ─────────────
test("Batch Edit product cell is neutral (source badge + link type, not Amazon-only)", () => {
  const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
  assert.doesNotMatch(batch, /data-testid="batch-edit-product-amazon"/); // old Amazon-specific chip gone
  assert.match(batch, /data-testid="batch-edit-product-source"/);
  assert.match(batch, /data-testid="batch-edit-product-linktype"/);
  assert.match(batch, /resolveProductLinkDisplay/);
});

test("Batch Edit has a lightweight product popover listing all products + links", () => {
  const batch = readFileSync("src/components/studio/BatchEditDrawer.tsx", "utf8");
  assert.match(batch, /data-testid="batch-edit-product-popover"/);
  assert.match(batch, /data-testid="batch-edit-popover-product"/);
  assert.match(batch, /data-testid="batch-edit-popover-link"/);
  assert.match(batch, /function ProductLinksPopover/);
});

console.log(`\nProduct link display: ${passed} passed, 0 failed`);
