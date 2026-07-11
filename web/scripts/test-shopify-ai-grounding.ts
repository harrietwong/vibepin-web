/**
 * test-shopify-ai-grounding.ts — WP6 (AI grounding for Shopify products). Phase 1
 * implementation plan §3.7 / §9 / §10 WP6.
 *
 * Run: npx tsx scripts/test-shopify-ai-grounding.ts
 *
 * Covers:
 *  - inferProductContext (generatePinCopy.ts): Shopify-linked draft → vendor/tags
 *    (capped at 10)/price (currency-formatted)/availability all appended; a
 *    non-Shopify-linked draft is completely unaffected (no extra fields, same
 *    output as before this WP); missing vendor/tags/availability on a Shopify
 *    snapshot are simply omitted (never fabricated).
 *  - appendShopifyProductDetails (shopifyGrounding.ts, applied after
 *    buildContextBlock in the ai-copy route's vision-fallback path): renders a
 *    "Product details" line for vendor/tags and a "Price/availability" line only
 *    when present; returns the context block byte-for-byte unchanged when there
 *    is nothing Shopify-specific to add; never dumps a raw JSON payload.
 *  - route.ts wiring sanity: ProductContext type carries the new optional fields,
 *    appendShopifyProductDetails is wired onto buildContextBlock's output, and the
 *    `contextUsed` / `contextSourcesUsed` "product" contracts are unchanged (no
 *    raw productContext payload leaks into contextUsed).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Minimal window/localStorage shim (pinDraftStore is localStorage-backed) ─────
const mem = new Map<string, string>();
const listeners = new Set<() => void>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (_t: string, cb: () => void) => { listeners.add(cb); },
  removeEventListener: (_t: string, cb: () => void) => { listeners.delete(cb); },
  dispatchEvent: () => { listeners.forEach(fn => fn()); return true; },
};

export {};

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const { inferProductContext } = await import("../src/lib/ai-copy/generatePinCopy");
  const { appendShopifyProductDetails } = await import("../src/lib/ai-copy/shopifyGrounding");
  const { buildContextBlock } = await import("../src/lib/ai-copy/visionServer");
  const store = await import("../src/lib/pinDraftStore");
  type GeneratePinterestPinCopyInput = import("../src/lib/ai-copy/types").GeneratePinterestPinCopyInput;
  type LinkedProduct = import("../src/lib/pinMetadata").LinkedProduct;

  function reset() { mem.clear(); store.__resetMemoryCacheForTests(); }

  const baseInput: GeneratePinterestPinCopyInput = {
    draftId: "draft_grounding_test",
    imageUrl: "https://cdn.shopify.com/s/files/1/img1.jpg",
    language: "en",
  };

  // ── inferProductContext: Shopify-linked draft (no setupSnapshot) ────────────

  function makeShopifyDraft(over: Partial<LinkedProduct & { vendor?: string; tags?: string[]; availability?: string; productType?: string }> = {}) {
    reset();
    const linked = {
      productId: "sp_1",
      title: "Rattan Hanging Chair",
      imageUrl: "https://cdn.shopify.com/s/files/1/img1.jpg",
      productUrl: "https://demo.myshopify.com/products/rattan-hanging-chair",
      canonicalUrl: "https://demo.myshopify.com/products/rattan-hanging-chair",
      store: "Demo Store",
      price: "129.99",
      currency: "USD",
      source: "shopify" as const,
      linkType: "auto" as const,
      vendor: "Acme Outdoor",
      tags: ["chair", "rattan", "patio"],
      availability: "in_stock",
      productType: "Furniture",
      ...over,
    };
    const created = store.createBoardDraft({ imageUrl: linked.imageUrl, source: "uploaded_image" });
    store.updateDraft(created.id, { linkedProducts: [linked as LinkedProduct], primaryProductId: linked.productId });
    return store.getDraft(created.id)!;
  }

  await test("inferProductContext: Shopify-linked draft → vendor/tags/price/availability/category all populated", () => {
    const draft = makeShopifyDraft();
    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.title, "Rattan Hanging Chair");
    assert.equal(ctx.category, "Furniture");
    assert.equal(ctx.productUrl, "https://demo.myshopify.com/products/rattan-hanging-chair");
    assert.equal(ctx.vendor, "Acme Outdoor");
    assert.deepEqual(ctx.tags, ["chair", "rattan", "patio"]);
    assert.equal(ctx.price, "USD 129.99", "price must be currency-formatted");
    assert.equal(ctx.availability, "in_stock");
    assert.equal(ctx.source, "shopify");
  });

  await test("inferProductContext: tags are capped at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => `tag${i}`);
    const draft = makeShopifyDraft({ tags: many });
    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.tags?.length, 10);
    assert.deepEqual(ctx.tags, many.slice(0, 10));
  });

  await test("inferProductContext: no currency on the snapshot → price is the raw string, not fabricated with a currency", () => {
    const draft = makeShopifyDraft({ currency: undefined });
    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.price, "129.99");
  });

  await test("inferProductContext: no price at all → price is undefined, never fabricated", () => {
    const draft = makeShopifyDraft({ price: undefined, currency: undefined });
    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.price, undefined);
  });

  await test("inferProductContext: missing vendor/tags/availability on a Shopify snapshot → fields simply absent (no fabrication)", () => {
    const draft = makeShopifyDraft({ vendor: undefined, tags: undefined, availability: undefined, productType: undefined });
    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.vendor, undefined);
    assert.equal(ctx.tags, undefined);
    assert.equal(ctx.availability, undefined);
    // category falls back to input.category (undefined here too) — still no crash/fabrication.
    assert.equal(ctx.category, undefined);
    assert.equal(ctx.title, "Rattan Hanging Chair", "title still comes from the snapshot itself");
  });

  // ── inferProductContext: non-Shopify sources are completely unaffected ──────

  await test("inferProductContext: non-Shopify linked product (my_products) → no vendor/tags/price/availability added, even if present on the object", () => {
    reset();
    const linked = {
      productId: "mp_1",
      title: "Ceramic Vase",
      productUrl: "https://example.com/vase",
      store: "My Products",
      price: "24.00",
      currency: "USD",
      source: "my_products" as const,
      linkType: "manual" as const,
      // Defensive: even if a vendor/tags-shaped field somehow rides along, it must
      // be ignored for non-Shopify sources.
      vendor: "Should Not Appear",
      tags: ["should", "not", "appear"],
    };
    const created = store.createBoardDraft({ imageUrl: "https://example.com/vase.jpg", source: "uploaded_image" });
    store.updateDraft(created.id, { linkedProducts: [linked as unknown as LinkedProduct], primaryProductId: linked.productId });
    const draft = store.getDraft(created.id)!;

    const ctx = inferProductContext(baseInput, draft);
    assert.equal(ctx.vendor, undefined);
    assert.equal(ctx.tags, undefined);
    assert.equal(ctx.availability, undefined);
    assert.equal(ctx.price, undefined, "price/currency formatting is Shopify-only — non-Shopify LinkedProduct.price is not surfaced by this helper");
    assert.equal(ctx.title, undefined, "non-Shopify linkedProducts fallback is out of scope — this WP only grounds Shopify");
  });

  await test("inferProductContext: no storeDraft at all (regression baseline) → unchanged behavior from setupSnapshot", () => {
    const input: GeneratePinterestPinCopyInput = {
      ...baseInput,
      category: "Home Decor",
      destinationUrl: "https://shop.example.com/x",
      setupSnapshot: {
        mode: "product_led",
        noTextOverlay: false,
        imagesPerReference: 1,
        selectedProducts: [{ imageUrl: null, title: "Pink Bedding", productUrl: "https://shop.example.com/bedding", source: "url_imported" }],
        selectedReferences: [],
        promptSnapshot: "",
      },
    };
    const ctx = inferProductContext(input, undefined);
    assert.equal(ctx.title, "Pink Bedding");
    assert.equal(ctx.category, "Home Decor");
    assert.equal(ctx.productUrl, "https://shop.example.com/bedding");
    assert.equal(ctx.source, "url_imported");
    assert.equal(ctx.vendor, undefined);
    assert.equal(ctx.tags, undefined);
    assert.equal(ctx.price, undefined);
    assert.equal(ctx.availability, undefined);
  });

  await test("inferProductContext: setupSnapshot product present AND a Shopify linkedProducts fallback exists → base title/category/productUrl keep priority, Shopify extras still fill in on top", () => {
    const draft = makeShopifyDraft();
    const input: GeneratePinterestPinCopyInput = {
      ...baseInput,
      setupSnapshot: {
        mode: "product_led",
        noTextOverlay: false,
        imagesPerReference: 1,
        selectedProducts: [{ imageUrl: null, title: "Setup Snapshot Title", source: "shopify" }],
        selectedReferences: [],
        promptSnapshot: "",
      },
    };
    const ctx = inferProductContext(input, draft);
    assert.equal(ctx.title, "Setup Snapshot Title", "setupSnapshot product still takes priority for base fields");
    assert.equal(ctx.vendor, "Acme Outdoor", "Shopify extras still layer on top");
    assert.equal(ctx.price, "USD 129.99");
  });

  // ── appendShopifyProductDetails: prompt-context weaving (route.ts's vision path) ─

  const plainBlock = buildContextBlock({
    productContext: { title: "Rattan Hanging Chair", category: "Furniture" },
    pageContext: {},
    boardContext: {},
    keywords: [],
  });

  await test("appendShopifyProductDetails: no Shopify fields → context block returned byte-for-byte unchanged", () => {
    const out = appendShopifyProductDetails(plainBlock, {});
    assert.equal(out, plainBlock);
  });

  await test("appendShopifyProductDetails: vendor + tags → woven onto a 'Product details' line", () => {
    const out = appendShopifyProductDetails(plainBlock, { vendor: "Acme Outdoor", tags: ["chair", "rattan", "patio"] });
    assert.match(out, /Product details.*Acme Outdoor \| chair, rattan, patio/);
    assert.ok(out.startsWith(plainBlock), "appended, not prepended or replacing buildContextBlock's output");
  });

  await test("appendShopifyProductDetails: tags are capped at 10 in the rendered line too", () => {
    const many = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const out = appendShopifyProductDetails(plainBlock, { tags: many });
    const line = out.split("\n").find(l => l.startsWith("Product details"));
    assert.ok(line);
    assert.equal(line!.split(": ")[1].split(", ").length, 10);
  });

  await test("appendShopifyProductDetails: price/availability → one line, only when at least one is present", () => {
    const withBoth = appendShopifyProductDetails(plainBlock, { price: "USD 129.99", availability: "in_stock" });
    assert.match(withBoth, /Price\/availability.*USD 129\.99 — in_stock/);

    const priceOnly = appendShopifyProductDetails(plainBlock, { price: "USD 129.99" });
    assert.match(priceOnly, /Price\/availability.*USD 129\.99/);
    assert.doesNotMatch(priceOnly, /— in_stock/);

    const neither = appendShopifyProductDetails(plainBlock, {});
    assert.doesNotMatch(neither, /Price\/availability/);
  });

  await test("appendShopifyProductDetails: never dumps a raw JSON payload", () => {
    const out = appendShopifyProductDetails(plainBlock, { vendor: "Acme Outdoor", tags: ["chair"], price: "USD 129.99", availability: "in_stock" });
    assert.doesNotMatch(out, /\{"/, "no stringified JSON object in the rendered context");
    assert.doesNotMatch(out, /vibepin_user_id|store_connection_id|external_product_id/, "no internal Shopify identifiers leak into the prompt");
  });

  // ── route.ts wiring sanity (source-level, mirrors test-shopify-product-selection.ts) ──

  await test("route.ts: ProductContext type carries vendor/tags/price/availability as optional fields", () => {
    const src = readFileSync("src/app/api/ai-copy/route.ts", "utf8");
    const typeBlock = src.match(/type ProductContext = \{[\s\S]*?\};/)?.[0] ?? "";
    assert.match(typeBlock, /vendor\?:\s*string/);
    assert.match(typeBlock, /tags\?:\s*string\[\]/);
    assert.match(typeBlock, /price\?:\s*string/);
    assert.match(typeBlock, /availability\?:\s*string/);
  });

  await test("route.ts: appendShopifyProductDetails is imported and wired onto buildContextBlock's output in the vision-fallback path", () => {
    const src = readFileSync("src/app/api/ai-copy/route.ts", "utf8");
    assert.match(src, /import \{ appendShopifyProductDetails \} from "@\/lib\/ai-copy\/shopifyGrounding";/);
    assert.match(src, /appendShopifyProductDetails\(\s*buildContextBlock\(/);
  });

  await test("route.ts: contextUsed still only echoes imageSummary/recommendedKeywords/boardName — no raw productContext payload", () => {
    const src = readFileSync("src/app/api/ai-copy/route.ts", "utf8");
    const block = src.match(/const contextUsed = \{[\s\S]*?\};/)?.[0] ?? "";
    assert.ok(block, "expected a contextUsed object literal");
    assert.match(block, /imageSummary: groundingAnalysis\.imageSummary/);
    assert.match(block, /recommendedKeywords: recommended/);
    assert.match(block, /boardName: boardContext\.name/);
    assert.doesNotMatch(block, /productContext/, "contextUsed must not spread/reference productContext directly");
  });

  await test("route.ts: contextSourcesUsed \"product\" condition is unchanged (title/category only, not vendor/tags)", () => {
    const src = readFileSync("src/app/api/ai-copy/route.ts", "utf8");
    assert.match(src, /if \(productContext\.title \|\| productContext\.category\) sources\.push\("product"\);/);
  });

  await test("visionServer.ts: untouched — buildContextBlock's own productContext param shape is unchanged (title/category only)", () => {
    const src = readFileSync("src/lib/ai-copy/visionServer.ts", "utf8");
    assert.match(src, /productContext: \{ title\?: string; category\?: string \};/, "visionServer.ts must not be modified by this WP");
  });

  console.log(`\nShopify AI grounding: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
