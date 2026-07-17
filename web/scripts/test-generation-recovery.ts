/**
 * WP3-P2 unit tests for src/lib/studio/generationRecovery.ts.
 * Run: npx tsx scripts/test-generation-recovery.ts   (from web/)
 *
 * Pure node — mocks localStorage/window (pinDraftStore) and global.fetch (job-status
 * API + auth session lookup never hits the network). Covers:
 *   - no generationJobId  → judged dead immediately (pre-P2 behavior preserved)
 *   - queued/running job  → card stays "generating" and a poll loop is registered
 *   - terminal done job   → resolved via generationSlot matching, not array order
 *   - terminal partial job (done+failed mixed) → each slot resolved independently
 *   - 404 response        → job's cards judged dead
 *   - network error       → retried once; second failure judges cards dead
 *   - two reconcile calls for the same live job → no duplicate poll loop (activePolls dedup)
 *   - slots created out of creation-order still match correctly via generationSlot
 */

import assert from "node:assert";

// Dummy env so importing the supabase browser client chain never throws.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

// Minimal window + localStorage shim so the localStorage-backed store runs in node.
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
  sessionStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};
// The supabase browser client (constructed lazily inside authHeaders()) registers a
// "visibilitychange" listener on window via its realtime/phoenix socket, whose handler
// reads `document.visibilityState`. Our window shim's dispatchEvent above fires ALL
// registered listeners (needed for pinDraftStore's own subscribe/emit), including that
// third-party one — so `document` must exist too, or that handler throws.
(globalThis as unknown as { document: unknown }).document = { visibilityState: "visible" };

