import assert from "node:assert";

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
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n     ${(error as Error).stack}`); }
}

async function main() {
  const state = await import("../src/lib/studio/generationAttemptState");
  const store = await import("../src/lib/studio/generationSetupStore");
  const ownerA = { ownerUserId: "owner-a", workspaceId: "workspace" };
  const ownerB = { ownerUserId: "owner-b", workspaceId: "workspace" };
  const setup = {
    productImages: ["https://assets.example/product.jpg"],
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

  await test("commit-before-placeholders persists full setup and attempt in one write", () => {
    memory.clear(); writes.length = 0;
    const order: string[] = [];
    const prepared = store.prepareGenerationAttempt({
      scope: ownerA,
      setupKey: "scratch",
      setup,
      attemptId: "attempt-1",
      expectedCount: 8,
    });
    if (writes.length === 1) order.push("persist");
    order.push("placeholders");
    assert.ok(prepared);
    assert.deepEqual(order, ["persist", "placeholders"]);
    assert.equal(prepared?.expectedCount, 8);
    assert.deepEqual(store.loadGenerationSetup(ownerA, "scratch")?.setup, setup);
    assert.equal(store.loadGenerationSetup(ownerA, "scratch")?.setup.referenceSelections?.[0]?.sourceUrl, "https://pinterest.example/a");
  });

  await test("same owner restores references, provenance, direction, model, format and count", () => {
    const restored = store.loadGenerationSetup(ownerA, "scratch")?.setup;
    assert.ok(restored);
    assert.equal(restored?.count, 4);
    assert.equal(restored?.modelKey, "gemini_image");
    assert.equal(restored?.format, "Pinterest 2:3");
    assert.equal(restored?.selectedDirectionId, "direction-a");
    assert.deepEqual(restored?.referenceSelections, setup.referenceSelections);
  });

  await test("A → B → A setup and active attempt remain isolated", () => {
    assert.equal(store.loadGenerationSetup(ownerB, "scratch"), null);
    assert.equal(store.getBlockingGenerationAttempt(ownerB), null);
    const bSetup = { ...setup, directionBrief: "B only", referenceSelections: [] };
    store.prepareGenerationAttempt({ scope: ownerB, setupKey: "scratch", setup: bSetup, attemptId: "attempt-b", expectedCount: 4 });
    assert.equal(store.loadGenerationSetup(ownerB, "scratch")?.setup.directionBrief, "B only");
    assert.equal(store.loadGenerationSetup(ownerA, "scratch")?.setup.directionBrief, setup.directionBrief);
    assert.equal(store.getBlockingGenerationAttempt(ownerA)?.attemptId, "attempt-1");
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
    assert.deepEqual(new Set(commands.map(command => command.id)).size, 1);
    assert.deepEqual(commands.map(command => command.kind), ["loading", "loading", "info", "success"]);
    assert.ok(commands.slice(0, 3).every(command => command.kind !== "success"));
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
