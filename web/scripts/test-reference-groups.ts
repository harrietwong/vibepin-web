/**
 * Reference-group generation tests (create-pin PRD Sections G + G2).
 * Run: npx tsx scripts/test-reference-groups.ts
 *
 * Simulates StudioBoard's serial group queue against a fake /api/generate to prove:
 *   - N references produce N groups, each requesting pinsPerReference (never the total);
 *   - all totalPins placeholders exist before the first group returns;
 *   - every placeholder and result carries its group's reference association;
 *   - groups run serially (the per-user lock would 429 a concurrent second call);
 *   - one failing group does not stop the others.
 */

import assert from "node:assert";
import { planReferenceGroups, totalPins, type SelectedReference } from "../src/lib/studio/selectedReferences";

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

function ref(id: string): SelectedReference {
  return {
    id,
    imageUrl: `https://pin.example/${id}.jpg`,
    source: "recommended_pin",
    sourceUrl: `https://pinterest.com/pin/${id}`,
    role: "style_reference",
  };
}

type Placeholder = {
  id: string;
  referenceId?: string;
  referenceImageUrl?: string;
  referenceSource?: string;
  status: "generating" | "done" | "failed";
  imageUrl?: string;
};

type Call = { styleRef: string | null; count: number; startedAt: number; endedAt: number };

/**
 * Mirrors StudioBoard.handleAiGenerate's group loop. Kept in lockstep with that
 * function deliberately — this is the contract the UI must satisfy.
 */
async function runBatch(opts: {
  references: SelectedReference[];
  pinsPerReference: number;
  generate: (styleRef: string | null, count: number) => Promise<string[]>;
}) {
  const groups = planReferenceGroups(opts.references, opts.pinsPerReference);
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  // All placeholders up front, each already tagged with its group's reference.
  const groupPlaceholders: Placeholder[][] = groups.map(g =>
    Array.from({ length: g.requestCount }, (_, i) => ({
      id: `gen:${g.index}:${i}`,
      referenceId: g.reference?.id,
      referenceImageUrl: g.reference?.imageUrl,
      referenceSource: g.reference?.source,
      status: "generating" as const,
    })),
  );
  const placeholdersAtStart = groupPlaceholders.flat().length;

  for (const g of groups) {
    const ph = groupPlaceholders[g.index];
    const styleRef = g.reference?.imageUrl ?? null;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const startedAt = Date.now();
    try {
      const urls = await opts.generate(styleRef, g.requestCount);
      urls.slice(0, ph.length).forEach((url, i) => { ph[i].status = "done"; ph[i].imageUrl = url; });
      ph.slice(urls.length).forEach(p => { p.status = "failed"; });
    } catch {
      ph.forEach(p => { p.status = "failed"; });
    } finally {
      inFlight--;
      calls.push({ styleRef, count: g.requestCount, startedAt, endedAt: Date.now() });
    }
  }
  return { groups, calls, maxInFlight, placeholdersAtStart, placeholders: groupPlaceholders.flat() };
}

function okGenerator(urlsPerCall = (n: number) => n) {
  return async (styleRef: string | null, count: number) => {
    await new Promise(r => setTimeout(r, 5));
    return Array.from({ length: urlsPerCall(count) }, (_, i) => `${styleRef ?? "noref"}#out${i}`);
  };
}

