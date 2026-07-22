/**
 * Canonical Product Picker consolidation tests (corrective commit, 2026-07-21).
 * Run: npx tsx scripts/test-canonical-picker.ts
 *
 * These assert the ARCHITECTURE the review required — one picker, one selection
 * shape, top-level Select product opening the AI drawer — via source inspection,
 * since the behaviours live in React components that need a DOM. The interactive
 * paths are additionally covered by the Playwright spec.
 */

// The picker component pulls in LocaleProvider → a Supabase browser client, which
// throws without env. Stub the two public vars BEFORE the module is imported (done
// via a dynamic import in main(), since ESM hoists static imports above statements).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineAssetItem } from "../src/components/studio/InlineCreateAssetPicker";

type SelectionsFromInlineItems =
  typeof import("../src/components/studio/CanonicalProductPicker")["selectionsFromInlineItems"];
let selectionsFromInlineItems: SelectionsFromInlineItems;

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

async function main() {
  ({ selectionsFromInlineItems } = await import("../src/components/studio/CanonicalProductPicker"));
  run();
  console.log(`\nCanonical picker: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

function run() {

// ── One selection shape everywhere ──────────────────────────────────────────

test("ProductPickerModal is deleted", () => {
  let exists = true;
  try { read("components/studio/ProductPickerModal.tsx"); } catch { exists = false; }
  assert.equal(exists, false, "the second user-facing picker must be gone");
});

test("no file imports ProductPickerModal", () => {
  for (const f of ["components/studio/StudioBoard.tsx", "components/studio/PinDetailsDrawer.tsx"]) {
    assert.ok(!/from ["'].*ProductPickerModal["']/.test(read(f)), `${f} still imports ProductPickerModal`);
  }
});

test("no file imports ProductSelection from ProductPickerModal", () => {
  for (const f of ["components/studio/StudioBoard.tsx", "components/studio/PinDetailsDrawer.tsx"]) {
    assert.ok(
      !/ProductSelection.*from ["'].*ProductPickerModal["']/.test(read(f)),
      `${f} still imports the old ProductSelection type`,
    );
  }
});

test("StudioBoard and PinDetailsDrawer both render the CanonicalProductPicker", () => {
  for (const f of ["components/studio/StudioBoard.tsx", "components/studio/PinDetailsDrawer.tsx"]) {
    assert.ok(read(f).includes("<CanonicalProductPicker"), `${f} does not use CanonicalProductPicker`);
  }
});

test("the canonical picker hosts the shared InlineCreateAssetPicker in product role", () => {
  const src = read("components/studio/CanonicalProductPicker.tsx");
  assert.ok(src.includes("InlineCreateAssetPicker"), "must reuse the one picker implementation");
  assert.ok(src.includes('role="product"'), "must host the product role");
});

// ── selectionsFromInlineItems mapping ───────────────────────────────────────

function item(over: Partial<InlineAssetItem> = {}): InlineAssetItem {
  return { id: "a1", imageUrl: "https://cdn/a.png", source: "shopify", title: "A", productUrl: "https://shop/a", ...over };
}

test("mapper returns CanonicalProductSelection with all fields", () => {
  const [s] = selectionsFromInlineItems([item({ canonicalUrl: "https://shop/a?c", store: "S", price: "9", currency: "USD" })], false);
  assert.equal(s.id, "a1");
  assert.equal(s.title, "A");
  assert.equal(s.publicUrl, "https://shop/a");
  assert.equal(s.canonicalUrl, "https://shop/a?c");
  assert.equal(s.store, "S");
  assert.equal(s.price, "9");
  assert.equal(s.source, "shopify");
});

test("first pick is primary only when the Pin has no primary yet", () => {
  const noPrimary = selectionsFromInlineItems([item({ id: "x" }), item({ id: "y" })], false);
  assert.equal(noPrimary[0].asPrimary, true, "first becomes primary");
  assert.equal(noPrimary[1].asPrimary, false, "second is tagged");

  const hasPrimary = selectionsFromInlineItems([item({ id: "x" })], true);
  assert.equal(hasPrimary[0].asPrimary, false, "a pick never displaces an existing primary");
});

// ── Top-level Select product opens the AI drawer (no orphan draft) ──────────

test("StudioBoard's product select opens the AI drawer, not a bare draft", () => {
  const src = read("components/studio/StudioBoard.tsx");
  const handler = src.slice(src.indexOf("const handleProductSelect"), src.indexOf("const handleProductSelect") + 700);
  assert.ok(handler.includes('setAiDrawer({ mode: "scratch"'), "must open the scratch AI drawer");
  assert.ok(!handler.includes("createBoardDraft"), "must NOT create a draft on selection");
});

test("scratch drawer carries the product prefill", () => {
  const src = read("components/studio/StudioBoard.tsx");
  assert.ok(src.includes("initialProductSelection="), "AiVersionDrawer must receive the prefilled product");
  assert.ok(/mode: "scratch"; product\?: CanonicalProductSelection/.test(src), "scratch state carries a product");
});

test("AiVersionDrawer seeds product images from the prefill", () => {
  const src = read("components/studio/AiVersionDrawer.tsx");
  assert.ok(src.includes("initialProductSelection?.imageUrl"), "productUrls must seed from the prefill");
});

// ── recommendationBasis honesty + failure isolation ─────────────────────────

test("category_fallback / missing basis renders Category inspiration", () => {
  const src = read("components/studio/AiVersionDrawer.tsx");
  assert.ok(src.includes('recommendationBasis === "category_fallback"'), "heading switches on basis");
  assert.ok(src.includes("headingCategory"), "Category inspiration heading key used");
  // The default keeps unknown/missing values honest.
  assert.ok(src.includes('setRecommendationBasis(') && src.includes('"category_fallback"'), "defaults to category_fallback");
});

test("a failed recommendation request shows error+retry, not stale results", () => {
  const src = read("components/studio/AiVersionDrawer.tsx");
  assert.ok(src.includes('setRecStatus("error")'), "failure sets an error state");
  assert.ok(src.includes("recommended-references-error"), "error state renders");
  assert.ok(src.includes("recommended-retry"), "retry affordance exists");
});

test("the stale guard is actually WIRED into the drawer, not just exported", () => {
  const src = read("components/studio/AiVersionDrawer.tsx");
  assert.ok(src.includes("isCurrentResult"), "drawer must import and call isCurrentResult");
  assert.ok(src.includes("currentProductKeyRef"), "a current-product key ref must exist");
  // Both async paths (analysis + recommendations) must consult the guard.
  const guardDefs = src.match(/const isStale = \(\) =>/g) ?? [];
  assert.equal(guardDefs.length, 2, "both the analysis and recommendation effects need the guard");
  const guardUses = src.match(/if \(isStale\(\)\) return;/g) ?? [];
  assert.ok(guardUses.length >= 3, `every then/catch must check it (found ${guardUses.length})`);
});

test("the immediate-persist block writes destinationUrl to the TOP LEVEL, not only the draft", () => {
  // Pairs with test-url-persistence (which can only mirror these closures): the form
  // is rebuilt from pin.destinationUrl, so persisting metadataDraft alone made an
  // automated URL vanish on reopen.
  const src = readFileSync(join(SRC, "app/app/studio/page.tsx"), "utf8");
  const block = src.slice(src.indexOf("function handleMetadataChange"), src.indexOf("function handleMetadataChange") + 1800);
  assert.ok(block.includes("automatedUrlFill"), "the automated-fill signal must be consulted");
  assert.ok(/destinationUrl: patch\.destinationUrl/.test(block), "top-level destinationUrl must be written");
  assert.ok(/destinationUrlTouched: false/.test(block), "a derived fill must stay auto-managed");
});

test("changing product clears old basis before the new request", () => {
  const src = read("components/studio/AiVersionDrawer.tsx");
  const block = src.slice(src.indexOf("if (productKey !== prevProductKey)"), src.indexOf("if (productKey !== prevProductKey)") + 400);
  assert.ok(block.includes("setRecommendedRefs([])"), "old recs cleared");
  assert.ok(block.includes('setRecommendationBasis("category_fallback")'), "old basis cleared");
  assert.ok(block.includes("setProductChanged(true)"), "refresh notice armed");
});

}

void main();
