/**
 * T4 — bulk "Generate copy" orchestration (lib/studio/bulkGenerateCopy.ts, design §4).
 *
 *  - independent success/failure: 10 cards, 3 fail → only those 3 keep their text
 *  - touched fields are never overwritten (AI-E03 overwrite count = 0) unless the
 *    explicit replace option is on
 *  - in-flight peak ≤ 2
 *  - 402 on card 4 → nothing new is sent; the rest are not_started (not failed)
 *  - quota preflight is soft; the server's 402 wins when the preflight said "enough"
 *  - 429 pauses for Retry-After and resumes once; a second 429 stops
 *  - cancel stops sending; generation never writes schedule/publish fields
 *
 * Run: npx tsx scripts/test-bulk-generate-copy.ts
 */
import assert from "node:assert/strict";
import {
  mergeGeneratedCopy,
  preflightBulkCopy,
  quotaPreflight,
  runBulkGenerateCopy,
  failedIds,
  type BulkCopyCard,
  type BulkCopyErrorKind,
  type GeneratedCopy,
} from "../src/lib/studio/bulkGenerateCopy";

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

class FakeHttpError extends Error { constructor(readonly status: number, readonly retryAfterSeconds: number | null = null) { super(`HTTP ${status}`); } }
const classify = (error: unknown): BulkCopyErrorKind => {
  if (error instanceof FakeHttpError && error.status === 402) return { kind: "text_limit" };
  if (error instanceof FakeHttpError && error.status === 429) return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
  return { kind: "failed", message: (error as Error).message };
};

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gen = (id: string): GeneratedCopy => ({ title: `AI title ${id}`, description: `AI description ${id}`, altText: `AI alt ${id}` });

/** In-memory "store" the apply step reads FRESH, like the real Studio store. */
function makeStore(cards: BulkCopyCard[]) {
  const rows = new Map(cards.map(card => [card.id, { ...card, touched: { ...card.touched } }]));
  const writes: Array<{ id: string; keys: string[] }> = [];
  return {
    rows,
    writes,
    apply(id: string, generated: GeneratedCopy, replaceTouched = false) {
      const row = rows.get(id)!;
      const merged = mergeGeneratedCopy(row, generated, { replaceTouched });
      writes.push({ id, keys: Object.keys(merged.patch) });
      rows.set(id, { ...row, ...merged.patch });
      return merged;
    },
  };
}

function cards(n: number, extra: (i: number) => Partial<BulkCopyCard> = () => ({})): BulkCopyCard[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, title: "", description: "", altText: "", ...extra(i + 1) }));
}