async function main() {
  // ── Section G: group count and per-group request count ────────────────────

  await test("3 references × 3 each → 3 calls of 3, totalling 9", async () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    const r = await runBatch({ references: refs, pinsPerReference: 3, generate: okGenerator() });
    assert.equal(r.calls.length, 3, "one /api/generate call per reference");
    for (const c of r.calls) assert.equal(c.count, 3, "each call requests pinsPerReference, not 9");
    assert.equal(r.placeholders.length, 9);
    assert.equal(r.placeholders.length, totalPins(3, 3));
    assert.equal(r.placeholders.filter(p => p.status === "done").length, 9);
  });

  await test("2 references × 3 each → 6 Pins", async () => {
    const r = await runBatch({ references: [ref("a"), ref("b")], pinsPerReference: 3, generate: okGenerator() });
    assert.equal(r.calls.length, 2);
    assert.equal(r.placeholders.length, 6);
  });

  await test("1 reference × 3 each → 3 Pins, one call", async () => {
    const r = await runBatch({ references: [ref("a")], pinsPerReference: 3, generate: okGenerator() });
    assert.equal(r.calls.length, 1);
    assert.equal(r.placeholders.length, 3);
  });

  await test("0 references × 3 → one product/prompt-only group of 3, style_ref null", async () => {
    const r = await runBatch({ references: [], pinsPerReference: 3, generate: okGenerator() });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].styleRef, null, "no reference → no style_ref");
    assert.equal(r.placeholders.length, 3);
    assert.equal(r.placeholders.filter(p => p.referenceId).length, 0);
  });

  await test("each group sends ITS OWN reference as style_ref", async () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    const r = await runBatch({ references: refs, pinsPerReference: 1, generate: okGenerator() });
    assert.deepEqual(r.calls.map(c => c.styleRef), [
      "https://pin.example/a.jpg",
      "https://pin.example/b.jpg",
      "https://pin.example/c.jpg",
    ]);
  });

  // ── Section G: placeholders up front + serial execution ───────────────────

  await test("all totalPins placeholders exist before the first group returns", async () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    const r = await runBatch({ references: refs, pinsPerReference: 3, generate: okGenerator() });
    assert.equal(r.placeholdersAtStart, 9, "batch size visible immediately, not group by group");
  });

  await test("groups run serially — never two calls in flight (avoids the 429 lock)", async () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    const r = await runBatch({ references: refs, pinsPerReference: 2, generate: okGenerator() });
    assert.equal(r.maxInFlight, 1, "concurrent calls would hit user_generation_limit");
    for (let i = 1; i < r.calls.length; i++) {
      assert.ok(r.calls[i].startedAt >= r.calls[i - 1].endedAt, `call ${i} must start after call ${i - 1} ends`);
    }
  });

  // ── Section G2: association + failure isolation ───────────────────────────

  await test("every placeholder carries its group's reference association", async () => {
    const refs = [ref("a"), ref("b")];
    const r = await runBatch({ references: refs, pinsPerReference: 2, generate: okGenerator() });
    const forA = r.placeholders.filter(p => p.referenceId === "a");
    const forB = r.placeholders.filter(p => p.referenceId === "b");
    assert.equal(forA.length, 2);
    assert.equal(forB.length, 2);
    for (const p of forA) {
      assert.equal(p.referenceImageUrl, "https://pin.example/a.jpg");
      assert.equal(p.referenceSource, "recommended_pin");
    }
  });

  await test("results are not assigned to references after the fact", async () => {
    const refs = [ref("a"), ref("b")];
    const r = await runBatch({ references: refs, pinsPerReference: 1, generate: okGenerator() });
    // Each produced URL is derived from the style_ref its own group sent.
    for (const p of r.placeholders) {
      assert.ok(p.imageUrl?.startsWith(p.referenceImageUrl!), "result must come from its own group's request");
    }
  });

  await test("one failing group does not affect the others", async () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    const generate = async (styleRef: string | null, count: number) => {
      if (styleRef?.includes("/b.jpg")) throw new Error("group failed");
      return Array.from({ length: count }, (_, i) => `${styleRef}#out${i}`);
    };
    const r = await runBatch({ references: refs, pinsPerReference: 2, generate });
    assert.equal(r.calls.length, 3, "a failure must not abort the queue");
    assert.equal(r.placeholders.filter(p => p.referenceId === "a" && p.status === "done").length, 2);
    assert.equal(r.placeholders.filter(p => p.referenceId === "b" && p.status === "failed").length, 2);
    assert.equal(r.placeholders.filter(p => p.referenceId === "c" && p.status === "done").length, 2);
  });

  await test("a short group result fails only its own unfilled placeholders", async () => {
    const refs = [ref("a"), ref("b")];
    // Group A returns 1 of 2 requested; group B is healthy.
    const generate = async (styleRef: string | null, count: number) => {
      const n = styleRef?.includes("/a.jpg") ? 1 : count;
      return Array.from({ length: n }, (_, i) => `${styleRef}#out${i}`);
    };
    const r = await runBatch({ references: refs, pinsPerReference: 2, generate });
    assert.equal(r.placeholders.filter(p => p.referenceId === "a" && p.status === "done").length, 1);
    assert.equal(r.placeholders.filter(p => p.referenceId === "a" && p.status === "failed").length, 1);
    assert.equal(r.placeholders.filter(p => p.referenceId === "b" && p.status === "done").length, 2);
    assert.equal(r.placeholders.length, 4, "placeholder total still equals totalPins");
  });

  console.log(`\nReference groups: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
