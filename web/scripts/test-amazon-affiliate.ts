/**
 * test-amazon-affiliate.ts — Amazon affiliate product-link foundation.
 *
 * Run: npx tsx scripts/test-amazon-affiliate.ts
 */
import assert from "node:assert/strict";

import {
  buildAmazonAffiliateUrl,
  buildCanonicalProductUrl,
  extractAsin,
  isAmazonUrl,
  isValidAsin,
  normalizeMarketplace,
} from "../src/lib/affiliate/amazon";
import {
  getOrCreateCreatorProductLink,
  createInMemoryRepo,
  type CreatorProductLink,
} from "../src/lib/affiliate/creatorProductLink";
import type { AmazonAffiliateSettings } from "../src/lib/affiliate/amazonAffiliateSettings";
import {
  applyCreatorProductLinkToPinDraft,
  preserveAffiliateContextOnRegenerate,
  CREATOR_AFFILIATE_SOURCE,
  MANUAL_DESTINATION_SOURCE,
  type AffiliatePinFields,
} from "../src/lib/affiliate/pinAffiliateInheritance";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const settings = (over: Partial<AmazonAffiliateSettings> = {}): AmazonAffiliateSettings => ({
  marketplace: "US",
  trackingId: "harriet-20",
  enabled: true,
  ...over,
});

// ── 1. Amazon affiliate URL generation from ASIN ───────────────────────────────
test("buildAmazonAffiliateUrl: builds US URL with tag from ASIN", () => {
  const url = buildAmazonAffiliateUrl({ asin: "B08N5WRWNW", marketplace: "US", trackingId: "harriet-20" });
  assert.equal(url, "https://www.amazon.com/dp/B08N5WRWNW?tag=harriet-20");
});

test("buildAmazonAffiliateUrl: respects marketplace domain (UK)", () => {
  const url = buildAmazonAffiliateUrl({ asin: "b08n5wrwnw", marketplace: "UK", trackingId: "harriet-21" });
  assert.equal(url, "https://www.amazon.co.uk/dp/B08N5WRWNW?tag=harriet-21");
});

test("buildAmazonAffiliateUrl: deterministic for the same inputs", () => {
  const a = buildAmazonAffiliateUrl({ asin: "B08N5WRWNW", marketplace: "DE", trackingId: "t-99" });
  const b = buildAmazonAffiliateUrl({ asin: "B08N5WRWNW", marketplace: "DE", trackingId: "t-99" });
  assert.equal(a, b);
});

test("buildAmazonAffiliateUrl: missing ASIN returns empty (no fake URL)", () => {
  assert.equal(buildAmazonAffiliateUrl({ asin: "", marketplace: "US", trackingId: "harriet-20" }), "");
  assert.equal(buildAmazonAffiliateUrl({ asin: "NOT-AN-ASIN", marketplace: "US", trackingId: "harriet-20" }), "");
});

test("buildAmazonAffiliateUrl: missing trackingId returns empty", () => {
  assert.equal(buildAmazonAffiliateUrl({ asin: "B08N5WRWNW", marketplace: "US", trackingId: "" }), "");
});

test("isValidAsin / normalizeMarketplace / canonical url", () => {
  assert.equal(isValidAsin("B08N5WRWNW"), true);
  assert.equal(isValidAsin("short"), false);
  assert.equal(normalizeMarketplace("jp"), "JP");
  assert.equal(normalizeMarketplace("ZZ"), "US");
  assert.equal(buildCanonicalProductUrl("B08N5WRWNW", "US"), "https://www.amazon.com/dp/B08N5WRWNW");
});

test("extractAsin: from /dp/, /gp/product/, bare ASIN, and ?asin=", () => {
  assert.equal(extractAsin("https://www.amazon.com/dp/B08N5WRWNW/ref=foo"), "B08N5WRWNW");
  assert.equal(extractAsin("https://www.amazon.co.uk/gp/product/B08N5WRWNW?th=1"), "B08N5WRWNW");
  assert.equal(extractAsin("B08N5WRWNW"), "B08N5WRWNW");
  assert.equal(extractAsin("https://example.com/store?asin=B08N5WRWNW"), "B08N5WRWNW");
  assert.equal(extractAsin("https://example.com/no-asin-here"), null);
});

test("isAmazonUrl: detects marketplace + short links", () => {
  assert.equal(isAmazonUrl("https://www.amazon.com/dp/B08N5WRWNW"), true);
  assert.equal(isAmazonUrl("https://amzn.to/3abc"), true);
  assert.equal(isAmazonUrl("https://etsy.com/listing/123"), false);
});

