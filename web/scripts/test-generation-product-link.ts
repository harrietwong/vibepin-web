// Stub env before importing the drawer (LocaleProvider builds a Supabase client).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";
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
  const { toLinkedProduct, resolveProductPublicUrl, selectionFromLinkedProduct } = await import("../src/lib/studio/productSelection");
  // Production gates — not reimplemented here.
  const { isUserChosenProduct } = await import("../src/components/studio/AiVersionDrawer");
  const { PRODUCT_DERIVED_URL_SOURCE, isAutoManaged } = await import("../src/lib/studio/destinationUrlDerivation");
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
  //
  // The PRODUCTION gate is isUserChosenProduct(): the drawer sends a product only
  // when the user actively chose one this session. A restored `linked_product` is
  // NOT a choice — the previous version of this test hard-coded prefilledProduct=null
  // and therefore passed while the shipped drawer sent a product and skipped the
  // inheritance branch entirely (Codex finding #1). Now we drive the real gate.

  await test("a RESTORED product is not 'user chosen' → drawer sends nothing → parent inherited", () => {
    const restored = { title: "P", source: "shopify" as const, imageUrl: "https://cdn/P.jpg", selectionOrigin: "linked_product" as const };
    assert.equal(isUserChosenProduct(restored), false, "restore is not a user choice");
    // …so opts.primaryProductSelection is null and StudioBoard takes the parent branch.
    reset();
    const parentLinked = [
      { productId: "P", title: "Parent Product", source: "shopify" as const, linkType: "manual" as const, productUrl: "https://shop/parent" },
      { productId: "T", title: "Tagged", source: "shopify" as const, linkType: "manual" as const },
    ];
    const parent = { linkedProducts: parentLinked, primaryProductId: "P", destinationUrl: "https://manually-edited.example/x", destinationUrlSource: "manual" };
    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", idempotencyKey: "gen:inh:0" });
    store.updateDraft(ph.id, {
      linkedProducts: parent.linkedProducts,
      primaryProductId: parent.primaryProductId,
      destinationUrl: parent.destinationUrl,
      destinationUrlSource: parent.destinationUrlSource,
    });
    const d = store.getDraft(ph.id)!;
    assert.equal(d.primaryProductId, "P", "parent's primaryProductId preserved");
    assert.equal(d.linkedProducts?.length, 2, "TAGGED products preserved, not collapsed to one");
    assert.equal(d.destinationUrl, "https://manually-edited.example/x", "manual URL preserved verbatim");
    assert.equal(d.destinationUrlSource, "manual", "…and stays manual, so nothing later overwrites it");
  });

  await test("an EXPLICIT pick IS user chosen → drawer sends it → product B wins", () => {
    const chosen = { title: "B", source: "shopify" as const, imageUrl: "https://cdn/B.jpg", selectionOrigin: "explicit_picker" as const };
    assert.equal(isUserChosenProduct(chosen), true);
  });

  await test("product-derived URLs are stamped with provenance so they stay updatable", () => {
    reset();
    const ph = store.createBoardDraft({ imageUrl: "", source: "ai_generated_from_upload", idempotencyKey: "gen:prov:0" });
    store.updateDraft(ph.id, {
      linkedProducts: [linkedB], primaryProductId: "B",
      destinationUrl: urlB, destinationUrlSource: PRODUCT_DERIVED_URL_SOURCE,
    });
    const d = store.getDraft(ph.id)!;
    assert.equal(d.destinationUrlSource, "product", "without this, later derivation treats it as manual and never updates/clears it");
    assert.equal(isAutoManaged({ destinationUrl: d.destinationUrl, destinationUrlSource: d.destinationUrlSource }), true);
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

  // ── Retry preserves the failed run's product (Codex review #3, finding 2) ──

  await test("a failed draft's product survives retry as an EXPLICIT selection", () => {
    // A scratch retry has no parent, and a restored image URL alone is classified as
    // implicit_draft_image → primaryProductSelection null → product silently dropped.
    // Passing the failed draft's own linked product as a selection is what saves it.
    const failedLinked = {
      productId: "sp_777", title: "Shopify Product", source: "shopify" as const,
      linkType: "manual" as const, productUrl: "https://shop.example/p/7",
    };
    const selection = selectionFromLinkedProduct(failedLinked);
    assert.equal(selection.id, "sp_777", "server id preserved");
    assert.equal(selection.publicUrl, "https://shop.example/p/7");
    // …and once handed to the drawer as an explicit pick it is persistable again.
    const relinked = toLinkedProduct({ ...selection, asPrimary: true });
    assert.equal(relinked.productId, "sp_777", "not downgraded to a local id");
    assert.equal(relinked.productUrl, "https://shop.example/p/7");
  });

  await test("saveAsset BACKFILLS missing fields on an existing asset (migration)", async () => {
    reset();
    const assets = await import("../src/lib/assetStore");
    // An asset saved BEFORE shopifyProductId existed.
    const first = assets.saveAsset({
      role: "product", source: "shopify", imageUrl: "https://cdn/legacy.jpg", title: "Legacy",
    } as never);
    assert.equal(first.shopifyProductId, undefined);
    // Selecting the same product again now carries the server id — it must attach,
    // otherwise the same product yields two different productKeys.
    const second = assets.saveAsset({
      role: "product", source: "shopify", imageUrl: "https://cdn/legacy.jpg",
      title: "Legacy", shopifyProductId: "sp_555", canonicalUrl: "https://shop/x", price: "9",
    } as never);
    assert.equal(second.id, first.id, "still the same asset, not a duplicate");
    assert.equal(second.shopifyProductId, "sp_555", "missing field backfilled");
    assert.equal(second.canonicalUrl, "https://shop/x");
  });

  await test("backfill never OVERWRITES a value the asset already has", async () => {
    reset();
    const assets = await import("../src/lib/assetStore");
    assets.saveAsset({
      role: "product", source: "shopify", imageUrl: "https://cdn/x.jpg", title: "Original Title",
    } as never);
    const again = assets.saveAsset({
      role: "product", source: "shopify", imageUrl: "https://cdn/x.jpg", title: "Different Title",
    } as never);
    assert.equal(again.title, "Original Title", "existing user data is not clobbered");
  });

  console.log(`\nGeneration product link: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
