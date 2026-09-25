/**
 * test-product-facts-copy-context.ts — PRD 0925 FR-03: URL-imported ProductFacts
 * reach the asset, the draft's linked product and the AI copy context.
 *
 * Run: npx tsx scripts/test-product-facts-copy-context.ts
 *
 * Covers:
 *  - assetFieldsFromImportResult: facts kept whole (description included), display
 *    price/currency follow the Shopify asset convention; "unknown" currency omitted.
 *  - saveAsset persists facts + price to localStorage (survives a cache reset).
 *  - selection chain: asset → CanonicalProductSelection → LinkedProduct → selection,
 *    and setup ProductSnapshot → LinkedProduct, all carry facts; no facts → no key.
 *  - buildImportedFactsCopyContext / resolveImportedProductFacts / inferProductContext:
 *    shopify_json/jsonld brand → vendor; og_meta/woocommerce brand never does;
 *    title → productContext.title only when empty (user title wins); title +
 *    description → pageContext.
 *  - price / availability never appear in inferProductContext or the v2 payload.
 *  - Amazon card keeps priority; Shopify-linked draft output is unchanged.
 *  - real analyze mapping (buildFacts): vendor → category "brand", claimPolicy
 *    copy_allowed; real validator accepts the brand in copy.
 *  - getPageContext(url, known) prefers known facts, source "product_facts".
 */
// Placeholder env only so modules that build a Supabase client at import time load;
// nothing here makes a network call.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";

import assert from "node:assert/strict";

// ── Minimal window/localStorage shim (assetStore/pinDraftStore are localStorage-backed) ──
const mem = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, cb: () => void) => {
    const callbacks = listeners.get(type) ?? new Set<() => void>();
    callbacks.add(cb);
    listeners.set(type, callbacks);
  },
  removeEventListener: (type: string, cb: () => void) => { listeners.get(type)?.delete(cb); },
  dispatchEvent: (event: Event) => { listeners.get(event.type)?.forEach(fn => fn()); return true; },
};

export {};

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

type ProductFacts = import("../src/lib/productUrlImport/types").ProductFacts;

const PRODUCT_URL = "https://quietspaces.example/products/linen-throw";
const FACTS_SHOPIFY: ProductFacts = {
  title: "Stonewashed Linen Throw",
  description: "A soft stonewashed linen throw woven in Portugal. Machine washable.",
  brand: "Quiet Spaces",
  price: { amount: "62.00", currency: "USD", compareAt: "79.00" },
  availability: "in_stock",
  images: ["https://cdn.example/throw-1.jpg"],
  sourceUrl: PRODUCT_URL,
  fetchedAt: "2026-09-25T00:00:00.000Z",
  source: "shopify_json",
  completeness: "full",
};
const FACTS_OG: ProductFacts = {
  title: "Linen Throw | Some Shop",
  description: "Soft linen throw.",
  brand: "Og Brand",
  price: { amount: "41.50", currency: "unknown" },
  sourceUrl: PRODUCT_URL,
  fetchedAt: "2026-09-25T00:00:00.000Z",
  source: "og_meta",
  completeness: "partial",
};

