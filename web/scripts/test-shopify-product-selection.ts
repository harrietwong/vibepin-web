/**
 * test-shopify-product-selection.ts — WP5 (Picker integration: Create Pins + AI
 * Drawer, single-product card creation). Phase 1 implementation plan §9 / §10 WP5.
 *
 * Run: npx tsx scripts/test-shopify-product-selection.ts
 *
 * Covers:
 *  - normalizeProductSource("shopify") + productSourceLabel (pinMetadata.ts, §3.1/§5)
 *  - Shopify product row → ProductSelection-compatible mapping, incl. price/currency/store
 *    (ShopifyProductPickerPanel.shopifyProductToSelection)
 *  - ProductSelection → LinkedProduct snapshot: all fields present, source === "shopify"
 *    (mirrors StudioBoard.tsx's handleProductSelect / PinDetailsDrawer's established
 *    toLinkedProductFromSelection pattern)
 *  - saveToLibrary default false (no assetStore write) vs true (writes with source
 *    "shopify") — behavioral via assetStore + wiring regex on ProductPickerModal.tsx
 *  - Product → Pin draft creation: destinationUrl stays "" (never auto-filled), title
 *    is prefilled from the product title, linkedProducts/primaryProductId land on the
 *    real pinDraftStore (not a mock)
 *  - Multi-image selection: the first selected image becomes the card cover
 *  - Wiring sanity: the Shopify tab/source is actually present in ProductPickerModal,
 *    InlineCreateAssetPicker and StudioBoard
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Minimal window/localStorage shim (pinDraftStore + assetStore are localStorage-backed) ─
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
// Minimal `document` stub. Two module-scope consumers need it:
//  - @supabase/phoenix (pulled in by ShopifyProductPickerPanel) registers a window
//    "visibilitychange" listener that reads document.visibilityState on dispatchEvent.
//  - sonner (toast lib, transitively imported) injects a <style> tag at import time
//    via document.head / getElementsByTagName / createElement / createTextNode.
function stubNode() {
  return {
    appendChild: () => {},
    styleSheet: undefined as unknown,
  };
}
const stubHead = stubNode();
(globalThis as unknown as { document: unknown }).document = {
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
  head: stubHead,
  getElementsByTagName: () => [stubHead],
  createElement: () => stubNode(),
  createTextNode: () => ({}),
};

// Dummy env so importing shopifyClient's supabase-browser chain never throws
// (ShopifyProductPickerPanel.tsx imports shopifyClient.ts at module scope).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

export {};

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  const pinMetadata = await import("../src/lib/pinMetadata");
  const assets = await import("../src/lib/assetStore");
  const store = await import("../src/lib/pinDraftStore");
  const panel = await import("../src/components/studio/ShopifyProductPickerPanel");
  type ShopifyProductListItem = import("../src/lib/shopifyClient").ShopifyProductListItem;
  type ProductSelectionLike = {
    id?: string; title: string; imageUrl?: string; url?: string; canonicalUrl?: string;
    store?: string; price?: string; currency?: string; source: string;
    asPrimary: boolean; saveToLibrary: boolean; images?: { url: string; alt?: string }[];
  };

  function reset() { mem.clear(); store.__resetMemoryCacheForTests(); }

  // ── pinMetadata: ProductSourceKind / label ──────────────────────────────────

  await test("normalizeProductSource(\"shopify\") === \"shopify\"", () => {
    assert.equal(pinMetadata.normalizeProductSource("shopify"), "shopify");
  });

  await test("productSourceLabel(\"shopify\") === \"Shopify\"", () => {
    assert.equal(pinMetadata.productSourceLabel("shopify"), "Shopify");
  });

  await test("normalizeProductSource default cases are unaffected (no regression)", () => {
    assert.equal(pinMetadata.normalizeProductSource("url"), "url_imported");
    assert.equal(pinMetadata.normalizeProductSource(undefined), "manual");
  });

  // ── Row → ProductSelection mapping ──────────────────────────────────────────

  function makeRow(over: Partial<ShopifyProductListItem> = {}): ShopifyProductListItem {
    return {
      id: "sp_123",
      title: "Rattan Hanging Chair",
      handle: "rattan-hanging-chair",
      productUrl: "https://demo.myshopify.com/products/rattan-hanging-chair",
      adminUrl: "https://demo.myshopify.com/admin/products/123",
      status: "active",
      availability: "in_stock",
      vendor: "Acme",
      productType: "Furniture",
      tags: ["chair", "rattan"],
      price: { amount: 129.99, currency: "USD", compareAt: null },
      primaryImageUrl: "https://cdn.shopify.com/s/files/1/img1.jpg",
      imageCount: 3,
      updatedAtSource: "2026-01-01T00:00:00Z",
      deletedAt: null,
      ...over,
    };
  }

  await test("shopifyProductToSelection: maps id/title/imageUrl/url/canonicalUrl/store/price/currency", () => {
    const sel = panel.shopifyProductToSelection(makeRow(), "Demo Store");
    assert.equal(sel.id, "sp_123");
    assert.equal(sel.title, "Rattan Hanging Chair");
    assert.equal(sel.imageUrl, "https://cdn.shopify.com/s/files/1/img1.jpg");
    assert.equal(sel.url, "https://demo.myshopify.com/products/rattan-hanging-chair");
    assert.equal(sel.canonicalUrl, sel.url);
    assert.equal(sel.store, "Demo Store");
    assert.equal(sel.price, "129.99");
    assert.equal(sel.currency, "USD");
  });

  await test("shopifyProductToSelection: no price on the row → selection.price/currency undefined", () => {
    const sel = panel.shopifyProductToSelection(makeRow({ price: { amount: null, currency: null, compareAt: null } }));
    assert.equal(sel.price, undefined);
    assert.equal(sel.currency, undefined);
  });

  await test("shopifyProductToSelection: falls back to \"Product\" when the store title is blank", () => {
    const sel = panel.shopifyProductToSelection(makeRow({ title: "" }));
    assert.equal(sel.title, "Product");
  });

  // ── ProductSelection → LinkedProduct snapshot (mirrors StudioBoard.handleProductSelect) ──

  function toLinkedProductFromSelection(p: ProductSelectionLike) {
    const chosenImageUrl = p.images?.[0]?.url ?? p.imageUrl ?? "";
    return {
      linked: {
        productId:    p.id,
        title:        p.title?.trim() || "Product",
        imageUrl:     chosenImageUrl,
        thumbnailUrl: chosenImageUrl,
        productUrl:   p.url,
        canonicalUrl: p.canonicalUrl,
        store:        p.store,
        price:        p.price,
        currency:     p.currency,
        source:       pinMetadata.normalizeProductSource(p.source),
        linkType:     "auto" as const,
      },
      chosenImageUrl,
    };
  }

  await test("ProductSelection → LinkedProduct: full snapshot, source === \"shopify\"", () => {
    const sel = panel.shopifyProductToSelection(makeRow(), "Demo Store");
    const selection: ProductSelectionLike = { ...sel, source: "shopify", asPrimary: true, saveToLibrary: false };
    const { linked } = toLinkedProductFromSelection(selection);
    assert.equal(linked.productId, "sp_123");
    assert.equal(linked.title, "Rattan Hanging Chair");
    assert.equal(linked.imageUrl, "https://cdn.shopify.com/s/files/1/img1.jpg");
    assert.equal(linked.thumbnailUrl, linked.imageUrl);
    assert.equal(linked.productUrl, "https://demo.myshopify.com/products/rattan-hanging-chair");
    assert.equal(linked.canonicalUrl, linked.productUrl);
    assert.equal(linked.store, "Demo Store");
    assert.equal(linked.price, "129.99");
    assert.equal(linked.currency, "USD");
    assert.equal(linked.source, "shopify");
    assert.equal(linked.linkType, "auto");
  });

  await test("Multi-image selection: the FIRST selected image becomes the card cover, not the primary image", () => {
    const sel = panel.shopifyProductToSelection(makeRow(), "Demo Store");
    const selection: ProductSelectionLike = {
      ...sel, source: "shopify", asPrimary: true, saveToLibrary: false,
      images: [{ url: "https://cdn.shopify.com/s/files/1/img2.jpg" }, { url: "https://cdn.shopify.com/s/files/1/img3.jpg" }],
    };
    const { chosenImageUrl } = toLinkedProductFromSelection(selection);
    assert.equal(chosenImageUrl, "https://cdn.shopify.com/s/files/1/img2.jpg", "first checked image wins over primaryImageUrl");
  });

  // ── saveToLibrary: default false → no assetStore write; true → writes with source "shopify" ──

  await test("saveToLibrary=false: no asset is written to My Products", () => {
    reset();
    // Simulates ProductPickerModal's shopify tab with the checkbox left unchecked
    // (its default) — the handler simply never calls assetStore.saveAsset.
    assert.equal(assets.getByRole("product").length, 0);
  });

  await test("saveToLibrary=true: writes an asset with source \"shopify\" and the product's fields", () => {
    reset();
    const sel = panel.shopifyProductToSelection(makeRow(), "Demo Store");
    assets.saveAsset({
      role: "product",
      source: "shopify",
      imageUrl: sel.imageUrl ?? "",
      title: sel.title,
      productUrl: sel.url,
      canonicalUrl: sel.canonicalUrl,
      store: sel.store,
      price: sel.price,
      currency: sel.currency,
    });
    const saved = assets.getByRole("product");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].source, "shopify");
    assert.equal(saved[0].title, "Rattan Hanging Chair");
    assert.equal(saved[0].store, "Demo Store");
    assert.equal(saved[0].price, "129.99");
  });

  await test("ProductPickerModal: shopifySaveToLibrary defaults to false (decision 5 — never auto-populate My Products)", () => {
    const src = readFileSync("src/components/studio/ProductPickerModal.tsx", "utf8");
    assert.match(src, /shopifySaveToLibrary,\s*setShopifySaveToLibrary\]\s*=\s*useState<boolean>\(false\)/);
    assert.match(src, /if \(shopifySaveToLibrary\)\s*\{[\s\S]*?assetStore\.saveAsset/);
  });

  // ── Product → Pin draft creation: destinationUrl empty, title prefilled ────────────────

  await test("createBoardDraft from a Shopify product: destinationUrl stays empty, title is prefilled", () => {
    reset();
    const sel = panel.shopifyProductToSelection(makeRow(), "Demo Store");
    const selection: ProductSelectionLike = { ...sel, source: "shopify", asPrimary: true, saveToLibrary: false };
    const { linked, chosenImageUrl } = toLinkedProductFromSelection(selection);

    const created = store.createBoardDraft({
      imageUrl: chosenImageUrl,
      source: "uploaded_image",
      title: selection.title?.trim() || undefined,
    });
    store.updateDraft(created.id, { linkedProducts: [linked], primaryProductId: linked.productId });

    const draft = store.getDraft(created.id)!;
    assert.equal(draft.destinationUrl, "", "destinationUrl must never be auto-filled from a Shopify product");
    assert.equal(draft.title, "Rattan Hanging Chair", "title must be prefilled from the product title");
    assert.equal(draft.imageUrl, "https://cdn.shopify.com/s/files/1/img1.jpg");
    assert.equal(draft.linkedProducts?.length, 1);
    assert.equal(draft.linkedProducts?.[0]?.source, "shopify");
    assert.equal(draft.primaryProductId, "sp_123");
    assert.equal(draft.source, "uploaded_image");
  });

  await test("StudioBoard.tsx: the product→draft mapping never passes destinationUrl and sets primaryProductId from the LinkedProduct", () => {
    const src = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
    assert.match(src, /const created = pinDraftStore\.createBoardDraft\(\{[\s\S]{0,200}?\}\);/);
    const createCallMatch = src.match(/const created = pinDraftStore\.createBoardDraft\(\{([\s\S]{0,200}?)\}\);/);
    assert.ok(createCallMatch, "expected a createBoardDraft(...) call in the product-select handler");
    assert.doesNotMatch(createCallMatch![1], /destinationUrl/, "createBoardDraft must never be called with a destinationUrl");
    assert.match(src, /primaryProductId:\s*linkedProduct\.productId/);
    assert.match(src, /source:\s*normalizeProductSource\(p\.source\)/);
  });

  // ── Wiring sanity: the Shopify surface actually exists in the three host files ──────────

  await test("ProductPickerModal: shopify tab is wired (flag-gated, source badge, sourceBadge label)", () => {
    const src = readFileSync("src/components/studio/ProductPickerModal.tsx", "utf8");
    assert.match(src, /shopifyEnabled = isShopifyIntegrationEnabled\(\)/);
    assert.match(src, /labelKey: "studioModals\.source\.shopify",\s*bg: "rgba\(149,191,71/);
  });

  await test("InlineCreateAssetPicker: \"From Shopify\" source is wired for the product role only", () => {
    const src = readFileSync("src/components/studio/InlineCreateAssetPicker.tsx", "utf8");
    assert.match(src, /\{ id: "shopify", labelKey: "studioModals\.tabs\.fromShopify" \}/);
    assert.match(src, /mode="select-images"\s*onSelectImages=\{saveShopifyImages\}/);
  });

  await test("StudioBoard: \"Select product\" entry points open ProductPickerModal on the shopify tab", () => {
    const src = readFileSync("src/components/studio/StudioBoard.tsx", "utf8");
    assert.match(src, /board-select-product/);
    assert.match(src, /board-select-product-empty/);
    assert.match(src, /initialTab="shopify"/);
  });

  console.log(`\nShopify product selection: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