async function main() {
  console.log("\n[independent success / failure]");
  await test("10 cards, 3 fail → exactly those 3 keep their original text; the other 7 are written", async () => {
    const list = cards(10, i => ({ title: `orig ${i}`, description: `orig desc ${i}` }));
    const store = makeStore(list);
    const failing = new Set(["c2", "c5", "c9"]);
    const summary = await runBulkGenerateCopy({
      cards: list,
      generate: async card => { await tick(); if (failing.has(card.id)) throw new Error(`boom ${card.id}`); return gen(card.id); },
      apply: (id, g) => store.apply(id, g),
      classifyError: classify,
      sleep: async () => {},
    });
    assert.equal(summary.succeeded, 7);
    assert.equal(summary.failed, 3);
    assert.deepEqual(failedIds(summary).sort(), ["c2", "c5", "c9"]);
    for (const card of list) {
      const row = store.rows.get(card.id)!;
      if (failing.has(card.id)) {
        assert.equal(row.title, card.title); assert.equal(row.description, card.description);
      } else {
        assert.equal(row.title, `AI title ${card.id}`);
      }
    }
    assert.ok(summary.items.filter(i => i.status === "failed").every(i => i.reason?.startsWith("boom")));
    assert.equal(store.writes.length, 7, "no write for a failed card");
  });

  console.log("\n[touched fields]");
  await test("touched non-empty fields are never overwritten (overwrite count 0); untouched / empty ones are", async () => {
    const list = cards(6, i => ({
      title: `mine ${i}`, description: i % 2 ? `my desc ${i}` : "", altText: "file-name.jpg",
      touched: { titleTouched: true, descriptionTouched: i % 2 === 1, altTextTouched: false },
    }));
    const store = makeStore(list);
    const summary = await runBulkGenerateCopy({
      cards: list, generate: async card => gen(card.id), apply: (id, g) => store.apply(id, g), classifyError: classify, sleep: async () => {},
    });
    let touchedOverwrites = 0;
    for (const card of list) {
      const row = store.rows.get(card.id)!;
      if (row.title !== card.title) touchedOverwrites++;
      if (card.touched?.descriptionTouched && row.description !== card.description) touchedOverwrites++;
      assert.equal(row.altText, `AI alt ${card.id}`, "untouched non-empty alt text (e.g. a file name) is AI-filled");
      if (!card.touched?.descriptionTouched) assert.equal(row.description, `AI description ${card.id}`, "empty field filled");
    }
    assert.equal(touchedOverwrites, 0, "AI-E03: zero overwrites of touched fields");
    assert.equal(summary.keptByField.title, 6);
    assert.equal(summary.keptByField.description, 3);
    assert.equal(summary.keptByField.altText, 0);
  });
  await test("a touched but EMPTY field is filled (only the user's text is protected)", () => {
    const r = mergeGeneratedCopy({ title: "  ", description: "x", altText: "", touched: { titleTouched: true, descriptionTouched: true } }, gen("a"));
    assert.deepEqual(r.written.sort(), ["altText", "title"]);
    assert.deepEqual(r.kept, ["description"]);
  });
  await test("replace option ON is the only way a touched field is overwritten", async () => {
    const list = cards(3, () => ({ title: "mine", description: "mine too", altText: "mine alt", touched: { titleTouched: true, descriptionTouched: true, altTextTouched: true } }));
    const pre = preflightBulkCopy(list);
    assert.equal(pre.ready.length, 0, "without replace, fully-edited cards are not even sent");
    assert.equal(pre.alreadyCopyComplete.length, 3);
    const preReplace = preflightBulkCopy(list, { replaceTouched: true });
    assert.equal(preReplace.ready.length, 3);
    const store = makeStore(list);
    await runBulkGenerateCopy({ cards: preReplace.ready, generate: async c => gen(c.id), apply: (id, g) => store.apply(id, g, true), classifyError: classify, sleep: async () => {} });
    assert.equal(store.rows.get("c1")!.title, "AI title c1");
  });
  await test("fresh read at apply time: a field the user edits DURING the request is kept", async () => {
    const list = cards(1, () => ({ title: "old filename" }));
    const store = makeStore(list);
    await runBulkGenerateCopy({
      cards: list,
      generate: async card => {
        // user types into the card while the request is in flight
        store.rows.set(card.id, { ...store.rows.get(card.id)!, title: "typed meanwhile", touched: { titleTouched: true } });
        return gen(card.id);
      },
      apply: (id, g) => store.apply(id, g), classifyError: classify, sleep: async () => {},
    });
    assert.equal(store.rows.get("c1")!.title, "typed meanwhile");
  });

  console.log("\n[concurrency]");
  await test("in-flight peak is ≤ 2 (and actually reaches 2)", async () => {
    let inFlight = 0, peak = 0;
    const list = cards(9);
    const store = makeStore(list);
    await runBulkGenerateCopy({
      cards: list,
      generate: async card => { inFlight++; peak = Math.max(peak, inFlight); await tick(); await tick(); inFlight--; return gen(card.id); },
      apply: (id, g) => store.apply(id, g), classifyError: classify, sleep: async () => {},
    });
    assert.equal(peak, 2);
  });
  await test("a caller asking for concurrency 8 is still capped at 2", async () => {
    let inFlight = 0, peak = 0;
    const list = cards(8);
    await runBulkGenerateCopy({
      cards: list, concurrency: 8,
      generate: async card => { inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return gen(card.id); },
      apply: () => ({ written: [], kept: [] }), classifyError: classify, sleep: async () => {},
    });
    assert.ok(peak <= 2, `peak ${peak}`);
  });

  console.log("\n[402 / quota]");
  await test("402 on card 4 → no request after it; later cards not_started, not failed", async () => {
    const list = cards(10);
    const store = makeStore(list);
    const calls: string[] = [];
    let limitSeen = false; let callsAfterLimit = 0;
    const summary = await runBulkGenerateCopy({
      cards: list,
      generate: async card => {
        if (limitSeen) callsAfterLimit++;
        calls.push(card.id);
        await tick();
        if (card.id === "c4") { limitSeen = true; throw new FakeHttpError(402); }
        return gen(card.id);
      },
      apply: (id, g) => store.apply(id, g), classifyError: classify, sleep: async () => {},
    });
    assert.equal(callsAfterLimit, 0, "no request starts after the 402");
    assert.equal(summary.stoppedBy, "text_limit");
    assert.equal(summary.failed, 0, "402 is not a failure");
    const byId = new Map(summary.items.map(i => [i.id, i]));
    assert.equal(byId.get("c4")!.status, "not_started");
    for (const id of ["c6", "c7", "c8", "c9", "c10"]) {
      assert.equal(byId.get(id)!.status, "not_started", id);
      assert.ok(!calls.includes(id), `${id} never requested`);
    }
    assert.ok(calls.length <= 5, `only the in-flight sibling may complete (calls: ${calls.join(",")})`);
  });
  await test("quota preflight: short → 'only N', enough / unlimited / unknown", () => {
    assert.deepEqual(quotaPreflight({ used: 48, limit: 50 }, 5), { kind: "short", needed: 5, remaining: 2 });
    assert.deepEqual(quotaPreflight({ used: 10, limit: 50 }, 5), { kind: "enough", needed: 5, remaining: 40 });
    assert.deepEqual(quotaPreflight({ used: 60, limit: 50 }, 3), { kind: "short", needed: 3, remaining: 0 });
    assert.equal(quotaPreflight({ used: 10, limit: null }, 5).kind, "unlimited");
    assert.equal(quotaPreflight(null, 5).kind, "unknown");
  });
  await test("preflight said 'enough' but the server returns 402 → the server wins (batch stops)", async () => {
    const pre = quotaPreflight({ used: 0, limit: 100 }, 4);
    assert.equal(pre.kind, "enough");
    const list = cards(4);
    const summary = await runBulkGenerateCopy({
      cards: list, concurrency: 1,
      generate: async card => { if (card.id === "c2") throw new FakeHttpError(402); return gen(card.id); },
      apply: () => ({ written: ["title"], kept: [] }), classifyError: classify, sleep: async () => {},
    });
    assert.equal(summary.stoppedBy, "text_limit");
    assert.deepEqual(summary.items.map(i => i.status), ["succeeded", "not_started", "not_started", "not_started"]);
  });

  console.log("\n[429]");
  await test("429 pauses for Retry-After, resumes once and finishes", async () => {
    const list = cards(4);
    const slept: number[] = [];
    let hit = false;
    const summary = await runBulkGenerateCopy({
      cards: list, concurrency: 1,
      generate: async card => { if (card.id === "c2" && !hit) { hit = true; throw new FakeHttpError(429, 7); } return gen(card.id); },
      apply: () => ({ written: ["title"], kept: [] }), classifyError: classify,
      sleep: async ms => { slept.push(ms); },
    });
    assert.deepEqual(slept, [7000]);
    assert.equal(summary.succeeded, 4);
    assert.equal(summary.resumedAfterRateLimit, true);
    assert.equal(summary.stoppedBy, null);
  });
  await test("second 429 stops: the card and the rest are not_started", async () => {
    const list = cards(5);
    let n = 0;
    const summary = await runBulkGenerateCopy({
      cards: list, concurrency: 1,
      generate: async card => { if (card.id === "c2" || card.id === "c3") { n++; if (n <= 2) throw new FakeHttpError(429, 1); } return gen(card.id); },
      apply: () => ({ written: ["title"], kept: [] }), classifyError: classify, sleep: async () => {},
    });
    assert.equal(summary.stoppedBy, "rate_limited");
    assert.deepEqual(summary.items.map(i => i.status), ["succeeded", "not_started", "not_started", "not_started", "not_started"]);
  });

  console.log("\n[cancel / preflight / state]");
  await test("cancel: nothing new is sent; unsent cards are not_started", async () => {
    const list = cards(6);
    let cancel = false; const calls: string[] = [];
    const summary = await runBulkGenerateCopy({
      cards: list, concurrency: 1,
      generate: async card => { calls.push(card.id); if (card.id === "c2") cancel = true; return gen(card.id); },
      apply: () => ({ written: ["title"], kept: [] }), classifyError: classify, isCancelled: () => cancel, sleep: async () => {},
    });
    assert.deepEqual(calls, ["c1", "c2"]);
    assert.equal(summary.stoppedBy, "cancelled");
    assert.equal(summary.notStarted, 4);
  });
  await test("preflight: Amazon card without product name and busy cards are never sent", () => {
    const pre = preflightBulkCopy([
      { id: "a", title: "", description: "", altText: "", amazon: { canGenerate: false } },
      { id: "b", title: "", description: "", altText: "", amazon: { canGenerate: true } },
      { id: "c", title: "", description: "", altText: "", busy: true },
      { id: "d", title: "", description: "", altText: "" },
    ]);
    assert.deepEqual(pre.needsProductName.map(c => c.id), ["a"]);
    assert.deepEqual(pre.generating.map(c => c.id), ["c"]);
    assert.deepEqual(pre.ready.map(c => c.id), ["b", "d"]);
  });
  await test("generation writes copy fields only — never schedule / publish state", async () => {
    const list = cards(3);
    const store = makeStore(list);
    await runBulkGenerateCopy({ cards: list, generate: async c => ({ ...gen(c.id), scheduledAt: "2026-10-01", publishNow: true } as unknown as GeneratedCopy), apply: (id, g) => store.apply(id, g), classifyError: classify, sleep: async () => {} });
    for (const w of store.writes) assert.ok(w.keys.every(k => ["title", "description", "altText"].includes(k)), w.keys.join(","));
  });

  console.log(`\nBulk generate copy: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