type FetchCall = { url: string };
let calls: FetchCall[] = [];
let fetchImpl: (url: string) => Promise<Response> = async () => {
  throw new Error("fetchImpl not configured for this test");
};
(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  calls.push({ url });
  return fetchImpl(url);
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const recovery = await import("../src/lib/studio/generationRecovery");

  function reset() { mem.clear(); calls = []; store.__resetMemoryCacheForTests(); }

  function makePlaceholder(opts: { jobId?: string; slot?: number; idem: string }) {
    return store.createBoardDraft({
      imageUrl: "https://cdn/parent.jpg",
      source: "ai_generated_from_upload",
      idempotencyKey: opts.idem,
      generationStatus: "generating",
      generationJobId: opts.jobId,
      generationSlot: opts.slot,
    });
  }

  console.log("WP3-P2 generationRecovery: reconcileGeneratingDrafts()");

  await test("no generationJobId → judged dead immediately (pre-P2 behavior preserved)", async () => {
    reset();
    const d = makePlaceholder({ idem: "no-job" });
    await recovery.reconcileGeneratingDrafts();
    const reloaded = store.getDraft(d.id);
    assert.equal(reloaded?.generationStatus, "failed");
    assert.equal(calls.length, 0, "no jobId → no network call at all");
  });

  await test("queued/running job → card stays generating, poll loop registered", async () => {
    reset();
    const jobId = "job-running-1";
    const d = makePlaceholder({ jobId, slot: 0, idem: "running-0" });
    fetchImpl = async (url) => {
      assert.ok(url.includes(`/api/generation-jobs/${jobId}`), `unexpected url ${url}`);
      return jsonResponse({ status: "running", results: [{ slot: 0, status: "pending", imageUrl: null, error: null }] });
    };
    // Short interval/timeout so the resumed poll loop self-terminates quickly instead
    // of hanging the test process on the real 4s/15min production defaults.
    await recovery.reconcileGeneratingDrafts({ intervalMs: 5, timeoutMs: 30 });
    const reloaded = store.getDraft(d.id);
    assert.equal(reloaded?.generationStatus, "generating", "still generating — job is alive");
    const gen = await import("../src/lib/studio/generateAiVersions");
    assert.equal(gen.isPollingJob(jobId), true, "reconcile must register a poll loop for a live job");
    // Let the short-timeout poll loop finish so it doesn't leak into later tests.
    await new Promise(r => setTimeout(r, 60));
    assert.equal(gen.isPollingJob(jobId), false, "poll loop must have ended (timeout) and deregistered");
  });

  await test("terminal done job → resolved via generationSlot matching, not array order", async () => {
    reset();
    const jobId = "job-done-1";
    // Create slot 1's placeholder FIRST, slot 0's SECOND — array/creation order is
    // deliberately reversed vs slot order to prove matching uses generationSlot.
    const d1 = makePlaceholder({ jobId, slot: 1, idem: "done-slot1" });
    const d0 = makePlaceholder({ jobId, slot: 0, idem: "done-slot0" });
    fetchImpl = async () => jsonResponse({
      status: "done",
      results: [
        { slot: 0, status: "done", imageUrl: "https://cdn/result-0.jpg", error: null },
        { slot: 1, status: "done", imageUrl: "https://cdn/result-1.jpg", error: null },
      ],
    });
    await recovery.reconcileGeneratingDrafts();
    const r0 = store.getDraft(d0.id);
    const r1 = store.getDraft(d1.id);
    assert.equal(r0?.generationStatus, "completed");
    assert.equal(r0?.imageUrl, "https://cdn/result-0.jpg");
    assert.equal(r1?.generationStatus, "completed");
    assert.equal(r1?.imageUrl, "https://cdn/result-1.jpg");
  });

  await test("terminal partial job (done+failed mixed) → each slot resolved independently", async () => {
    reset();
    const jobId = "job-partial-1";
    const dOk = makePlaceholder({ jobId, slot: 0, idem: "partial-ok" });
    const dFail = makePlaceholder({ jobId, slot: 1, idem: "partial-fail" });
    fetchImpl = async () => jsonResponse({
      status: "partial",
      results: [
        { slot: 0, status: "done", imageUrl: "https://cdn/ok.jpg", error: null },
        { slot: 1, status: "failed", imageUrl: null, error: "provider timeout" },
      ],
    });
    await recovery.reconcileGeneratingDrafts();
    assert.equal(store.getDraft(dOk.id)?.generationStatus, "completed");
    assert.equal(store.getDraft(dFail.id)?.generationStatus, "failed");
  });

  await test("404 response → job's cards judged dead", async () => {
    reset();
    const jobId = "job-missing-1";
    const d = makePlaceholder({ jobId, slot: 0, idem: "missing-0" });
    fetchImpl = async () => jsonResponse({ error: "not_found" }, 404);
    await recovery.reconcileGeneratingDrafts();
    assert.equal(store.getDraft(d.id)?.generationStatus, "failed");
  });

  await test("network error → retried once; second failure judges cards dead", async () => {
    reset();
    const jobId = "job-network-err-1";
    const d = makePlaceholder({ jobId, slot: 0, idem: "neterr-0" });
    let attempt = 0;
    fetchImpl = async () => { attempt++; throw new Error("network down"); };
    await recovery.reconcileGeneratingDrafts();
    assert.equal(attempt, 2, `expected exactly 2 attempts (1 + 1 retry), got ${attempt}`);
    assert.equal(store.getDraft(d.id)?.generationStatus, "failed");
  });

  await test("network error then success on retry → job resolved normally, no premature kill", async () => {
    reset();
    const jobId = "job-network-recover-1";
    const d = makePlaceholder({ jobId, slot: 0, idem: "netrecover-0" });
    let attempt = 0;
    fetchImpl = async () => {
      attempt++;
      if (attempt === 1) throw new Error("network blip");
      return jsonResponse({ status: "done", results: [{ slot: 0, status: "done", imageUrl: "https://cdn/recovered.jpg", error: null }] });
    };
    await recovery.reconcileGeneratingDrafts();
    assert.equal(attempt, 2);
    assert.equal(store.getDraft(d.id)?.generationStatus, "completed");
    assert.equal(store.getDraft(d.id)?.imageUrl, "https://cdn/recovered.jpg");
  });

  await test("two reconcile calls for the same live job → no duplicate poll loop (activePolls dedup)", async () => {
    reset();
    const jobId = "job-dedup-1";
    makePlaceholder({ jobId, slot: 0, idem: "dedup-0" });
    let getCalls = 0;
    fetchImpl = async () => {
      getCalls++;
      return jsonResponse({ status: "running", results: [{ slot: 0, status: "pending", imageUrl: null, error: null }] });
    };
    // Fire both reconcile passes back-to-back, as could happen with a fast double-mount.
    // Short interval/timeout so both loops self-terminate quickly (real defaults would hang the test).
    await Promise.all([
      recovery.reconcileGeneratingDrafts({ intervalMs: 5, timeoutMs: 30 }),
      recovery.reconcileGeneratingDrafts({ intervalMs: 5, timeoutMs: 30 }),
    ]);
    const gen = await import("../src/lib/studio/generateAiVersions");
    assert.equal(gen.isPollingJob(jobId), true, "job should be actively polled");
    // Both reconcile passes call GET once each to check terminal-vs-live status (that part
    // is not deduped — it's a cheap read); what MUST be deduped is the poll loop itself.
    // pollGenerationJob's own activePolls guard means the second registration is a no-op —
    // if it were NOT deduped, two independent 5ms-interval loops would each hit the status
    // endpoint repeatedly, so we bound getCalls to rule that out.
    assert.ok(getCalls >= 1, "expected at least one status GET");
    assert.ok(getCalls <= 4, `expected a bounded number of status GETs (deduped pollers), got ${getCalls}`);
    // Let the short-timeout poll loop finish so it doesn't leak into later tests.
    await new Promise(r => setTimeout(r, 60));
    assert.equal(gen.isPollingJob(jobId), false, "poll loop must have ended and deregistered");
  });

  await test("slots created out of order (2,0,1) still match correctly via generationSlot", async () => {
    reset();
    const jobId = "job-shuffled-1";
    const d2 = makePlaceholder({ jobId, slot: 2, idem: "shuf-2" });
    const d0 = makePlaceholder({ jobId, slot: 0, idem: "shuf-0" });
    const d1 = makePlaceholder({ jobId, slot: 1, idem: "shuf-1" });
    fetchImpl = async () => jsonResponse({
      status: "done",
      results: [
        { slot: 0, status: "done", imageUrl: "https://cdn/s0.jpg", error: null },
        { slot: 1, status: "done", imageUrl: "https://cdn/s1.jpg", error: null },
        { slot: 2, status: "done", imageUrl: "https://cdn/s2.jpg", error: null },
      ],
    });
    await recovery.reconcileGeneratingDrafts();
    assert.equal(store.getDraft(d0.id)?.imageUrl, "https://cdn/s0.jpg");
    assert.equal(store.getDraft(d1.id)?.imageUrl, "https://cdn/s1.jpg");
    assert.equal(store.getDraft(d2.id)?.imageUrl, "https://cdn/s2.jpg");
  });

  await test("mixed board: no-jobId + terminal-jobId + running-jobId drafts each handled correctly", async () => {
    reset();
    const dead = makePlaceholder({ idem: "mixed-nojob" });
    const jobDone = "job-mixed-done";
    const jobRunning = "job-mixed-running";
    const dDone = makePlaceholder({ jobId: jobDone, slot: 0, idem: "mixed-done-0" });
    const dRunning = makePlaceholder({ jobId: jobRunning, slot: 0, idem: "mixed-running-0" });
    fetchImpl = async (url) => {
      if (url.includes(jobDone)) return jsonResponse({ status: "done", results: [{ slot: 0, status: "done", imageUrl: "https://cdn/mixed.jpg", error: null }] });
      if (url.includes(jobRunning)) return jsonResponse({ status: "running", results: [{ slot: 0, status: "pending", imageUrl: null, error: null }] });
      throw new Error(`unexpected url ${url}`);
    };
    // Short interval/timeout so the running job's resumed poll loop self-terminates quickly.
    await recovery.reconcileGeneratingDrafts({ intervalMs: 5, timeoutMs: 30 });
    assert.equal(store.getDraft(dead.id)?.generationStatus, "failed", "no-jobId leftover judged dead");
    assert.equal(store.getDraft(dDone.id)?.generationStatus, "completed", "terminal job applied");
    assert.equal(store.getDraft(dRunning.id)?.generationStatus, "generating", "running job stays alive");
    // Drain the running job's short-timeout poll loop before the process exits.
    await new Promise(r => setTimeout(r, 60));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
