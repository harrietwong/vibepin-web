/**
 * Behavioral tests: generated Pins carry the CURRENT product's link + Website URL
 * (corrective 2026-07-21, review items 4/5/7).
 * Run: npx tsx scripts/test-generation-product-link.ts
 *
 * Reproduces StudioBoard.handleAiGenerate's product-linking contract against the
 * real store: a prefilled product B links onto BOTH placeholder drafts and
 * provider-returned extra drafts, with the derived Website URL.
 */

import assert from "node:assert";

// localStorage + window shims (same as test-pin-board-store).
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
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const { toLinkedProduct, resolveProductPublicUrl } = await import("../src/lib/studio/productSelection");
  const reset = () => { mem.clear(); store.__resetMemoryCacheForTests(); };

  // Mirror the StudioBoard contract: link product B onto a generated draft.
  const productB = {
    id: "B", title: "Product B", source: "shopify" as const,
    imageUrl: "https://cdn/B.jpg", canonicalUrl: "https://shop.example/products/b",
    asPrimary: true,
  };
  const linkedB = toLinkedProduct(productB);
  const urlB = resolveProductPublicUrl(productB);

  function applyProductToGenerated(draftId: string) {
    store.updateDraft(draftId, {
      linkedProducts: [linkedB],
      primaryProductId: linkedB.productId,
      ...(urlB ? { destinationUrl: urlB } : {}),
    });
  }

  await test("placeholder drafts get product B's link + derived Website URL", () => {
    reset();
    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", generationStatus: "generating", idempotencyKey: "gen:1:0:0" });
    applyProductToGenerated(ph.id);
    const d = store.getDraft(ph.id)!;
    assert.equal(d.primaryProductId, "B");
    assert.equal(d.linkedProducts?.[0]?.productId, "B");
    assert.equal(d.destinationUrl, "https://shop.example/products/b", "Website URL derived from B");
  });

  await test("provider EXTRA drafts also get product B's link (review item 5)", () => {
    reset();
    const extra = store.createBoardDraft({ imageUrl: "https://cdn/out-extra.jpg", source: "ai_generated_from_upload", idempotencyKey: "gen:1:0:extra:0" });
    applyProductToGenerated(extra.id);
    const d = store.getDraft(extra.id)!;
    assert.equal(d.primaryProductId, "B", "an extra result must not lose the product");
    assert.equal(d.destinationUrl, "https://shop.example/products/b");
  });

  await test("Shopify link uses the storefront URL, never Admin", () => {
    reset();
    const admin = {
      id: "C", title: "C", source: "shopify" as const, imageUrl: "https://cdn/C.jpg",
      canonicalUrl: "https://admin.shopify.com/store/acme/products/9",
      publicUrl: "https://acme.example/products/c", asPrimary: true,
    };
    const url = resolveProductPublicUrl(admin);
    assert.equal(url, "https://acme.example/products/c", "admin URL rejected");
  });

  await test("a product with no public URL links without a destinationUrl", () => {
    reset();
    const idea = { id: "D", title: "Idea", source: "product_ideas" as const, imageUrl: "https://cdn/D.jpg", asPrimary: true };
    const url = resolveProductPublicUrl(idea);
    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", idempotencyKey: "gen:2:0:0" });
    store.updateDraft(ph.id, {
      linkedProducts: [toLinkedProduct(idea)],
      primaryProductId: "D",
      ...(url ? { destinationUrl: url } : {}),
    });
    const d = store.getDraft(ph.id)!;
    assert.equal(d.primaryProductId, "D");
    assert.equal(d.destinationUrl ?? "", "", "no public URL → no destination, never invented");
  });

  // ── version drawer: untouched product is inherited from the parent (§3.5) ──

  await test("no drawer product + parent HAS a product → inherit the parent's link and URL", () => {
    reset();
    const parentLinked = [{ productId: "P", title: "Parent Product", source: "shopify" as const, linkType: "manual" as const, productUrl: "https://shop/parent" }];
    const parent = { linkedProducts: parentLinked, primaryProductId: "P", destinationUrl: "https://manually-edited.example/x" };
    // Mirrors StudioBoard: drawer sent nothing (product untouched), so inherit.
    const prefilledProduct = null;
    const parentInherit = !prefilledProduct && parent.linkedProducts.length ? parent.linkedProducts : null;
    const url = prefilledProduct ? undefined : (parentInherit ? parent.destinationUrl || undefined : undefined);
    const primaryId = prefilledProduct ? undefined : parent.primaryProductId;

    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", idempotencyKey: "gen:inh:0" });
    store.updateDraft(ph.id, { linkedProducts: parentInherit ?? undefined, primaryProductId: primaryId, ...(url ? { destinationUrl: url } : {}) });
    const d = store.getDraft(ph.id)!;
    assert.equal(d.primaryProductId, "P", "parent's product preserved");
    assert.equal(d.destinationUrl, "https://manually-edited.example/x", "parent's URL preserved verbatim, not re-derived");
  });

  await test("an implicit draft image contributes NO product link", () => {
    reset();
    // The drawer sends primaryProductSelection = null for an implicit draft image,
    // and the parent has no product → the generated Pin has no linked product.
    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", idempotencyKey: "gen:imp:0" });
    const d = store.getDraft(ph.id)!;
    assert.equal(d.linkedProducts, undefined, "no fabricated product link");
    assert.equal(d.destinationUrl ?? "", "", "no fabricated destination URL");
  });

  console.log(`\nGeneration product link: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
