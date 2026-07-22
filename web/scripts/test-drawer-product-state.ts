/**
 * Behavioral tests for the drawer's canonical current-product state
 * (corrective 2026-07-21, review items 2 & 6).
 * Run: npx tsx scripts/test-drawer-product-state.ts
 *
 * The state initialiser and the productUrls⇄selections sync are the two pieces the
 * review flagged. They are exercised here as pure logic (mirrors of the drawer's
 * useState initialiser and its setProductUrls adapter) so behaviour is tested, not
 * source strings.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";

import assert from "node:assert";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  // The PRODUCTION implementations — no mirrored copies in this file.
  const {
    buildInitialProductSelections,
    applyProductUrlEdit,
    isPersistableProduct,
    productRequestKey,
  } = await import("../src/components/studio/AiVersionDrawer");
  const applyUrlEdit = applyProductUrlEdit;

  // ── item 2: initialisation priority ───────────────────────────────────────

  await test("prefilled Select-product selection seeds the state (primary)", () => {
    const out = buildInitialProductSelections({
      initialProductSelection: { title: "B", source: "shopify", imageUrl: "https://cdn/B.jpg" },
      draft: null,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].imageUrl, "https://cdn/B.jpg");
    assert.equal(out[0].asPrimary, true);
  });

  await test("existing draft linked products seed the state when no prefill", () => {
    const out = buildInitialProductSelections({
      draft: {
        id: "d1", imageUrl: "https://cdn/img.jpg",
        linkedProducts: [
          { productId: "p1", title: "P1", imageUrl: "https://cdn/p1.jpg", source: "shopify", linkType: "manual" },
          { productId: "p2", title: "P2", imageUrl: "https://cdn/p2.jpg", source: "shopify", linkType: "manual" },
        ],
      } as never,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "p1");
    assert.equal(out[0].asPrimary, true);
    assert.equal(out[1].asPrimary, false);
  });

  await test("draft image is the implicit product when there are no linked products", () => {
    const out = buildInitialProductSelections({
      draft: { id: "d2", imageUrl: "https://cdn/self.jpg", title: "Self", category: "home" } as never,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].imageUrl, "https://cdn/self.jpg");
    assert.equal(out[0].category, "home");
  });

  await test("prefill takes precedence over the draft (never diluted)", () => {
    const out = buildInitialProductSelections({
      initialProductSelection: { title: "Prefill", source: "shopify", imageUrl: "https://cdn/prefill.jpg" },
      draft: { id: "d3", imageUrl: "https://cdn/draft.jpg", linkedProducts: [{ productId: "x", title: "X", source: "shopify", linkType: "manual" }] } as never,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].imageUrl, "https://cdn/prefill.jpg", "prefill wins");
  });

  await test("empty when nothing is provided (prompt-only scratch)", () => {
    assert.deepEqual(buildInitialProductSelections({ draft: null }), []);
  });

  // ── item 6: clearing a product ────────────────────────────────────────────

  await test("removing the last product image clears the canonical state", () => {
    const state = [{ title: "B", source: "shopify" as const, imageUrl: "https://cdn/B.jpg", selectionOrigin: "explicit_picker" as const }];
    const cleared = applyUrlEdit(state, []); // user removed the only thumbnail
    assert.deepEqual(cleared, [], "no hidden old product survives");
  });

  await test("removing one of two products keeps only the remaining one, promoted to primary", () => {
    const state = [
      { title: "A", source: "shopify" as const, imageUrl: "https://cdn/A.jpg", asPrimary: true, selectionOrigin: "explicit_picker" as const },
      { title: "B", source: "shopify" as const, imageUrl: "https://cdn/B.jpg", asPrimary: false, selectionOrigin: "explicit_picker" as const },
    ];
    const kept = applyUrlEdit(state, ["https://cdn/B.jpg"]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].imageUrl, "https://cdn/B.jpg");
    assert.equal(kept[0].asPrimary, true, "the survivor becomes primary");
  });

  // ── initialSetup + prefill both present → prefill wins (§2.1, test 4.5) ────

  await test("initialSetup AND initialProductSelection both present → prefill wins", () => {
    const out = buildInitialProductSelections({
      initialSetup: { productImages: ["https://cdn/old.jpg"] } as never,
      initialProductSelection: { title: "Prefill B", source: "shopify", imageUrl: "https://cdn/B.jpg" },
      draft: null,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].imageUrl, "https://cdn/B.jpg", "explicit prefill beats a restored setup");
    assert.equal(out[0].selectionOrigin, "explicit_picker");
  });

  // ── initialSetup URLs rehydrate against draft linked products (test 4.6) ──

  await test("initialSetup URL matching a draft linked product restores title/productUrl/store", () => {
    const out = buildInitialProductSelections({
      initialSetup: { productImages: ["https://cdn/p1.jpg"] } as never,
      draft: {
        id: "d1", imageUrl: "https://cdn/self.jpg",
        linkedProducts: [{
          productId: "p1", title: "Rich Product", imageUrl: "https://cdn/p1.jpg",
          productUrl: "https://shop.example/p/1", store: "Acme", source: "shopify", linkType: "manual",
        }],
      } as never,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "Rich Product", "title restored, not blank");
    assert.equal(out[0].publicUrl, "https://shop.example/p/1", "product URL restored");
    assert.equal(out[0].store, "Acme", "store restored");
    assert.equal(out[0].selectionOrigin, "linked_product", "persistable");
  });

  await test("an initialSetup URL with NO matching link stays a bare generation image", () => {
    const out = buildInitialProductSelections({
      initialSetup: { productImages: ["https://cdn/unknown.jpg"] } as never,
      draft: { id: "d2", imageUrl: "https://cdn/self.jpg", linkedProducts: [] } as never,
    });
    assert.equal(out[0].selectionOrigin, "implicit_draft_image");
    assert.equal(isPersistableProduct(out[0]), false, "must not fabricate a product link");
  });

  // ── implicit draft image never becomes a LinkedProduct (test 4.7) ─────────

  await test("a plain draft image is a generation input, never a LinkedProduct", () => {
    const out = buildInitialProductSelections({
      draft: { id: "d3", imageUrl: "https://cdn/photo.jpg", title: "My Pin" } as never,
    });
    assert.equal(out[0].selectionOrigin, "implicit_draft_image");
    assert.equal(isPersistableProduct(out[0]), false);
  });

  await test("explicit and linked-product selections ARE persistable", () => {
    const explicit = buildInitialProductSelections({
      initialProductSelection: { title: "B", source: "shopify", imageUrl: "https://cdn/B.jpg" }, draft: null,
    });
    assert.equal(isPersistableProduct(explicit[0]), true);
    const linked = buildInitialProductSelections({
      draft: { id: "d4", linkedProducts: [{ productId: "p9", title: "P9", source: "shopify", linkType: "manual" }] } as never,
    });
    assert.equal(isPersistableProduct(linked[0]), true);
  });

  // ── version drawer: rich link not clobbered by a bare URL (test 4.8) ──────

  await test("a restored bare URL does not overwrite the draft's rich linked product", () => {
    const out = buildInitialProductSelections({
      initialSetup: { productImages: ["https://cdn/p1.jpg"] } as never,
      draft: {
        id: "d5", imageUrl: "https://cdn/p1.jpg",
        linkedProducts: [{ productId: "p1", title: "Kept", imageUrl: "https://cdn/p1.jpg", productUrl: "https://shop/x", source: "shopify", linkType: "manual" }],
      } as never,
    });
    assert.equal(out[0].title, "Kept", "rich fields survive the bare-URL restore");
    assert.equal(out[0].id, "p1");
  });

  // ── product request key (drives the stale guard) ──────────────────────────

  await test("productRequestKey changes when identity or request-shaping fields change", () => {
    const a = { title: "A", source: "shopify" as const, imageUrl: "https://cdn/A.jpg", selectionOrigin: "explicit_picker" as const };
    const b = { ...a, imageUrl: "https://cdn/B.jpg" };
    assert.notEqual(productRequestKey(a), productRequestKey(b), "different image → different key");
    assert.notEqual(productRequestKey(a), productRequestKey({ ...a, title: "A2" }), "different title → different key");
    assert.notEqual(productRequestKey(a), productRequestKey({ ...a, productType: "top" }), "different type → different key");
    assert.notEqual(productRequestKey(a), productRequestKey({ ...a, tags: ["x"] }), "different tags → different key");
    assert.equal(productRequestKey(a), productRequestKey({ ...a }), "same product → same key");
    assert.equal(productRequestKey(null), "");
  });

  console.log(`\nDrawer product state: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