// ── 2/4. getOrCreateCreatorProductLink ─────────────────────────────────────────
test("getOrCreate: non-Amazon product returns null (unsupported)", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", productUrl: "https://etsy.com/listing/1", imageUrl: "img" },
    settings(),
    repo,
  );
  assert.equal(link, null);
});

test("getOrCreate: missing trackingId returns needs_setup (not persisted)", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", provider: "amazon", asin: "B08N5WRWNW" },
    settings({ trackingId: "", enabled: false }),
    repo,
  );
  assert.ok(link);
  assert.equal(link!.status, "needs_setup");
  assert.equal(link!.affiliateUrl, "");
  assert.equal(repo.all().length, 0);
});

test("getOrCreate: enabled but blank trackingId is still needs_setup", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", provider: "amazon", asin: "B08N5WRWNW" },
    settings({ trackingId: "   ", enabled: true }),
    repo,
  );
  assert.equal(link!.status, "needs_setup");
});

test("getOrCreate: Amazon product with no resolvable ASIN returns failed (not persisted)", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", provider: "amazon", productUrl: "https://www.amazon.com/some-store-page" },
    settings(),
    repo,
  );
  assert.equal(link!.status, "failed");
  assert.equal(repo.all().length, 0);
});

test("getOrCreate: creates a ready link and persists it", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", provider: "amazon", asin: "B08N5WRWNW", imageUrl: "img" },
    settings(),
    repo,
  );
  assert.equal(link!.status, "ready");
  assert.equal(link!.affiliateUrl, "https://www.amazon.com/dp/B08N5WRWNW?tag=harriet-20");
  assert.equal(link!.canonicalProductUrl, "https://www.amazon.com/dp/B08N5WRWNW");
  assert.equal(repo.all().length, 1);
});

test("getOrCreate: resolves ASIN from an Amazon product URL", () => {
  const repo = createInMemoryRepo();
  const link = getOrCreateCreatorProductLink(
    { id: "p1", productUrl: "https://www.amazon.com/dp/B08N5WRWNW/ref=abc" },
    settings(),
    repo,
  );
  assert.equal(link!.status, "ready");
  assert.equal(link!.asin, "B08N5WRWNW");
});

test("getOrCreate: reuses existing link, does NOT duplicate", () => {
  const repo = createInMemoryRepo();
  const first = getOrCreateCreatorProductLink({ id: "p1", provider: "amazon", asin: "B08N5WRWNW" }, settings(), repo);
  const second = getOrCreateCreatorProductLink({ id: "p1", provider: "amazon", asin: "B08N5WRWNW" }, settings(), repo);
  assert.equal(repo.all().length, 1);
  assert.equal(first!.id, second!.id);
});

test("getOrCreate: different trackingId creates a distinct link", () => {
  const repo = createInMemoryRepo();
  getOrCreateCreatorProductLink({ id: "p1", provider: "amazon", asin: "B08N5WRWNW" }, settings({ trackingId: "a-20" }), repo);
  getOrCreateCreatorProductLink({ id: "p1", provider: "amazon", asin: "B08N5WRWNW" }, settings({ trackingId: "b-20" }), repo);
  assert.equal(repo.all().length, 2);
});

// ── 5. applyCreatorProductLinkToPinDraft ───────────────────────────────────────
const readyLink: CreatorProductLink = {
  id: "cpl_abc",
  productId: "p1",
  provider: "amazon",
  marketplace: "US",
  asin: "B08N5WRWNW",
  trackingId: "harriet-20",
  canonicalProductUrl: "https://www.amazon.com/dp/B08N5WRWNW",
  affiliateUrl: "https://www.amazon.com/dp/B08N5WRWNW?tag=harriet-20",
  status: "ready",
  createdAt: "2026-06-30T00:00:00Z",
  updatedAt: "2026-06-30T00:00:00Z",
};

test("apply: empty destinationUrl is filled with affiliate URL", () => {
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { destinationUrl: "" },
    { id: "p1", imageUrl: "product.jpg" },
    readyLink,
  );
  assert.equal(out.destinationUrl, readyLink.affiliateUrl);
  assert.equal(out.destinationUrlSource, CREATOR_AFFILIATE_SOURCE);
  assert.equal(out.productId, "p1");
  assert.equal(out.creatorProductLinkId, "cpl_abc");
  assert.equal(out.sourceProductImageUrl, "product.jpg");
});

