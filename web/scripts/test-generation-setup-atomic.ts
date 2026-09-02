/**
 * Runtime contract tests for the generation attempt seam.
 *
 * The creative drawer is restored by creativeSetupStore. This store has one
 * deliberately narrow job: persist the immutable, effective setup snapshot
 * attached to the active generation attempt, before placeholders/POSTs exist.
 * Run from web/: npx tsx scripts/test-generation-setup-atomic.ts
 */
import assert from "node:assert/strict";

const memory = new Map<string, string>();
const writes: string[] = [];
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { writes.push(key); memory.set(key, String(value)); },
  removeItem: key => { memory.delete(key); },
  clear: () => { memory.clear(); },
  key: index => Array.from(memory.keys())[index] ?? null,
  get length() { return memory.size; },
};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n     ${(error as Error).stack}`); }
}

async function main(): Promise<void> {
  const state = await import("../src/lib/studio/generationAttemptState");
  const store = await import("../src/lib/studio/generationSetupStore");
  const ownerA = { ownerUserId: "owner-a", workspaceId: "workspace-a" };
  const ownerB = { ownerUserId: "owner-b", workspaceId: "workspace-a" };
  const ownerAOtherWorkspace = { ownerUserId: "owner-a", workspaceId: "workspace-b" };
  const setup = {
    productImages: ["https://assets.example/product.jpg"],
    productSelections: [{
      id: "product-1", title: "Product", source: "shopify" as const,
      imageUrl: "https://assets.example/product.jpg",
      publicUrl: "https://shop.example/products/1",
      selectionOrigin: "explicit_picker" as const, asPrimary: true,
    }],
    referenceImages: ["https://assets.example/ref-a.jpg", "https://assets.example/ref-b.jpg"],
    referenceSelections: [
      { id: "ref-a", imageUrl: "https://assets.example/ref-a.jpg", source: "recommended_pin" as const, sourceUrl: "https://pinterest.example/a", reason: "palette", patternTags: { palette: ["warm"] }, role: "style_reference" as const },
      { id: "ref-b", imageUrl: "https://assets.example/ref-b.jpg", source: "upload" as const, role: "style_reference" as const },
    ],
    count: 4,
    format: "Pinterest 2:3",
    modelKey: "gemini_image",
    variationMode: "distinct" as const,
    selectedDirectionId: "direction-a",
    selectedTagIds: ["editorial"],
    directionBrief: "A private visible brief",
    briefManuallyEdited: true,
  };

  await test("prepare persists one complete effective snapshot before placeholders", () => {
    memory.clear(); writes.length = 0;
    const prepared = store.prepareGenerationAttempt({
      scope: ownerA, setupKey: "draft-1", setup, attemptId: "attempt-1", expectedCount: 8,
    });
    assert.ok(prepared);
    assert.equal(writes.length, 1, "the attempt is committed in one localStorage write");
    assert.equal(prepared?.expectedCount, 8);
    assert.deepEqual(store.getActiveGenerationAttempt(ownerA)?.effectiveSetup, setup);
    assert.equal(store.getActiveGenerationAttempt(ownerA)?.effectiveSetup.referenceSelections?.[0]?.sourceUrl, "https://pinterest.example/a");
  });

  await test("effective setup is deep-cloned and cannot be changed through caller objects", () => {
    setup.directionBrief = "mutated after Generate";
    setup.productSelections![0].title = "mutated product";
    setup.referenceSelections![0].patternTags!.palette![0] = "mutated";
    const snapshot = store.getActiveGenerationAttempt(ownerA)?.effectiveSetup;
    assert.equal(snapshot?.directionBrief, "A private visible brief");
    assert.equal(snapshot?.productSelections?.[0]?.title, "Product");
    assert.deepEqual(snapshot?.referenceSelections?.[0]?.patternTags, { palette: ["warm"] });
    // A returned object is also a deserialized copy, never the live store value.
    snapshot!.selectedTagIds.push("local-only-mutation");
    assert.deepEqual(store.getActiveGenerationAttempt(ownerA)?.effectiveSetup.selectedTagIds, ["editorial"]);
  });

  await test("owner and workspace scopes are both required for reads and writes", () => {
    assert.equal(store.getActiveGenerationAttempt(ownerB), null);
    assert.equal(store.getActiveGenerationAttempt(ownerAOtherWorkspace), null);
    assert.equal(store.prepareGenerationAttempt({ scope: { ownerUserId: "owner-a", workspaceId: " " }, setupKey: "x", setup, attemptId: "x", expectedCount: 1 }), null);
    assert.equal(store.prepareGenerationAttempt({ scope: ownerB, setupKey: "draft-1", setup, attemptId: "attempt-b", expectedCount: 1 })?.attemptId, "attempt-b");
    assert.equal(store.getActiveGenerationAttempt(ownerA)?.attemptId, "attempt-1");
    assert.equal(store.getActiveGenerationAttempt(ownerB)?.attemptId, "attempt-b");
  });

  await test("there is no general setup map or deleted load/save API", () => {
    const raw = Array.from(memory.entries()).find(([key]) => key.includes("generation_setup"))?.[1] ?? "";
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    assert.equal("setups" in parsed, false, "generation store must not persist a drawer setups map");
    assert.equal("loadGenerationSetup" in store, false);
    assert.equal("saveGenerationSetup" in store, false);
    assert.equal("clearGenerationSetup" in store, false);
  });

  await test("single-card Retry narrows one immutable batch snapshot to one reference × count 1", () => {
    const original = store.getActiveGenerationAttempt(ownerA)?.effectiveSetup;
    assert.ok(original);
    const retry = store.setupForSingleCardRetry(original!, [original!.referenceSelections![1]]);
    assert.equal(retry.count, 1);
    assert.deepEqual(retry.referenceImages, ["https://assets.example/ref-b.jpg"]);
    assert.equal(retry.referenceSelections?.[0]?.id, "ref-b");
    assert.equal(original?.count, 4, "retry must not mutate the original attempt snapshot");
    assert.equal(original?.referenceSelections?.length, 2, "retry must not expand or erase the original batch snapshot");
  });

  await test("unknown remains blocking; terminal state releases the action lock", () => {
    store.updateGenerationAttempt(ownerA, { attemptId: "attempt-1", state: "unknown", okCount: 0, failCount: 0, expectedCount: 8 });
    assert.equal(store.getBlockingGenerationAttempt(ownerA)?.state, "unknown");
    store.updateGenerationAttempt(ownerA, { attemptId: "attempt-1", state: "partial", okCount: 6, failCount: 2, expectedCount: 8 });
    assert.equal(store.getBlockingGenerationAttempt(ownerA), null);
    assert.equal(store.getActiveGenerationAttempt(ownerA)?.okCount, 6);
  });

  await test("one stable toast id changes kind without a second terminal toast", () => {
    const attemptId = "attempt-stable";
    const commands = [
      state.generationToastCommand({ attemptId, state: "persisting", okCount: 0, failCount: 0 }),
      state.generationToastCommand({ attemptId, state: "generating", okCount: 0, failCount: 0 }),
      state.generationToastCommand({ attemptId, state: "unknown", okCount: 0, failCount: 0 }),
      state.generationToastCommand({ attemptId, state: "completed", okCount: 8, failCount: 0 }),
    ];
    assert.equal(new Set(commands.map(command => command.id)).size, 1);
    assert.deepEqual(commands.map(command => command.kind), ["loading", "loading", "info", "success"]);
  });

  await test("draft summary keeps ambiguous recovery unknown and computes partial terminal", () => {
    assert.equal(state.summarizeGenerationDrafts("attempt-x", [
      { generationStatus: "generating", generationRecoveryPending: true },
      { generationStatus: "failed" },
    ]).state, "unknown");
    const terminal = state.summarizeGenerationDrafts("attempt-x", [
      { generationStatus: "completed" },
      { generationStatus: "failed" },
    ]);
    assert.deepEqual({ state: terminal.state, ok: terminal.okCount, fail: terminal.failCount }, { state: "partial", ok: 1, fail: 1 });
  });

  await test("lookup keys contain no prompt or URL material", () => {
    const keys = Array.from(memory.keys()).join("\n");
    assert.doesNotMatch(keys, /private visible brief|assets\.example|pinterest\.example/i);
  });

  console.log(`\ngeneration setup/attempt: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
