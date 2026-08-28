#!/usr/bin/env tsx
/**
 * The Create Pins prefill handoff into the DEFAULT (board-v2) Studio.
 * Run: npx tsx scripts/test-studio-prefill-handoff.ts
 *
 * Every "Generate from this…" button in the app saves a prefill and navigates to
 * /app/studio?prefillKey=…. Only the LEGACY Studio ever read that key, and legacy is
 * not what users get — so on the default board the brief, product and reference were
 * dropped on arrival and the button looked like it had worked. These tests cover the
 * pure half of the fix; what they protect is not shape but three promises:
 *
 * **The brief the user was promised survives.** A seeded directionBrief with
 * briefManuallyEdited false is silently replaced by the drawer's derived brief, which
 * would make the insight's instruction vanish while the drawer still looked filled in.
 *
 * **The account travels with the Pin.** A prefill from account B's Insights must put
 * B's connection on the draft; a Pin that publishes to account A is worse than no
 * button, and nothing downstream would catch it after the fact.
 *
 * **A consumed or missing key yields nothing.** The key is consume-once, so a refresh
 * must not reopen the drawer over work the user has since started.
 *
 * Exit code 0 = all pass, 1 = failures.
 */

import {
  prefillToDrawerSeed,
  destinationDraftPatch,
  DRAWER_SEED_DEFAULTS,
} from "../src/lib/studio/prefillDrawerSeed";
import {
  buildPrefillFromInsight,
  savePrefill,
  loadPrefill,
  type CreatePinsPrefill,
} from "../src/lib/createPinsPrefill";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`     ${String(e)}`); failed++; }
}
function eq(a: unknown, b: unknown, msg?: string): void {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

// A minimal sessionStorage so the consume-once contract is exercised through the real
// loadPrefill rather than a re-implementation of it.
const store = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} as Storage;

const INSIGHT_PREFILL = buildPrefillFromInsight({
  connectionId: "conn-B",
  category: "home office",
  recommendation: {
    keep: "Vertical shots of the desk in daylight.",
    change: { variable: "first image", phrasing: "Lead with the product, not the room." },
    test: "Whether a tighter crop holds attention past two seconds.",
  },
  sourcePin: {
    imageUrl: "https://img.example/pin-1.jpg",
    title: "Desk setup",
    pinId: "pin-1",
    draftId: "draft-1",
    boardId: "board-9",
    boardName: "Home Office",
  },
});

console.log("\nInsights prefill -> drawer seed");

test("the insight's brief is carried and marked authoritative", () => {
  const seed = prefillToDrawerSeed(INSIGHT_PREFILL);
  ok(!!seed, "expected a seed");
  ok(seed!.setup.directionBrief.includes("first image"),
    `named variable missing from brief: ${seed!.setup.directionBrief}`);
  // False here means the drawer overwrites it with its own derived brief — the
  // instruction would disappear from a drawer that still looked correctly filled in.
  eq(seed!.setup.briefManuallyEdited, true, "seeded brief must be authoritative");
});

test("the source Pin becomes a style reference with its identity intact", () => {
  const seed = prefillToDrawerSeed(INSIGHT_PREFILL)!;
  eq(seed.setup.referenceImages.length, 1);
  eq(seed.setup.referenceImages[0], "https://img.example/pin-1.jpg");
  eq(seed.setup.referenceSelections?.[0]?.id, "pin-1");
  eq(seed.setup.referenceSelections?.[0]?.role, "style_reference");
});

test("the destination reaches the seed with account and board", () => {
  const seed = prefillToDrawerSeed(INSIGHT_PREFILL)!;
  eq(seed.destination?.socialConnectionId, "conn-B");
  eq(seed.destination?.boardId, "board-9");
  eq(seed.destination?.boardName, "Home Office");
});