async function main() {
  const { assetFieldsFromImportResult, buildImportedFactsCopyContext } = await import("../src/lib/studio/importedProductFacts");
  const assetStore = await import("../src/lib/assetStore");
  const sel = await import("../src/lib/studio/productSelection");
  const pinMetadata = await import("../src/lib/pinMetadata");
  const gen = await import("../src/lib/ai-copy/generatePinCopy");
  const { buildAICopyV2AnalyzePayload } = await import("../src/lib/ai-copy/generatePinCopyV2");
  const { buildFacts } = await import("../src/app/api/ai-copy/v2/analyze/analyzeHandler");
  const { createFactCardV1 } = await import("../src/lib/ai-copy/v2/factCard");
  const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");
  const { getPageContext } = await import("../src/lib/ai-copy/getPageContext");
  type LinkedProduct = import("../src/lib/pinMetadata").LinkedProduct;
  type Draft = NonNullable<Parameters<typeof gen.inferProductContext>[1]>;
  type Input = Parameters<typeof gen.inferProductContext>[0];

  const baseInput: Input = { draftId: "d1", imageUrl: "https://cdn.example/throw-1.jpg", language: "en", destinationUrl: PRODUCT_URL };
  const importedLinked = (facts: ProductFacts, extra: Partial<LinkedProduct> = {}): LinkedProduct => ({
    productId: "asset-1", title: "Stonewashed Linen Throw", imageUrl: "https://cdn.example/throw-1.jpg",
    productUrl: PRODUCT_URL, store: "quietspaces.example", price: "62.00", currency: "USD",
    source: "url_imported", linkType: "manual", facts, ...extra,
  });
  const draftWith = (linked: LinkedProduct[], extra: Record<string, unknown> = {}): Draft =>
    ({ id: "d1", destinationUrl: PRODUCT_URL, linkedProducts: linked, primaryProductId: linked[0]?.productId, ...extra } as unknown as Draft);
  /** Mirrors generatePinterestPinCopy's v2 request assembly (non-Amazon card). */
  const payloadFor = (input: Input, draft: Draft | null) => buildAICopyV2AnalyzePayload({
    draftId: "d1", locale: "en", country: "US", idempotencyKey: "k1",
    product: gen.inferProductContext(input, draft),
    page: gen.resolveImportedProductFacts(input, draft)?.page,
  });

  console.log("\n[asset save]");
  await test("assetFieldsFromImportResult keeps facts whole and splits display price like Shopify assets", () => {
    const f = assetFieldsFromImportResult({ facts: FACTS_SHOPIFY });
    assert.equal(f.facts, FACTS_SHOPIFY);
    assert.equal(f.facts?.description, FACTS_SHOPIFY.description, "description rides on facts");
    assert.equal(f.price, "62.00");
    assert.equal(f.currency, "USD");
  });
  await test("unknown currency → amount only; no facts → no fields", () => {
    const f = assetFieldsFromImportResult({ facts: FACTS_OG });
    assert.equal(f.price, "41.50");
    assert.equal("currency" in f, false);
    assert.deepEqual(assetFieldsFromImportResult({}), {});
    assert.deepEqual(assetFieldsFromImportResult(undefined), {});
    const noPrice = assetFieldsFromImportResult({ facts: { ...FACTS_SHOPIFY, price: undefined } });
    assert.equal("price" in noPrice, false); assert.equal("currency" in noPrice, false);
  });
  await test("no facts but a page description → description alone (no facts key, no fake facts object)", () => {
    const f = assetFieldsFromImportResult({ description: "A generic page with no structured data." });
    assert.deepEqual(f, { description: "A generic page with no structured data." });
    assert.equal("facts" in f, false);
    assert.deepEqual(assetFieldsFromImportResult({ description: "  " }), {}, "blank description is not kept");
  });
  await test("facts present → description prefers facts.description over the raw page description", () => {
    const f = assetFieldsFromImportResult({ facts: FACTS_SHOPIFY, description: "stale page text" });
    assert.equal(f.description, FACTS_SHOPIFY.description);
  });
  await test("saveAsset persists facts + price to localStorage (survives cache reset)", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    const saved = assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg",
      title: "Stonewashed Linen Throw", productUrl: PRODUCT_URL, sourceDomain: "quietspaces.example",
      ...assetFieldsFromImportResult({ facts: FACTS_SHOPIFY }),
    });
    assert.deepEqual(saved.facts, FACTS_SHOPIFY);
    assetStore.__resetAssetStoreForTests(); // drop in-memory cache → re-read from storage
    const reread = assetStore.getAssets().find(a => a.id === saved.id);
    assert.ok(reread, "asset re-read from localStorage");
    assert.deepEqual(reread!.facts, FACTS_SHOPIFY);
    assert.equal(reread!.price, "62.00");
    assert.equal(reread!.currency, "USD");
  });
  await test("re-saving a pre-facts asset backfills facts (dedupe path)", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    const first = assetStore.saveAsset({ role: "product", source: "url", imageUrl: "https://cdn.example/old.jpg", title: "Old" });
    assert.equal(first.facts, undefined);
    const again = assetStore.saveAsset({ role: "product", source: "url", imageUrl: "https://cdn.example/old.jpg", title: "New title", ...assetFieldsFromImportResult({ facts: FACTS_SHOPIFY }) });
    assert.equal(again.id, first.id);
    assert.deepEqual(again.facts, FACTS_SHOPIFY);
    assert.equal(again.title, "Old", "existing user-visible title is not overwritten");
  });
  await test("re-importing the same URL REFRESHES facts/price/currency/description (D3: stale price)", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    const first = assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "Old title",
      ...assetFieldsFromImportResult({ facts: FACTS_SHOPIFY }),
    });
    assert.equal(first.price, "62.00");
    const RESTOCKED: ProductFacts = {
      ...FACTS_SHOPIFY,
      description: "Restocked in a new colourway.",
      brand: "Quiet Spaces Home",
      price: { amount: "58.00", currency: "USD" },
      fetchedAt: "2026-09-26T00:00:00.000Z",
    };
    const again = assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "New title (ignored)",
      ...assetFieldsFromImportResult({ facts: RESTOCKED }),
    });
    assert.equal(again.id, first.id);
    assert.equal(again.price, "58.00", "price refreshed, not stuck at the old $62.00");
    assert.equal(again.currency, "USD");
    assert.equal(again.description, "Restocked in a new colourway.");
    assert.equal(again.facts?.brand, "Quiet Spaces Home", "brand lives inside facts and is refreshed with it");
    assert.deepEqual(again.facts, RESTOCKED);
    assert.equal(again.title, "Old title", "title is user-editable — still only backfilled, never overwritten");
  });
  await test("re-import whose new facts DROP the price clears the stale one (no silently-kept old price)", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "Throw",
      ...assetFieldsFromImportResult({ facts: FACTS_SHOPIFY }),
    });
    const NO_PRICE: ProductFacts = { ...FACTS_SHOPIFY, price: undefined, completeness: "partial" };
    const again = assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "Throw",
      ...assetFieldsFromImportResult({ facts: NO_PRICE }),
    });
    assert.equal(again.price, undefined, "no price in the fresh facts → old price is not kept");
    assert.equal(again.currency, undefined);
  });
  await test("re-saving WITHOUT facts (e.g. a plain re-select) never touches the existing price (gate on item.facts)", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    assetStore.saveAsset({
      role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "Throw",
      ...assetFieldsFromImportResult({ facts: FACTS_SHOPIFY }),
    });
    const again = assetStore.saveAsset({ role: "product", source: "url", imageUrl: "https://cdn.example/throw-1.jpg", title: "Throw", price: "1.00" });
    assert.equal(again.price, "62.00", "no facts on this save → existing price is left alone, not backfilled from a bare price");
    assert.deepEqual(again.facts, FACTS_SHOPIFY);
  });
  await test("Shopify asset save (no facts) is unaffected by the refresh path — still plain backfill", () => {
    assetStore.__resetAssetStoreForTests();
    mem.clear();
    assetStore.saveAsset({ role: "product", source: "shopify", imageUrl: "https://cdn.example/shopify-1.jpg", title: "Walnut Board", price: "19.99", currency: "USD" });
    const again = assetStore.saveAsset({ role: "product", source: "shopify", imageUrl: "https://cdn.example/shopify-1.jpg", title: "Walnut Board", price: "24.99", currency: "USD" });
    assert.equal(again.price, "19.99", "Shopify re-sync still only backfills — a present price is not overwritten");
  });

  console.log("\n[draft carry: selection chain]");
  await test("asset → selection → LinkedProduct → selection keeps facts", () => {
    const s = sel.selectionFromAsset({ id: "a1", title: "Throw", imageUrl: "https://cdn.example/t.jpg", productUrl: PRODUCT_URL, source: "url", price: "62.00", currency: "USD", facts: FACTS_SHOPIFY });
    assert.deepEqual(s.facts, FACTS_SHOPIFY);
    const lp = sel.toLinkedProduct(s);
    assert.deepEqual(lp.facts, FACTS_SHOPIFY);
    assert.equal(lp.price, "62.00"); assert.equal(lp.currency, "USD");
    assert.deepEqual(sel.selectionFromLinkedProduct(lp).facts, FACTS_SHOPIFY);
    // JSON round-trip = what pin_drafts.payload (jsonb) stores.
    assert.deepEqual((JSON.parse(JSON.stringify(lp)) as LinkedProduct).facts, FACTS_SHOPIFY);
  });
  await test("setup ProductSnapshot → LinkedProduct keeps facts", () => {
    const lp = pinMetadata.toLinkedProduct({ productId: "a1", imageUrl: "https://cdn.example/t.jpg", title: "Throw", source: "url", facts: FACTS_SHOPIFY });
    assert.deepEqual(lp.facts, FACTS_SHOPIFY);
  });
  await test("no facts → no `facts` key anywhere in the chain (existing shapes unchanged)", () => {
    const s = sel.selectionFromAsset({ id: "a1", title: "Throw", imageUrl: "https://cdn.example/t.jpg", source: "shopify" });
    assert.equal("facts" in s, false);
    assert.equal("facts" in sel.toLinkedProduct(s), false);
    assert.equal("facts" in pinMetadata.toLinkedProduct({ title: "x", source: "upload" }), false);
  });

  console.log("\n[copy context mapping]");
  await test("shopify_json facts → vendor + title; page gets title + description", () => {
    const ctx = buildImportedFactsCopyContext(FACTS_SHOPIFY);
    assert.deepEqual(ctx.product, { title: "Stonewashed Linen Throw", vendor: "Quiet Spaces" });
    assert.deepEqual(ctx.page, { title: "Stonewashed Linen Throw", description: FACTS_SHOPIFY.description });
  });
  await test("jsonld brand → vendor; og_meta and woocommerce brand never do", () => {
    assert.equal(buildImportedFactsCopyContext({ ...FACTS_SHOPIFY, source: "jsonld" }).product.vendor, "Quiet Spaces");
    assert.equal(buildImportedFactsCopyContext(FACTS_OG).product.vendor, undefined);
    assert.equal(buildImportedFactsCopyContext({ ...FACTS_SHOPIFY, source: "woocommerce" }).product.vendor, undefined);
    const draft = draftWith([importedLinked(FACTS_OG)]);
    assert.equal(gen.inferProductContext(baseInput, draft).vendor, undefined);
  });
  await test("page description capped at 2000 chars (analyze drops longer strings)", () => {
    const long = "a".repeat(2500);
    assert.equal(buildImportedFactsCopyContext({ ...FACTS_SHOPIFY, description: long }).page?.description?.length, 2000);
  });
  await test("inferProductContext: linked imported product → vendor/title/source, no price/availability", () => {
    const ctx = gen.inferProductContext(baseInput, draftWith([importedLinked(FACTS_SHOPIFY)]));
    assert.equal(ctx.vendor, "Quiet Spaces");
    assert.equal(ctx.title, "Stonewashed Linen Throw");
    assert.equal(ctx.source, "url_imported");
    assert.equal(ctx.productUrl, PRODUCT_URL);
    assert.equal("price" in ctx, false, "price key absent");
    assert.equal("availability" in ctx, false, "availability key absent");
    assert.equal("tags" in ctx, false);
  });
  await test("user's product title wins over facts.title (facts fill only when empty)", () => {
    const input: Input = { ...baseInput, setupSnapshot: { selectedProducts: [{ imageUrl: null, title: "My cozy throw", productUrl: PRODUCT_URL }] } as never };
    assert.equal(gen.inferProductContext(input, draftWith([importedLinked(FACTS_SHOPIFY)])).title, "My cozy throw");
    const emptyTitle = importedLinked(FACTS_SHOPIFY, { title: "" });
    assert.equal(gen.inferProductContext(baseInput, draftWith([emptyTitle])).title, "Stonewashed Linen Throw");
  });
  await test("no linked products → falls back to setup snapshot product facts", () => {
    const input: Input = { ...baseInput, setupSnapshot: { selectedProducts: [{ imageUrl: null, title: "Throw", productUrl: PRODUCT_URL, facts: FACTS_SHOPIFY }] } as never };
    const r = gen.resolveImportedProductFacts(input, null);
    assert.equal(r?.product.vendor, "Quiet Spaces");
    assert.equal(gen.inferProductContext(input, null).vendor, "Quiet Spaces");
  });
  await test("primary linked product decides: a tagged imported product does not hijack a factless primary", () => {
    const primary = importedLinked(FACTS_SHOPIFY, { productId: "p", facts: undefined });
    const tagged = importedLinked(FACTS_SHOPIFY, { productId: "t" });
    const draft = draftWith([tagged, primary], { primaryProductId: "p" });
    assert.equal(gen.resolveImportedProductFacts(baseInput, draft), null);
  });

  console.log("\n[price / availability never reach the request]");
  await test("v2 payload carries vendor + page text, never the price or availability", () => {
    const payload = payloadFor(baseInput, draftWith([importedLinked(FACTS_SHOPIFY)]));
    const pc = payload.productContext as Record<string, unknown>;
    assert.equal(pc.vendor, "Quiet Spaces");
    assert.equal(pc.price, undefined); assert.equal(pc.availability, undefined);
    assert.deepEqual(payload.pageContext, { title: "Stonewashed Linen Throw", description: FACTS_SHOPIFY.description });
    const json = JSON.stringify(payload);
    for (const banned of ["62.00", "62", "79.00", "in_stock", "USD"]) {
      assert.equal(json.includes(banned), false, `payload must not contain ${banned}: ${json}`);
    }
  });
  await test("og_meta (unknown currency) payload also has no price", () => {
    const json = JSON.stringify(payloadFor(baseInput, draftWith([importedLinked(FACTS_OG, { price: "41.50", currency: undefined })])));
    assert.equal(json.includes("41.50"), false);
    assert.equal(json.includes("Og Brand"), false, "og_meta brand not sent as vendor");
  });

  console.log("\n[priority: Amazon first, Shopify unchanged]");
  await test("Amazon card keeps priority over imported facts", () => {
    const amazonUrl = "https://www.amazon.com/dp/B0BSHF7WHW?tag=harriet-20";
    const draft = draftWith([importedLinked(FACTS_SHOPIFY)], {
      destinationUrl: amazonUrl,
      amazonSource: { pastedUrl: amazonUrl, linkStatus: "ok", host: "amazon.com", marketplace: "US", asin: "B0BSHF7WHW", fetch: { status: "not_attempted" }, manual: { productName: "Stanley tumbler", brand: "Stanley" } },
    });
    const ctx = gen.inferProductContext({ ...baseInput, destinationUrl: amazonUrl }, draft);
    assert.equal(ctx.source, "amazon");
    assert.equal(ctx.vendor, "Stanley");
    assert.equal(ctx.title, "Stanley tumbler");
  });
  await test("Shopify-linked draft (no facts) output is byte-identical to the Shopify branch", () => {
    const shopify = {
      productId: "gid://shopify/Product/1", title: "Walnut Board", productUrl: "https://shop.example/products/walnut",
      price: "19.99", currency: "USD", source: "shopify", linkType: "manual",
      vendor: "Oak & Co", tags: ["kitchen"], availability: "in_stock", productType: "Cutting board",
    } as unknown as LinkedProduct;
    const draft = draftWith([shopify]);
    assert.equal(gen.resolveImportedProductFacts(baseInput, draft), null);
    assert.deepEqual(gen.inferProductContext({ ...baseInput, destinationUrl: undefined }, draft), {
      title: "Walnut Board",
      category: "Cutting board",
      productUrl: "https://shop.example/products/walnut",
      attributes: undefined,
      source: "shopify",
      vendor: "Oak & Co",
      tags: ["kitchen"],
      price: "USD 19.99",
      availability: "in_stock",
    });
  });
  await test("draft with no linked products and no facts → base context unchanged", () => {
    assert.equal(gen.resolveImportedProductFacts(baseInput, draftWith([])), null);
    assert.deepEqual(gen.inferProductContext(baseInput, draftWith([])), {
      title: undefined, category: undefined, productUrl: PRODUCT_URL, attributes: undefined, source: undefined,
    });
  });

  console.log("\n[real analyze mapping + validator]");
  const factCardFor = () => {
    const p = payloadFor(baseInput, draftWith([importedLinked(FACTS_SHOPIFY)]));
    return createFactCardV1({ sessionId: "s", draftId: "d1", locale: "en", facts: buildFacts({ draftId: "d1", idempotencyKey: "k1", productContext: p.productContext, pageContext: p.pageContext }) });
  };
  await test("vendor → category brand, product_catalog, claimPolicy copy_allowed; page → page_metadata; no price fact", () => {
    const facts = buildFacts({ draftId: "d1", idempotencyKey: "k1", ...(() => { const p = payloadFor(baseInput, draftWith([importedLinked(FACTS_SHOPIFY)])); return { productContext: p.productContext, pageContext: p.pageContext }; })() });
    const vendor = facts.find(f => f.key === "product_vendor");
    assert.ok(vendor, "vendor fact present");
    assert.equal(vendor!.value, "Quiet Spaces");
    assert.equal(vendor!.category, "brand");
    assert.equal(vendor!.source, "product_catalog");
    assert.equal(vendor!.claimPolicy, "copy_allowed");
    assert.equal(facts.find(f => f.key === "page_title")?.source, "page_metadata");
    assert.equal(facts.find(f => f.key === "page_description")?.source, "page_metadata");
    assert.equal(facts.some(f => f.key === "product_price" || f.key === "product_availability"), false);
  });
  await test("validator accepts copy naming the store's brand (no UNSUPPORTED_BRAND_CLAIM)", () => {
    const r = validateCopy({
      title: "Quiet Spaces Linen Throw for Slow Evenings",
      description: "Wrap up in the Quiet Spaces stonewashed linen throw on cool nights.",
      altText: "A folded linen throw on a sofa arm",
      factCard: factCardFor(),
      descriptionMax: 500,
      claimDetection: { status: "completed", claims: [{ type: "brand", value: "Quiet Spaces", field: "title" }] },
    });
    assert.equal(r.issues.some(i => i.code === "UNSUPPORTED_BRAND_CLAIM"), false, JSON.stringify(r.issues));
    assert.equal(r.valid, true, JSON.stringify(r.issues));
  });

  console.log("\n[getPageContext]");
  await test("known facts title/description win, source product_facts", async () => {
    const ctx = await getPageContext(PRODUCT_URL, { title: "Stonewashed Linen Throw", description: "Soft." });
    assert.deepEqual(ctx, { pageTitle: "Stonewashed Linen Throw", pageDescription: "Soft.", domain: "quietspaces.example", source: "product_facts" });
  });
  await test("without known facts the slug fallback is unchanged", async () => {
    const ctx = await getPageContext("https://shop.example/products/walnut-board");
    assert.equal(ctx.pageTitle, "walnut board");
    assert.notEqual(ctx.source, "product_facts");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
