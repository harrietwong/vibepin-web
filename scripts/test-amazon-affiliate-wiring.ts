/**
 * test-amazon-affiliate-wiring.ts — UI-wiring layer for the Amazon affiliate flow:
 * settings persistence, studio affiliate-context resolution, and Weekly Plan handoff.
 *
 * Run: npx tsx scripts/test-amazon-affiliate-wiring.ts
 */
import assert from "node:assert/strict";

// ── Minimal browser shims so the localStorage-backed stores work under tsx ──────
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
}
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = new MemoryStorage();
if (typeof g.Event === "undefined") g.Event = class { type: string; constructor(t: string) { this.type = t; } };
g.window = { localStorage: g.localStorage, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

async function main() {
// Imports MUST come after the shims so module-level `typeof window` checks pass.
const {
  getAmazonAffiliateSettings,
  saveAmazonAffiliateSettings,
  hasUsableAmazonSettings,
} = await import("../src/lib/affiliate/amazonAffiliateSettings");
const { resolveStudioAffiliateContext, isAmazonProductSnapshot } = await import("../src/lib/studio/affiliateContext");
const { createInMemoryRepo } = await import("../src/lib/affiliate/creatorProductLink");
const { buildWeeklyPlanItemFromGeneratedPin } = await import("../src/lib/weeklyPlanHandoff");
const pinDraftStore = await import("../src/lib/pinDraftStore");
const { looksLikeAmazon } = await import("../src/lib/affiliate/amazon");
const { filterMyProducts, isAmazonProductAsset } = await import("../src/lib/myProductsPicker");

// ── 1. Settings save / load ────────────────────────────────────────────────────
test("settings: default is US, empty tracking id (no separate enable step)", () => {
  const d = getAmazonAffiliateSettings();
  assert.equal(d.marketplace, "US");
  assert.equal(d.trackingId, "");
});

test("settings: save then load round-trips (persists)", () => {
  saveAmazonAffiliateSettings({ marketplace: "UK", trackingId: "harriet-21", enabled: true });
  const loaded = getAmazonAffiliateSettings();
  assert.equal(loaded.marketplace, "UK");
  assert.equal(loaded.trackingId, "harriet-21");
});

test("settings: readiness is tracking-id-only — no enabled flag required", () => {
  // MVP: a tracking ID is the only requirement; the legacy `enabled` flag is ignored.
  assert.equal(hasUsableAmazonSettings({ marketplace: "US", trackingId: "t-20", enabled: true }), true);
  assert.equal(hasUsableAmazonSettings({ marketplace: "US", trackingId: "t-20", enabled: false }), true);
  assert.equal(hasUsableAmazonSettings({ marketplace: "US", trackingId: "", enabled: true }), false);
  assert.equal(hasUsableAmazonSettings({ marketplace: "US", trackingId: "   ", enabled: true }), false);
});

test("settings: saving a tracking id flips the legacy enabled flag true", () => {
  saveAmazonAffiliateSettings({ marketplace: "US", trackingId: "harriet-22", enabled: false });
  assert.equal(getAmazonAffiliateSettings().enabled, true);
  saveAmazonAffiliateSettings({ marketplace: "US", trackingId: "", enabled: true });
  assert.equal(getAmazonAffiliateSettings().enabled, false);
});

// ── 2/3. Studio affiliate-context resolution ───────────────────────────────────
const READY_SETTINGS = { marketplace: "US" as const, trackingId: "harriet-20", enabled: true };

test("resolve: Amazon product + tracking id → ready context", () => {
  const repo = createInMemoryRepo();
  const ctx = resolveStudioAffiliateContext(
    [{ productId: "p1", title: "Cozy Lamp", imageUrl: "img.jpg", productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }],
    READY_SETTINGS, repo,
  );
  assert.ok(ctx);
  assert.equal(ctx!.link.status, "ready");
  assert.equal(ctx!.link.affiliateUrl, "https://www.amazon.com/dp/B08N5WRWNW?tag=harriet-20");
  assert.equal(ctx!.product.title, "Cozy Lamp");
  assert.equal(ctx!.product.imageUrl, "img.jpg");
});

test("resolve: Amazon product without tracking id → needs_setup, does not fail", () => {
  const repo = createInMemoryRepo();
  const ctx = resolveStudioAffiliateContext(
    [{ productId: "p1", productUrl: "https://www.amazon.com/dp/B08N5WRWNW", imageUrl: "img.jpg" }],
    { marketplace: "US", trackingId: "", enabled: false }, repo,
  );
  assert.ok(ctx);
  assert.equal(ctx!.link.status, "needs_setup");
});

test("resolve: non-Amazon product → null (no context, not an error)", () => {
  const repo = createInMemoryRepo();
  const ctx = resolveStudioAffiliateContext(
    [{ productId: "p1", productUrl: "https://etsy.com/listing/1", imageUrl: "img.jpg" }],
    READY_SETTINGS, repo,
  );
  assert.equal(ctx, null);
});

test("resolve: detects Amazon via source/domain hints", () => {
  assert.equal(isAmazonProductSnapshot({ sourceDomain: "amazon.com" }), true);
  assert.equal(isAmazonProductSnapshot({ source: "amazon" }), true);
  assert.equal(isAmazonProductSnapshot({ store: "Etsy" }), false);
});

test("resolve: picks the first Amazon product among a mixed selection", () => {
  const repo = createInMemoryRepo();
  const ctx = resolveStudioAffiliateContext(
    [
      { productId: "p0", productUrl: "https://etsy.com/listing/9", imageUrl: "a.jpg" },
      { productId: "p1", productUrl: "https://www.amazon.com/dp/B08N5WRWNW", imageUrl: "b.jpg" },
    ],
    READY_SETTINGS, repo,
  );
  assert.equal(ctx!.product.productId, "p1");
});

// ── 6. Weekly Plan handoff carries affiliate fields ────────────────────────────
const AFFILIATE_URL = "https://www.amazon.com/dp/B08N5WRWNW?tag=harriet-20";

function handoffPin(over: Record<string, unknown> = {}) {
  return {
    id: "pin_1", url: "https://cdn/img.jpg",
    title: "Title", description: "Description", altText: "Alt",
    destinationUrl: AFFILIATE_URL,
    destinationUrlSource: "creator_affiliate_product",
    productId: "p1", creatorProductLinkId: "cpl_abc", sourceProductImageUrl: "product.jpg",
    planningStatus: "not_added",
    ...over,
  };
}

test("handoff: payload carries productId, creatorProductLinkId, sourceProductImageUrl, destinationUrlSource", () => {
  const payload = buildWeeklyPlanItemFromGeneratedPin({
    pin: handoffPin(),
    session: { id: "s1", keyword: "lamp", category: "home-decor" },
    groupStatus: "done",
  });
  assert.ok(payload);
  assert.equal(payload!.destinationUrl, AFFILIATE_URL);
  assert.equal(payload!.productId, "p1");
  assert.equal(payload!.creatorProductLinkId, "cpl_abc");
  assert.equal(payload!.sourceProductImageUrl, "product.jpg");
  assert.equal(payload!.destinationUrlSource, "creator_affiliate_product");
});

test("handoff → createFromHandoff copies affiliate fields into the PinDraft", () => {
  const payload = buildWeeklyPlanItemFromGeneratedPin({
    pin: handoffPin({ id: "pin_2" }),
    session: { id: "s1", keyword: "lamp", category: "home-decor" },
    groupStatus: "done",
  })!;
  const draft = pinDraftStore.createFromHandoff(payload);
  assert.ok(draft);
  assert.equal(draft!.destinationUrl, AFFILIATE_URL);
  assert.equal(draft!.productId, "p1");
  assert.equal(draft!.creatorProductLinkId, "cpl_abc");
  assert.equal(draft!.sourceProductImageUrl, "product.jpg");
  assert.equal(draft!.destinationUrlSource, "creator_affiliate_product");

  // Survives a re-read from the store (persistence).
  const reread = pinDraftStore.getDraftByImageUrl("https://cdn/img.jpg");
  assert.equal(reread!.creatorProductLinkId, "cpl_abc");
  assert.equal(reread!.destinationUrl, AFFILIATE_URL);
});

test("handoff: a manual destination URL is carried through unchanged", () => {
  const payload = buildWeeklyPlanItemFromGeneratedPin({
    pin: handoffPin({ id: "pin_3", url: "https://cdn/img3.jpg", destinationUrl: "https://my-site.com/x", destinationUrlSource: "manual" }),
    session: { id: "s1", keyword: "lamp", category: "home-decor" },
    groupStatus: "done",
  })!;
  assert.equal(payload.destinationUrl, "https://my-site.com/x");
  assert.equal(payload.destinationUrlSource, "manual");
});

// ── 7. Amazon source filter (Products page + Create Pins picker) ───────────────
test("filter: looksLikeAmazon detects URL hosts and domain/store hints", () => {
  assert.equal(looksLikeAmazon({ productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }), true);
  assert.equal(looksLikeAmazon({ sourceUrl: "https://amzn.to/3abc" }), true);
  assert.equal(looksLikeAmazon({ sourceDomain: "amazon.co.uk" }), true);
  assert.equal(looksLikeAmazon({ store: "Amazon" }), true);
  assert.equal(looksLikeAmazon({ productUrl: "https://etsy.com/listing/1", store: "Etsy" }), false);
  assert.equal(looksLikeAmazon(null), false);
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: Math.random().toString(36).slice(2), role: "product" as const, source: "url" as const,
  imageUrl: "https://cdn/p.jpg", createdAt: "2026-06-01", lastUsedAt: "2026-06-01",
  ...over,
});

test("filter: Create Pins 'amazon' filter returns only Amazon product assets", () => {
  const items = [
    asset({ id: "a", productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }),
    asset({ id: "b", productUrl: "https://etsy.com/listing/9" }),
    asset({ id: "c", sourceDomain: "amazon.de" }),
    asset({ id: "d", source: "upload", imageUrl: "data:image/png;base64,xxx" }),
  ];
  const result = filterMyProducts(items, "amazon", "");
  const ids = result.map(i => i.id).sort();
  assert.deepEqual(ids, ["a", "c"]);
});

test("filter: isAmazonProductAsset is false for non-Amazon assets", () => {
  assert.equal(isAmazonProductAsset(asset({ productUrl: "https://etsy.com/x" })), false);
  assert.equal(isAmazonProductAsset(asset({ canonicalUrl: "https://www.amazon.com/dp/B08N5WRWNW" })), true);
});

test("filter: 'all' filter is unaffected by Amazon detection", () => {
  const items = [
    asset({ id: "a", productUrl: "https://www.amazon.com/dp/B08N5WRWNW" }),
    asset({ id: "b", productUrl: "https://etsy.com/listing/9" }),
  ];
  assert.equal(filterMyProducts(items, "all", "").length, 2);
});

console.log(`\nAmazon affiliate wiring: ${passed} passed, 0 failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