test("drawer defaults are the drawer's own, not invented", () => {
  const seed = prefillToDrawerSeed(INSIGHT_PREFILL)!;
  eq(seed.setup.count, DRAWER_SEED_DEFAULTS.count);
  eq(seed.setup.format, DRAWER_SEED_DEFAULTS.format);
  eq(seed.setup.modelKey, DRAWER_SEED_DEFAULTS.modelKey);
  eq(seed.setup.variationMode, DRAWER_SEED_DEFAULTS.variationMode);
  eq(seed.setup.selectedDirectionId, null);
  eq(seed.setup.selectedTagIds.length, 0);
});

console.log("\nProduct and viral prefills");

test("a product prefill seeds the product strip and the drawer's product", () => {
  const prefill: CreatePinsPrefill = {
    source: "product_signals",
    productImages: [{
      id: "prod-7", imageUrl: "https://img.example/p.jpg", title: "Oak lamp",
      source: "product_signals", productUrl: "https://shop.example/oak-lamp", category: "lighting",
    }],
    promptSeed: "A warm lamp on a walnut desk.",
  };
  const seed = prefillToDrawerSeed(prefill)!;
  eq(seed.product?.id, "prod-7");
  eq(seed.product?.imageUrl, "https://img.example/p.jpg");
  eq(seed.product?.publicUrl, "https://shop.example/oak-lamp");
  eq(seed.product?.asPrimary, true);
  eq(seed.setup.productImages[0], "https://img.example/p.jpg");
  eq(seed.setup.directionBrief, "A warm lamp on a walnut desk.");
  // No account named by this source: carrying none is correct, guessing one is not.
  eq(seed.destination, null);
});

test("a viral-pin prefill seeds the reference and still produces a brief", () => {
  const prefill: CreatePinsPrefill = {
    source: "viral_pins",
    opportunity: { title: "cozy reading nook", keyword: "cozy reading nook" },
    pinReferences: [{ id: "vp-3", imageUrl: "https://img.example/v.jpg", source: "viral_pins" }],
  };
  const seed = prefillToDrawerSeed(prefill)!;
  eq(seed.setup.referenceSelections?.[0]?.id, "vp-3");
  ok(seed.setup.directionBrief.length > 0, "a keyword-only prefill must still carry a brief");
});

test("an empty prefill opens nothing", () => {
  eq(prefillToDrawerSeed({ source: "manual" }), null);
  eq(prefillToDrawerSeed(null), null);
});

console.log("\nKey consumption");

test("a saved key loads once, then is gone", () => {
  const key = savePrefill(INSIGHT_PREFILL);
  ok(!!prefillToDrawerSeed(loadPrefill(key)), "first read should seed the drawer");
  eq(loadPrefill(key), null, "a consumed key must not seed a second time");
  eq(prefillToDrawerSeed(loadPrefill(key)), null);
});

test("a missing or foreign key yields null", () => {
  eq(loadPrefill("vbp_cp_never_written"), null);
  eq(loadPrefill("not-our-prefix"), null);
  eq(prefillToDrawerSeed(loadPrefill("vbp_cp_never_written")), null);
});

console.log("\nDestination -> draft patch (what makes the Pin publish to the right account)");

test("the patch names the account and the board", () => {
  const patch = destinationDraftPatch({
    socialConnectionId: "conn-B", boardId: "board-9", boardName: "Home Office",
  });
  eq(patch?.targetConnectionId, "conn-B");
  eq(patch?.boardId, "board-9");
  eq(patch?.boardName, "Home Office");
});

test("no destination yields no patch, so nothing overwrites a real target", () => {
  eq(destinationDraftPatch(null), null);
  eq(destinationDraftPatch(undefined), null);
  eq(destinationDraftPatch({ socialConnectionId: "" }), null);
});

test("an account without a board still targets the account", () => {
  const patch = destinationDraftPatch({ socialConnectionId: "conn-B" });
  eq(patch?.targetConnectionId, "conn-B");
  eq("boardId" in (patch ?? {}), false, "absent board must stay absent, not empty");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
