/**
 * Behavioural tests for the REAL generation run (lib/studio/runAiGeneration.ts).
 * Run: npx tsx scripts/test-ai-generation-run.ts
 *
 * These drive the shipped function with a real pinDraftStore and a fake generate(),
 * then assert what the STORE actually contains. No hand-written "expected patch" —
 * the previous test did that and consequently could not detect a retry path that
 * disabled Generate or a cache key that never matched.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon-key";

import assert from "node:assert";

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
  const { runAiGeneration } = await import("../src/lib/studio/runAiGeneration");
  const reset = () => { mem.clear(); store.__resetMemoryCacheForTests(); };

  const baseOpts = {
    prompt: "p", hiddenPrompt: "hp", productImages: [] as string[],
    referenceImages: [] as string[], selectedReferences: [],
    count: 1, format: "Pinterest 2:3", modelKey: "gemini_image",
    variationMode: "distinct", outputVariants: [], category: "home",
    selectedTags: [], directionBrief: "brief", briefManuallyEdited: false,
    creativeDirectionMeta: {}, productMetadata: [],
    primaryProductSelection: null,
  } as never;

  const deps = (generate: (a: { styleReference: string | null }) => Promise<{ urls: string[] }>) => ({
    store: store as never,
    generate: generate as never,
    resolveModelLabel: () => "Gemini",
    now: () => 1, randomId: () => "test",
  });

  const ref = (id: string) => ({
    id, imageUrl: `https://cdn/${id}.jpg`, source: "recommended_pin" as const,
    role: "style_reference" as const,
  });

  // ── Serial groups, association, counts (must not regress) ─────────────────

  await test("3 references x 2 = 6 Pins, one serial call per reference", async () => {
    reset();
    const calls: (string | null)[] = [];
    let inFlight = 0, maxInFlight = 0;
    const r = await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 2, selectedReferences: [ref("a"), ref("b"), ref("c")] } },
      deps(async ({ styleReference }) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(styleReference);
        await new Promise(res => setTimeout(res, 3));
        inFlight--;
        return { urls: ["u1", "u2"] };
      }),
    );
    assert.equal(r.totalPins, 6);
    assert.equal(calls.length, 3, "one call per reference");
    assert.equal(maxInFlight, 1, "serial — a concurrent 2nd call would 429");
    assert.deepEqual(calls, ["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/c.jpg"]);
    assert.equal(r.okCount, 6);
  });

  await test("every generated draft persists its own group's reference", async () => {
    reset();
    await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 1, selectedReferences: [ref("a"), ref("b")] } },
      deps(async ({ styleReference }) => ({ urls: [`${styleReference}#out`] })),
    );
    const all = store.getAllDrafts().filter(d => d.generationSessionId?.startsWith("board_"));
    assert.equal(all.length, 2);
    const forA = all.find(d => d.referenceId === "a");
    const forB = all.find(d => d.referenceId === "b");
    assert.ok(forA && forB, "both group references persisted");
    assert.equal(forA!.referenceImageUrl, "https://cdn/a.jpg");
    assert.equal(forA!.referenceSource, "recommended_pin");
  });

  await test("one failing group does not stop the others", async () => {
    reset();
    const r = await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 1, selectedReferences: [ref("a"), ref("b"), ref("c")] } },
      deps(async ({ styleReference }) => {
        if (styleReference?.includes("/b.jpg")) throw new Error("group failed");
        return { urls: ["ok"] };
      }),
    );
    assert.equal(r.okCount, 2);
    assert.equal(r.failCount, 1);
  });

  // ── Product link: chosen vs inherited vs none (Codex #1/#4) ───────────────

  await test("a chosen product links onto EVERY draft with product provenance", async () => {
    reset();
    const chosen = {
      id: "B", title: "Product B", source: "shopify", imageUrl: "https://cdn/B.jpg",
      canonicalUrl: "https://shop.example/products/b",
    };
    await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 2, primaryProductSelection: chosen } },
      deps(async () => ({ urls: ["u1", "u2"] })),
    );
    const all = store.getAllDrafts().filter(d => d.generationSessionId?.startsWith("board_"));
    assert.equal(all.length, 2);
    for (const d of all) {
      assert.equal(d.primaryProductId, "B");
      assert.equal(d.destinationUrl, "https://shop.example/products/b");
      assert.equal(d.destinationUrlSource, "product", "provenance required or it is later treated as manual");
    }
  });

  await test("no chosen product + parent HAS products → parent state inherited verbatim", async () => {
    reset();
    const parent = store.createBoardDraft({ imageUrl: "https://cdn/parent.jpg", source: "uploaded_image" });
    store.updateDraft(parent.id, {
      linkedProducts: [
        { productId: "P", title: "Primary", source: "shopify", linkType: "manual", productUrl: "https://shop/p" },
        { productId: "T", title: "Tagged", source: "shopify", linkType: "manual" },
      ],
      primaryProductId: "P",
      destinationUrl: "https://hand-edited.example/x",
      destinationUrlSource: "manual",
    });
    const freshParent = store.getDraft(parent.id)!;
    await runAiGeneration(
      { parent: freshParent, opts: { ...baseOpts, count: 1, primaryProductSelection: null } },
      deps(async () => ({ urls: ["u1"] })),
    );
    const gen = store.getAllDrafts().find(d => d.parentDraftId === parent.id)!;
    assert.equal(gen.primaryProductId, "P", "parent's own primaryProductId");
    assert.equal(gen.linkedProducts?.length, 2, "TAGGED products preserved");
    assert.equal(gen.destinationUrl, "https://hand-edited.example/x", "hand-edited URL not re-derived");
    assert.equal(gen.destinationUrlSource, "manual", "…and stays manual");
  });

  await test("no product anywhere → no fabricated product link", async () => {
    reset();
    await runAiGeneration({ parent: null, opts: { ...baseOpts, count: 1 } }, deps(async () => ({ urls: ["u"] })));
    const gen = store.getAllDrafts().find(d => d.generationSessionId?.startsWith("board_"))!;
    assert.equal(gen.linkedProducts, undefined);
    assert.equal(gen.destinationUrl ?? "", "");
  });

  await test("provider EXTRA results carry the product AND the group reference", async () => {
    reset();
    const chosen = { id: "B", title: "B", source: "shopify", imageUrl: "https://cdn/B.jpg", canonicalUrl: "https://shop.example/products/b" };
    await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 1, selectedReferences: [ref("a")], primaryProductSelection: chosen } },
      deps(async () => ({ urls: ["u1", "extra1"] })), // 2 returned, 1 requested
    );
    const all = store.getAllDrafts().filter(d => d.generationSessionId?.startsWith("board_"));
    assert.equal(all.length, 2, "the extra became its own card");
    for (const d of all) {
      assert.equal(d.primaryProductId, "B", "an extra must not lose the product");
      assert.equal(d.referenceId, "a", "…nor its group reference");
    }
  });

  // ── Placeholders exist up front ──────────────────────────────────────────

  await test("all placeholders exist BEFORE the first group returns", async () => {
    reset();
    let seenAtFirstCall = 0;
    await runAiGeneration(
      { parent: null, opts: { ...baseOpts, count: 3, selectedReferences: [ref("a"), ref("b")] } },
      deps(async () => {
        if (!seenAtFirstCall) {
          seenAtFirstCall = store.getAllDrafts().filter(d => d.generationStatus === "generating").length;
        }
        return { urls: ["u1", "u2", "u3"] };
      }),
    );
    assert.equal(seenAtFirstCall, 6, "batch size visible immediately, not group by group");
  });

  console.log(`\nAI generation run: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
