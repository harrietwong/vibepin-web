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
import type { CanonicalProductSelection } from "../src/lib/studio/productSelection";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

/** Mirror of AiVersionDrawer's setProductUrls adapter: URL edits map back onto the
 *  canonical selection list by keeping only matching selections. */
function applyUrlEdit(prev: CanonicalProductSelection[], nextUrls: string[]): CanonicalProductSelection[] {
  const keep = new Set(nextUrls);
  return prev.filter(s => s.imageUrl && keep.has(s.imageUrl));
}

async function main() {
  const { buildInitialProductSelections } = await import("../src/components/studio/AiVersionDrawer");

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
    const state: CanonicalProductSelection[] = [{ title: "B", source: "shopify", imageUrl: "https://cdn/B.jpg" }];
    const cleared = applyUrlEdit(state, []); // user removed the only thumbnail
    assert.deepEqual(cleared, [], "no hidden old product survives");
  });

  await test("removing one of two products keeps only the remaining one", () => {
    const state: CanonicalProductSelection[] = [
      { title: "A", source: "shopify", imageUrl: "https://cdn/A.jpg" },
      { title: "B", source: "shopify", imageUrl: "https://cdn/B.jpg" },
    ];
    const kept = applyUrlEdit(state, ["https://cdn/B.jpg"]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].imageUrl, "https://cdn/B.jpg");
  });

  console.log(`\nDrawer product state: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
