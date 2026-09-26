/**
 * FR-04 / FR-05: manual-entry fallback for Temu / Shein / AliExpress / TikTok Shop,
 * and the Etsy `connect_etsy_api` dead-button removal.
 *
 *  - classifyManualMarketplace / validateImportUrl: hostname classification only,
 *    including country subdomains, with zero network involved
 *  - importUrl(): the marketplace branch never calls the injected page fetcher (an
 *    injected fetcher that throws proves this — if it were ever called, the test
 *    would fail on the throw instead of asserting the result), returns
 *    `status: "unsupported"` / `provider: "marketplace_manual"` with no `title` /
 *    `description` keys at all (not empty strings — same contract as the Amazon
 *    failure shape)
 *  - Instagram stays a generic `failed` result (not a marketplace, not FR-04)
 *  - Etsy's blocked result no longer offers `connect_etsy_api`
 *  - amazonCardSource.ts: classifyCardMarketplace, cardSourceForUrl (marketplace
 *    branch — no fetch attempted, manual fields carried across product changes),
 *    buildMarketplaceCopyContext (same field mapping as Amazon, minus page/price)
 *  - generatePinCopy.resolveAmazonCopyContext: marketplace card → context with no
 *    `affiliateDisclosure` and no `price`/`availability`; a REAL Amazon link through
 *    the SAME function, pinned against a baseline fixture captured from the
 *    Amazon-only code path (c64b97b9, before this branch touched anything), must
 *    still produce byte-identical output — proving the Amazon branch was not
 *    disturbed by generalizing this function
 *
 * Run: npx tsx scripts/test-marketplace-manual.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";

import assert from "node:assert/strict";

// Minimal window + localStorage shim so the localStorage-backed draft store runs in node.
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
};

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n    ${(error as Error).stack}`); }
}

// Baseline fixture: resolveAmazonCopyContext(...) for a real Amazon retail link with
// manual fields set, captured against the Amazon-only code (branch base c64b97b9,
// before amazonCardSource.ts / generatePinCopy.ts were touched by this task) via
// test-amazon-entry-points.ts's "stored manual facts are carried" case and
// test-amazon-copy-mapping.ts's mapping test. Re-derived here with the same inputs so
// a regression in the generalized resolveAmazonCopyContext trips this test.
const AMAZON_URL = "https://www.amazon.com/Stanley-Tumbler/dp/B0BSHF7WHW?tag=harriet-20";
const AMAZON_BASELINE = {
  product: {
    title: "Tumbler",
    attributes: undefined,
    vendor: "Stanley",
    material: undefined,
    quantity: undefined,
    price: undefined,
    availability: undefined,
    source: "amazon",
  },
  affiliateDisclosure: "ad_hashtag",
  canGenerate: true,
};

const NOW = "2026-09-25T00:00:00.000Z";

async function main() {
  const { classifyManualMarketplace, validateImportUrl } = await import("../src/lib/productUrlImport/urlSecurity");
  const { importUrl } = await import("../src/lib/productUrlImport/urlImportService");
  const { ETSY_BLOCKED_RESULT } = await import("../src/lib/productUrlImport/adapters/etsy");
  const cardSrc = await import("../src/lib/studio/amazonCardSource");
  const gen = await import("../src/lib/ai-copy/generatePinCopy");
  const store = await import("../src/lib/pinDraftStore");

  console.log("\n[classifyManualMarketplace / validateImportUrl — hostname only, zero network]");

  await test("the four marketplaces classify, including country/www/short-host subdomains", () => {
    assert.equal(classifyManualMarketplace("www.temu.com"), "temu");
    assert.equal(classifyManualMarketplace("temu.com"), "temu");
    assert.equal(classifyManualMarketplace("m.shein.com"), "shein");
    assert.equal(classifyManualMarketplace("us.shein.com"), "shein");
    assert.equal(classifyManualMarketplace("www.aliexpress.com"), "aliexpress");
    assert.equal(classifyManualMarketplace("www.aliexpress.us"), "aliexpress");
    assert.equal(classifyManualMarketplace("shop.tiktok.com"), "tiktok_shop");
    assert.equal(classifyManualMarketplace("www.tiktokshop.com"), "tiktok_shop");
  });

  await test("Instagram and Amazon are NOT marketplace-manual (different carve-outs)", () => {
    assert.equal(classifyManualMarketplace("www.instagram.com"), null);
    assert.equal(classifyManualMarketplace("www.amazon.com"), null);
  });

  await test("a normal importable host classifies to null", () => {
    assert.equal(classifyManualMarketplace("example.com"), null);
  });

  await test("validateImportUrl carries `marketplace` only for the four hosts, not for Instagram", () => {
    const temu = validateImportUrl("https://www.temu.com/product-123.html");
    assert.equal(temu.ok, false);
    assert.equal((temu as { marketplace?: string }).marketplace, "temu");

    const ig = validateImportUrl("https://www.instagram.com/p/abc123/");
    assert.equal(ig.ok, false);
    assert.equal((ig as { marketplace?: string }).marketplace, undefined);
  });

  console.log("\n[importUrl — zero fetch, unsupported shape, no title/description keys]");

  const throwingFetcher = async (): Promise<{ html: string; finalUrl: string }> => {
    throw new Error("fetchPage must never be called for a marketplace-manual URL");
  };

  await test("Temu link: no title/description keys, candidates empty, fallback actions, marketplace id", async () => {
    const result = await importUrl("https://www.temu.com/product-123.html", throwingFetcher);
    assert.equal(result.status, "unsupported");
    assert.equal(result.provider, "marketplace_manual");
    assert.equal(result.marketplace, "temu");
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.fallbackActions, ["manual_entry", "upload_image"]);
    assert.equal("title" in result, false, "no title key at all — not even an empty string");
    assert.equal("description" in result, false, "no description key at all");
    assert.equal(result.sourceUrl, "https://www.temu.com/product-123.html");
    assert.ok(result.debugCode?.startsWith("marketplace_manual_"));
    assert.ok(result.message && result.message.length > 0);
  });

  await test("Shein / AliExpress / TikTok Shop: same zero-fetch contract", async () => {
    for (const [url, marketplace] of [
      ["https://www.shein.com/some-dress.html", "shein"],
      ["https://www.aliexpress.com/item/123.html", "aliexpress"],
      ["https://shop.tiktok.com/view/product/123", "tiktok_shop"],
    ] as const) {
      const result = await importUrl(url, throwingFetcher);
      assert.equal(result.status, "unsupported", url);
      assert.equal(result.marketplace, marketplace, url);
      assert.equal(result.provider, "marketplace_manual", url);
    }
  });

  await test("Instagram link: unaffected — still a generic `failed` result, not unsupported/marketplace", async () => {
    const result = await importUrl("https://www.instagram.com/p/abc123/", throwingFetcher);
    assert.equal(result.status, "failed");
    assert.equal((result as { marketplace?: string }).marketplace, undefined);
    assert.equal((result as { provider?: string }).provider, undefined);
  });

  await test("the pasted URL survives unchanged (destination link is never rewritten)", async () => {
    const withParams = "https://www.temu.com/product-123.html?ref=creator_abc&_x=1";
    const result = await importUrl(withParams, throwingFetcher);
    assert.equal(result.sourceUrl, withParams);
  });

  console.log("\n[0925 follow-up: hintsFromMarketplaceUrl — suggestedTitle + Temu kwcdn image, still zero fetch]");

  const TEMU_URL =
    "https://www.temu.com/6pcs-retro-halloween-wooden-ornaments-ghost-pumpkin-black-cat-skull--owl-shapes-vintage-home-decor-for-family-parties-farmhouse--gift-for--g-606944559527650.html" +
    "?_oak_mp_inf=abc&top_gallery_url=https%3A%2F%2Fimg.kwcdn.com%2Fproduct%2Ffancy%2Fdb7df003-ae2a-466f-95a2-8282807a8d76.jpg&spec_gallery_id=231683425157&refer_page_sn=30479";
  const SHEIN_URL =
    "https://us.shein.com/20pcs-Mini-Chalkboard-Home-Decor-Signs-Mini-Wooden-Message-Board-Display-Stands-Suitable-For-Wedding-Baking-Display-Hotel-Party-Dessert-Table-Cards-Mother-s-Day-Graduation-p-86913712.html" +
    "?src_module=all";

  await test("Temu real user link: suggestedTitle starts with the readable slug, one kwcdn image candidate", async () => {
    const result = await importUrl(TEMU_URL, throwingFetcher);
    assert.equal(result.status, "unsupported");
    assert.equal(result.provider, "marketplace_manual");
    assert.ok(result.suggestedTitle?.startsWith("6pcs retro halloween wooden ornaments"), result.suggestedTitle);
    assert.equal(result.candidates?.length, 1, JSON.stringify(result.candidates));
    assert.equal(result.candidates?.[0]?.imageUrl, "https://img.kwcdn.com/product/fancy/db7df003-ae2a-466f-95a2-8282807a8d76.jpg");
    assert.equal(result.candidates?.[0]?.reason, "direct_image_url");
    assert.equal("title" in result, false, "still no title key — suggestedTitle is a separate field");
    assert.equal("description" in result, false);
  });

  await test("Shein real user link: suggestedTitle starts with the readable slug, no image candidates", async () => {
    const result = await importUrl(SHEIN_URL, throwingFetcher);
    assert.equal(result.status, "unsupported");
    assert.ok(result.suggestedTitle?.startsWith("20pcs Mini Chalkboard Home Decor Signs"), result.suggestedTitle);
    assert.deepEqual(result.candidates, []);
    assert.equal("title" in result, false);
    assert.equal("description" in result, false);
  });

  await test("forged top_gallery_url pointing off kwcdn.com is dropped, no candidate", async () => {
    const forged = "https://www.temu.com/some-product-g-123.html?top_gallery_url=" + encodeURIComponent("https://evil.example/x.jpg");
    const result = await importUrl(forged, throwingFetcher);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.suggestedTitle?.startsWith("Some product"), result.suggestedTitle);
  });

  await test("AliExpress item link (no slug) and TikTok Shop pdp link: title only when a slug exists", async () => {
    const aliexpress = await importUrl("https://www.aliexpress.com/item/1005001234567890.html", throwingFetcher);
    assert.equal(aliexpress.suggestedTitle, undefined, "no slug to derive a title from");
    assert.deepEqual(aliexpress.candidates, []);

    const tiktokPdp = await importUrl("https://shop.tiktok.com/pdp/cozy-throw-blanket/1234567890", throwingFetcher);
    assert.equal(tiktokPdp.suggestedTitle, "Cozy throw blanket");

    const tiktokProduct = await importUrl("https://shop.tiktok.com/product/ceramic-mug-set", throwingFetcher);
    assert.equal(tiktokProduct.suggestedTitle, "Ceramic mug set");
  });

  await test("marketplace-manual results never trigger a fetch even when hints are derived (throwingFetcher proves it)", async () => {
    // Already proven by every await above (throwingFetcher would have rejected the
    // test on the throw) — this test documents the invariant explicitly.
    await assert.doesNotReject(() => importUrl(TEMU_URL, throwingFetcher));
  });

  console.log("\n[Etsy — FR-05 dead-button removal]");

  await test("ETSY_BLOCKED_RESULT no longer offers connect_etsy_api", () => {
    assert.ok(!ETSY_BLOCKED_RESULT.fallbackActions?.includes("connect_etsy_api"));
    assert.deepEqual(ETSY_BLOCKED_RESULT.fallbackActions, ["upload_image", "paste_direct_image_url"]);
    assert.ok(!/connect etsy api/i.test(ETSY_BLOCKED_RESULT.message ?? ""));
  });

  console.log("\n[amazonCardSource — classifyCardMarketplace / cardSourceForUrl / buildMarketplaceCopyContext]");

  await test("classifyCardMarketplace recognises the four marketplaces, null for Amazon/other", () => {
    assert.equal(cardSrc.classifyCardMarketplace("https://www.temu.com/p/1"), "temu");
    assert.equal(cardSrc.classifyCardMarketplace("https://www.shein.com/p/1"), "shein");
    assert.equal(cardSrc.classifyCardMarketplace(AMAZON_URL), null, "Amazon is not a manual marketplace");
    assert.equal(cardSrc.classifyCardMarketplace("https://example.com/p"), null);
    assert.equal(cardSrc.classifyCardMarketplace(""), null);
  });

  await test("isCardMarketplaceLink: true for Amazon OR the four marketplaces, false otherwise", () => {
    assert.equal(cardSrc.isCardMarketplaceLink(AMAZON_URL), true);
    assert.equal(cardSrc.isCardMarketplaceLink("https://www.temu.com/p/1"), true);
    assert.equal(cardSrc.isCardMarketplaceLink("https://example.com/p"), false);
  });

  await test("cardSourceForUrl: marketplace branch never attempts a fetch (manual_only from the start)", () => {
    const src = cardSrc.cardSourceForUrl("https://www.temu.com/product-123.html", undefined, NOW)!;
    assert.ok(src, "should produce a source");
    assert.equal(src.linkStatus, "marketplace");
    assert.equal(src.manualMarketplace, "temu");
    assert.equal(src.fetch.status, "manual_only");
    assert.equal(src.pastedUrl, "https://www.temu.com/product-123.html");
  });

  await test("cardSourceForUrl: Amazon URLs are unaffected — routes through amazonSourceForUrl untouched", () => {
    const viaGeneralized = cardSrc.cardSourceForUrl(AMAZON_URL, undefined, NOW);
    const viaOriginal = cardSrc.amazonSourceForUrl(AMAZON_URL, undefined, NOW);
    assert.deepEqual(viaGeneralized, viaOriginal);
  });

  await test("cardSourceForUrl: manual fields carried when the marketplace product URL changes", () => {
    const first = cardSrc.cardSourceForUrl("https://www.temu.com/product-123.html", undefined, NOW)!;
    const withManual = { ...first, manual: { productName: "Wireless earbuds", brand: "Acme" } };
    const second = cardSrc.cardSourceForUrl("https://www.temu.com/product-456.html", withManual, NOW)!;
    assert.equal(second.manual.productName, "Wireless earbuds", "manual fields carried across product change");
    assert.equal(second.manual.brand, "Acme");
    assert.equal(second.pastedUrl, "https://www.temu.com/product-456.html");
    assert.equal(second.fetch.status, "manual_only");
  });

  await test("cardSourceForUrl: non-Amazon, non-marketplace URL → null", () => {
    assert.equal(cardSrc.cardSourceForUrl("https://example.com/p", undefined, NOW), null);
  });

  await test("buildMarketplaceCopyContext: same field mapping as Amazon, minus page, price, availability", () => {
    const src = { ...cardSrc.cardSourceForUrl("https://www.shein.com/dress-1.html", undefined, NOW)!, manual: {
      productName: "Floral maxi dress", sellingPoints: "Breathable\nMachine washable", brand: "Shein", material: "Cotton blend", size: "M",
    } };
    const ctx = cardSrc.buildMarketplaceCopyContext(src);
    assert.equal(ctx.product.title, "Floral maxi dress");
    assert.deepEqual(ctx.product.attributes, ["Breathable", "Machine washable"]);
    assert.equal(ctx.product.vendor, "Shein");
    assert.equal(ctx.product.material, "Cotton blend");
    assert.equal(ctx.product.quantity, "M");
    assert.equal(ctx.product.source, "shein");
    assert.equal(ctx.product.price, undefined);
    assert.equal(ctx.product.availability, undefined);
    assert.equal("price" in ctx.product, true, "key present but undefined — never a fabricated value");
    assert.equal(ctx.page, undefined, "marketplace cards never have page context (no fetch ever happens)");
  });

  console.log("\n[generatePinCopy.resolveAmazonCopyContext — marketplace branch + Amazon baseline pinned]");

  const draftWith = (patch: Record<string, unknown>) => {
    const d = store.createBoardDraft({ imageUrl: "https://x/a.png", source: "uploaded_image" });
    store.updateDraft(d.id, patch);
    return store.getDraft(d.id)!;
  };

  await test("Amazon link through resolveAmazonCopyContext matches the pinned baseline exactly", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const source = { ...cardSrc.amazonSourceForUrl(AMAZON_URL, undefined, NOW)!, manual: { productName: "Tumbler", brand: "Stanley" } };
    const d = draftWith({ destinationUrl: AMAZON_URL, amazonSource: source });
    const ctx = gen.resolveAmazonCopyContext({ destinationUrl: AMAZON_URL, destinationUrlIsCurrent: true }, d)!;
    assert.ok(ctx, "is a card context");
    assert.deepEqual(ctx.product, AMAZON_BASELINE.product);
    assert.equal(ctx.affiliateDisclosure, AMAZON_BASELINE.affiliateDisclosure);
    assert.equal(ctx.canGenerate, AMAZON_BASELINE.canGenerate);
    assert.equal(ctx.page, undefined, "no fetched page text for this fixture (fetch never attempted)");
  });

  await test("Temu link through resolveAmazonCopyContext: marketplace mapping, no affiliateDisclosure, no price", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const temuUrl = "https://www.temu.com/product-999.html";
    const source = { ...cardSrc.cardSourceForUrl(temuUrl, undefined, NOW)!, manual: { productName: "Phone stand", brand: "Temu Basics" } };
    const d = draftWith({ destinationUrl: temuUrl, amazonSource: source });
    const ctx = gen.resolveAmazonCopyContext({ destinationUrl: temuUrl, destinationUrlIsCurrent: true }, d)!;
    assert.ok(ctx, "is a card context");
    assert.equal(ctx.product.title, "Phone stand");
    assert.equal(ctx.product.vendor, "Temu Basics");
    assert.equal(ctx.product.source, "temu");
    assert.equal(ctx.product.price, undefined);
    assert.equal(ctx.product.availability, undefined);
    assert.equal("affiliateDisclosure" in ctx, false, "no #ad key at all for a non-Amazon marketplace card");
    assert.equal(ctx.canGenerate, true);
    assert.equal(ctx.page, undefined);
  });

  await test("Temu link without a manual product name: canGenerate is false (same §2.3-style gate as Amazon)", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const temuUrl = "https://www.temu.com/product-777.html";
    const d = draftWith({ destinationUrl: temuUrl });
    const ctx = gen.resolveAmazonCopyContext({ destinationUrl: temuUrl, destinationUrlIsCurrent: true }, d)!;
    assert.ok(ctx);
    assert.equal(ctx.canGenerate, false);
  });

  await test("non-Amazon, non-marketplace URL: resolveAmazonCopyContext is still null", () => {
    mem.clear(); store.__resetMemoryCacheForTests();
    const d = draftWith({ destinationUrl: "https://myshop.example/lamp" });
    assert.equal(gen.resolveAmazonCopyContext({ destinationUrl: "https://myshop.example/lamp", destinationUrlIsCurrent: true }, d), null);
  });

  // Regression guard (0925 preview build failure): amazonCardSource.ts ships in the
  // browser bundle; importing urlSecurity.ts dragged node:net + node:dns/promises into
  // a client chunk and broke `next build` ("does not support external modules").
  await test("client-bundle modules never import server-only URL-import code", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const clientModules = [
      "src/lib/studio/amazonCardSource.ts",
      "src/lib/studio/marketplaceManualSave.ts",
      "src/lib/productUrlImport/marketplaceHosts.ts",
      "src/lib/productUrlImportClient.ts",
      "src/lib/studio/importedProductFacts.ts",
      "src/lib/studio/storeBatchImport.ts",
      "src/lib/productUrlImport/storeBatchShared.ts",
    ];
    const serverOnly = /from\s+"(?:node:[^"]+|[^"]*productUrlImport\/(?:urlSecurity|urlImportService|storeProductsImport|amazonFetcher|amazonImport|amazonShortLink|extractProductUrls|index)|[^"]*fetch-og\/[^"]+|@\/lib\/productUrlImport)"/;
    for (const rel of clientModules) {
      const src = readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
      // Line-based on `from "…"` so multi-line `import {\n…\n} from "x"` is covered too.
      const hit = src.split("\n").find(line => serverOnly.test(line));
      assert.equal(hit, undefined, `${rel} imports server-only code: ${hit}`);
    }
  });

  // Inline save form on the import panel's marketplace card (0925 follow-up).
  await test("manual save: needs a non-blank title AND an image; keeps the pasted link verbatim", async () => {
    const { canSaveMarketplaceManualDraft, marketplaceManualSaveItem } = await import("../src/lib/studio/marketplaceManualSave");
    const pasted = "https://us.shein.com/20pcs-Mini-Chalkboard-p-86913712.html?src_module=all&mallCode=1";
    const res = { sourceUrl: pasted, sourceDomain: "us.shein.com" };
    assert.equal(canSaveMarketplaceManualDraft({ title: "Chalkboard signs", imageUrl: null }), false);
    assert.equal(canSaveMarketplaceManualDraft({ title: "   ", imageUrl: "https://cdn.example/a.jpg" }), false);
    assert.equal(marketplaceManualSaveItem({ title: "", imageUrl: "https://cdn.example/a.jpg" }, res), null);
    const item = marketplaceManualSaveItem({ title: "  Chalkboard signs  ", imageUrl: "https://cdn.example/a.jpg" }, res)!;
    assert.equal(item.title, "Chalkboard signs");
    assert.equal(item.productUrl, pasted, "destination must be the user's pasted link, unchanged (FR-04-4)");
    assert.equal(item.sourceUrl, pasted);
    assert.equal(item.sourceDomain, "us.shein.com");
    assert.equal(item.imageUrl, "https://cdn.example/a.jpg");
  });

  console.log(`\nMarketplace manual-entry: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