test("apply: manual destinationUrl is NOT overwritten", () => {
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { destinationUrl: "https://my-site.com/custom", destinationUrlSource: MANUAL_DESTINATION_SOURCE },
    { id: "p1", imageUrl: "product.jpg" },
    readyLink,
  );
  assert.equal(out.destinationUrl, "https://my-site.com/custom");
  assert.equal(out.destinationUrlSource, MANUAL_DESTINATION_SOURCE);
  // identity + image still attach
  assert.equal(out.productId, "p1");
  assert.equal(out.creatorProductLinkId, "cpl_abc");
});

test("apply: existing custom (non-creator) URL is NOT overwritten", () => {
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { destinationUrl: "https://landing.example/page" },
    { id: "p1" },
    readyLink,
  );
  assert.equal(out.destinationUrl, "https://landing.example/page");
});

test("apply: refreshes a previously creator-set URL", () => {
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { destinationUrl: "https://www.amazon.com/dp/OLD?tag=old", destinationUrlSource: CREATOR_AFFILIATE_SOURCE },
    { id: "p1" },
    readyLink,
  );
  assert.equal(out.destinationUrl, readyLink.affiliateUrl);
});

test("apply: preserves an already-attached product image", () => {
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { sourceProductImageUrl: "original.jpg", destinationUrl: "" },
    { id: "p1", imageUrl: "different.jpg" },
    readyLink,
  );
  assert.equal(out.sourceProductImageUrl, "original.jpg");
});

test("apply: non-ready link attaches identity but does NOT set destination", () => {
  const needsSetup: CreatorProductLink = { ...readyLink, status: "needs_setup", affiliateUrl: "" };
  const out = applyCreatorProductLinkToPinDraft<AffiliatePinFields>(
    { destinationUrl: "" },
    { id: "p1", imageUrl: "product.jpg" },
    needsSetup,
  );
  assert.equal(out.destinationUrl, "");
  assert.equal(out.destinationUrlSource, undefined);
  assert.equal(out.creatorProductLinkId, "cpl_abc");
});

test("apply: does not mutate the input draft", () => {
  const input: AffiliatePinFields = { destinationUrl: "" };
  applyCreatorProductLinkToPinDraft(input, { id: "p1" }, readyLink);
  assert.equal(input.destinationUrl, "");
  assert.equal(input.productId, undefined);
});

// ── 6. preserveAffiliateContextOnRegenerate ────────────────────────────────────
test("regenerate: preserves productId, creatorProductLinkId, destinationUrl, image", () => {
  const previous: AffiliatePinFields = {
    productId: "p1",
    creatorProductLinkId: "cpl_abc",
    sourceProductImageUrl: "product.jpg",
    destinationUrl: readyLink.affiliateUrl,
    destinationUrlSource: CREATOR_AFFILIATE_SOURCE,
  };
  const regenerated = { destinationUrl: "", title: "fresh title" } as AffiliatePinFields & { title: string };
  const out = preserveAffiliateContextOnRegenerate(previous, regenerated);
  assert.equal(out.productId, "p1");
  assert.equal(out.creatorProductLinkId, "cpl_abc");
  assert.equal(out.sourceProductImageUrl, "product.jpg");
  assert.equal(out.destinationUrl, readyLink.affiliateUrl);
  assert.equal(out.destinationUrlSource, CREATOR_AFFILIATE_SOURCE);
  assert.equal(out.title, "fresh title"); // regen MAY update content fields
});

test("regenerate: a manual destinationUrl survives regeneration", () => {
  const previous: AffiliatePinFields = {
    productId: "p1",
    destinationUrl: "https://my-site.com/custom",
    destinationUrlSource: MANUAL_DESTINATION_SOURCE,
  };
  const out = preserveAffiliateContextOnRegenerate(previous, { destinationUrl: "" } as AffiliatePinFields);
  assert.equal(out.destinationUrl, "https://my-site.com/custom");
  assert.equal(out.destinationUrlSource, MANUAL_DESTINATION_SOURCE);
});

test("regenerate: no previous context is a safe no-op", () => {
  const regenerated = { destinationUrl: "x" };
  assert.deepEqual(preserveAffiliateContextOnRegenerate(null, regenerated), regenerated);
});

console.log(`\nAmazon affiliate foundation: ${passed} passed, 0 failed`);
