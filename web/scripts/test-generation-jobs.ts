/**
 * Unit tests for WP3-P1 package B: enqueue + client polling.
 * Run: npx tsx scripts/test-generation-jobs.ts   (from web/)
 *
 * Pure node — mocks global.fetch, no real server or Supabase. Covers:
 *   - enqueueGeneration: worker-mode shape ({jobId, slots}) returned as-is
 *   - enqueueGeneration: worker unhealthy → 503 generation_unavailable throws, no silent swallow
 *   - enqueueGeneration: inline-mode shape (no jobId) → returns null (caller falls back)
 *   - pollGenerationJob: incremental per-slot callbacks, never repeated once terminal
 *   - pollGenerationJob: terminal job status stops polling (onEnd fires exactly once)
 *   - pollGenerationJob: 15-minute wall-clock timeout fails remaining pending slots
 */

// Dummy env so importing the supabase browser client chain never throws.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

import type { AiVersionOptions } from "../src/components/studio/AiVersionDrawer";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

// Enqueue now requires a network-verified owner before persisting a replay body.
// Pure-node tests provide that identity through the explicit test seam; polling's
// legacy authHeaders() lookup remains local and the fetch mock only sees /api calls.

const MOCK_SETUP: AiVersionOptions = {
  prompt: "test prompt",
  hiddenPrompt: "",
  productImages: ["https://cdn/product.jpg"],
  referenceImages: [],
  // Required since the create-pin lineage introduced canonical reference selection
  // (lib/studio/selectedReferences). Empty = a product/prompt-only run, which is
  // what this worker-path fixture exercises.
  selectedReferences: [],
  count: 3,
  format: "vertical 2:3",
  modelKey: "gemini_image",
  variationMode: "distinct",
  outputVariants: [],
  category: "home",
  selectedTags: [],
  primaryFormatTag: undefined,
  directionBrief: "",
  briefManuallyEdited: false,
  creativeDirectionMeta: {} as AiVersionOptions["creativeDirectionMeta"],
  productMetadata: [],
};

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("fetchImpl not configured for this test");
};

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  calls.push({ url, init });
  return fetchImpl(url, init);
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function main() {
  const mod = await import("../src/lib/studio/generateAiVersions");
  const enqueue = (opts: Parameters<typeof mod.enqueueGeneration>[0]) => mod.enqueueGeneration(opts, {
    resolveAuthContext: async () => ({
      ownerId: "11111111-1111-4111-8111-111111111111",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-user-a" },
    }),
  });

  console.log("WP3-P1 generation-jobs: enqueue + poll");

  // ── enqueueGeneration ──────────────────────────────────────────────────────
  await test("enqueueGeneration: worker-mode shape returns {jobId, slots} as-is", async () => {
    calls = [];
    fetchImpl = async (url) => {
      assert(url.includes("/api/generate"), `expected /api/generate, got ${url}`);
      return jsonResponse({ jobId: "job-123", slots: 3 });
    };
    const result = await enqueue({ setup: MOCK_SETUP });
    assert(result.mode === "worker", `expected worker mode, got ${result.mode}`);
    if (result.mode !== "worker") throw new Error("expected worker result");
    assert(result.jobId === "job-123", `expected jobId job-123, got ${result.jobId}`);
    assert(result.slots === 3, `expected slots 3, got ${result.slots}`);
    assert(calls.length === 1, `expected exactly 1 fetch call, got ${calls.length}`);
    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as { generationRequestId?: string };
    assert(headerValue(calls[0].init, "X-Request-Id") === body.generationRequestId, "POST request id must match the durable generation intent");
  });

  await test("enqueueGeneration: the stable generation intent is sent as X-Request-Id", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({ jobId: "job-request-id", slots: 3 });
    const result = await enqueue({ setup: MOCK_SETUP, generationIntentId: "intent-request-id" });
    assert(result.mode === "worker", "expected worker mode for request-id contract");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert(headers["X-Request-Id"] === "intent-request-id", "POST must carry the same opaque intent id in X-Request-Id");
  });

  await test("enqueueGeneration: a failed intent persistence gate sends zero POSTs", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({ jobId: "must-not-exist", slots: 3 });
    let code = "";
    try {
      await enqueue({ setup: MOCK_SETUP, onIntentPrepared: () => false });
    } catch (error) {
      code = String((error as { code?: unknown }).code ?? "");
    }
    assert(code === "generation_intent_persist_failed", `expected fixed persist error code, got ${code || "none"}`);
    assert(calls.length === 0, "no network request may run before the intent gate succeeds");
  });

  await test("enqueueGeneration: one group sends only its own reference and keeps the batch identity", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({ jobId: "job-ref", slots: 3 });
    await enqueue({
      setup: { ...MOCK_SETUP, referenceImages: ["https://cdn/legacy-first.jpg"] },
      styleReference: "https://cdn/group-b.jpg",
      batchRequestId: "board_batch",
    });

    assert(calls.length === 1, `expected exactly one state-changing POST, got ${calls.length}`);
    const body = JSON.parse(String(calls[0].init?.body ?? "{}")) as Record<string, unknown>;
    assert(body.style_ref === "https://cdn/group-b.jpg", `wrong group style_ref: ${String(body.style_ref)}`);
    assert(body.referenceImageCountRequested === 1, "one request must carry exactly one reference group");
    assert(String(body.generationRequestId).startsWith("board_batch_g"), "group request must correlate to the batch intent");
    const inputs = body.image_inputs as Array<{ role?: string; sourceUrl?: string }>;
    const references = inputs.filter(input => input.role === "reference");
    assert(references.length === 1 && references[0].sourceUrl === "https://cdn/group-b.jpg", "legacy first reference must not leak into group B");
  });

  await test("enqueueGeneration: worker unhealthy (503) throws generation_unavailable, no zombie swallow", async () => {
    fetchImpl = async () => jsonResponse({ error: "generation_unavailable" }, 503);
    let threw = false;
    try {
      await enqueue({ setup: MOCK_SETUP });
    } catch (e) {
      threw = true;
      assert((e as Error).message === "generation_unavailable", `expected generation_unavailable message, got ${(e as Error).message}`);
    }
    assert(threw, "expected enqueueGeneration to throw on 503");
  });

  await test("enqueueGeneration: transport loss then refusal stays unknown until exact reconciliation", async () => {
    calls = [];
    let attempt = 0;
    fetchImpl = async () => {
      attempt++;
      if (attempt === 1) throw new Error("commit response lost");
      return jsonResponse({ error: "generation_unavailable" }, 503);
    };
    let code = "";
    try { await enqueue({ setup: MOCK_SETUP }); }
    catch (error) { code = String((error as { code?: unknown }).code ?? ""); }
    assert(attempt === 2, `expected one replay, got ${attempt} attempts`);
    assert(code === "generation_outcome_unknown", `expected ambiguous outcome, got ${code || "no code"}`);
    assert(calls.length === 2, `expected two captured transport attempts, got ${calls.length}`);
    assert(headerValue(calls[0].init, "X-Request-Id") === headerValue(calls[1].init, "X-Request-Id"), "ambiguous replay must reuse the exact request id");
    assert(calls[0].init?.body === calls[1].init?.body, "ambiguous replay must reuse the exact serialized payload");
  });

  await test("enqueueGeneration: intent persistence refusal performs zero POST", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({ jobId: "must-not-exist", slots: 1 });
    let code = "";
    try {
      await enqueue({ setup: MOCK_SETUP, onIntentPrepared: () => false });
    } catch (error) {
      code = String((error as { code?: unknown }).code ?? "");
    }
    assert(code === "generation_intent_persist_failed", `expected persistence failure, got ${code || "no code"}`);
    assert(calls.length === 0, `persistence failure must produce zero POST, got ${calls.length}`);
  });

  await test("dispatchGenerationGroup: owner switch after POST produces zero worker/store callback", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({ jobId: "job-owner-switch", slots: 1 });
    let ownerChecks = 0;
    let workerCallbacks = 0;
    let code = "";
    try {
      await mod.dispatchGenerationGroup({
        setup: { ...MOCK_SETUP, count: 1 },
        styleReference: null,
        batchRequestId: "batch-owner",
        groupIndex: 0,
        generationIntentId: "intent-owner",
        placeholderIds: ["placeholder-owner"],
        onIntentPrepared: () => true,
        onWorkerJob: () => { workerCallbacks++; },
        ownerStillActive: () => ++ownerChecks === 1,
        testDeps: {
          resolveAuthContext: async () => ({
            ownerId: "11111111-1111-4111-8111-111111111111",
            headers: { "Content-Type": "application/json", Authorization: "Bearer test-user-a" },
          }),
          fetchImpl: (input, init) => (globalThis.fetch as typeof fetch)(input, init),
        },
      });
    } catch (error) {
      code = String((error as { code?: unknown }).code ?? "");
    }
    assert(code === "generation_owner_changed", `expected owner change, got ${code || "no code"}`);
    assert(calls.length === 1, "the already-started POST is observed exactly once");
    assert(workerCallbacks === 0, "new owner must receive zero worker/store callback");
  });

  await test("enqueueGeneration: inline-mode response is returned from the same request", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({
      ok: true,
      urls: ["https://cdn/a.jpg"],
      generation_request_id: "inline-123",
      requested_image_count: 1,
      actual_image_count: 1,
    });
    const result = await enqueue({ setup: MOCK_SETUP });
    assert(result.mode === "inline", `expected inline mode, got ${result.mode}`);
    if (result.mode !== "inline") throw new Error("expected inline result");
    assert(result.result.urls.length === 1, "expected the generated URL to be preserved");
    assert(result.result.urls[0] === "https://cdn/a.jpg", "expected the original inline URL");
    assert(result.result.generationRequestId === "inline-123", "expected inline generation id");
    assert(calls.length === 1, `expected exactly 1 fetch call, got ${calls.length}`);
  });

  await test("enqueueGeneration: non-503 non-ok response throws", async () => {
    fetchImpl = async () => jsonResponse({ error: "boom" }, 500);
    let threw = false;
    try { await enqueue({ setup: MOCK_SETUP }); }
    catch { threw = true; }
    assert(threw, "expected a throw on 500");
  });

  // ── pollGenerationJob ──────────────────────────────────────────────────────
  await test("pollGenerationJob: incremental per-slot callbacks fire once each, no repeats", async () => {
    let pollCount = 0;
    const slotEvents: Array<{ slot: number; status: string; url?: string }> = [];
    let endStatus: string | null = null;

    fetchImpl = async () => {
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({
          status: "running",
          results: [
            { slot: 0, status: "done", imageUrl: "https://cdn/0.jpg", error: null },
            { slot: 1, status: "pending", imageUrl: null, error: null },
            { slot: 2, status: "pending", imageUrl: null, error: null },
          ],
        });
      }
      if (pollCount === 2) {
        // slot 0 repeated as done — must NOT re-fire; slot 1 newly done; slot 2 still pending.
        return jsonResponse({
          status: "running",
          results: [
            { slot: 0, status: "done", imageUrl: "https://cdn/0.jpg", error: null },
            { slot: 1, status: "done", imageUrl: "https://cdn/1.jpg", error: null },
            { slot: 2, status: "pending", imageUrl: null, error: null },
          ],
        });
      }
      // Terminal: slot 2 fails, job partial.
      return jsonResponse({
        status: "partial",
        results: [
          { slot: 0, status: "done", imageUrl: "https://cdn/0.jpg", error: null },
          { slot: 1, status: "done", imageUrl: "https://cdn/1.jpg", error: null },
          { slot: 2, status: "failed", imageUrl: null, error: "provider timeout" },
        ],
      });
    };

    await new Promise<void>((resolve, reject) => {
      const timeoutGuard = setTimeout(() => reject(new Error("poll test did not terminate")), 5000);
      mod.pollGenerationJob("job-abc", {
        onSlot: (slot, status, url) => { slotEvents.push({ slot, status, url }); },
        onEnd: (status) => { endStatus = status; clearTimeout(timeoutGuard); resolve(); },
      }, { intervalMs: 5 });
    });

    assert(pollCount === 3, `expected exactly 3 poll GETs, got ${pollCount}`);
    assert(endStatus === "partial", `expected terminal status partial, got ${endStatus}`);
    // Exactly one event per slot — no duplicates for slot 0 across polls 1-3.
    const slot0Events = slotEvents.filter(e => e.slot === 0);
    assert(slot0Events.length === 1, `expected slot 0 to fire exactly once, got ${slot0Events.length}`);
    assert(slot0Events[0].status === "done" && slot0Events[0].url === "https://cdn/0.jpg", "slot 0 should report done with its url");
    const slot1Events = slotEvents.filter(e => e.slot === 1);
    assert(slot1Events.length === 1, `expected slot 1 to fire exactly once, got ${slot1Events.length}`);
    const slot2Events = slotEvents.filter(e => e.slot === 2);
    assert(slot2Events.length === 1 && slot2Events[0].status === "failed", "slot 2 should report failed exactly once");
  });

  await test("awaitGenerationJob: sparse worker results preserve their original slots", async () => {
    calls = [];
    fetchImpl = async () => jsonResponse({
      status: "partial",
      results: [
        { slot: 0, status: "failed", imageUrl: null, error: "provider error" },
        { slot: 1, status: "done", imageUrl: "https://cdn/slot-1.jpg", error: null },
        { slot: 2, status: "failed", imageUrl: null, error: "timeout" },
        { slot: 3, status: "done", imageUrl: "https://cdn/slot-3.jpg", error: null },
      ],
    });

    const result = await mod.awaitGenerationJob("job-sparse", 4, { intervalMs: 1 });
    assert(result.slotOutputs.length === 4, "all requested worker slots must remain addressable");
    assert(result.slotOutputs[0] === null, "failed slot 0 must stay null");
    assert(result.slotOutputs[1] === "https://cdn/slot-1.jpg", "slot 1 URL moved");
    assert(result.slotOutputs[2] === null, "failed slot 2 must stay null");
    assert(result.slotOutputs[3] === "https://cdn/slot-3.jpg", "slot 3 URL moved");
    assert(result.urls.join(",") === "https://cdn/slot-1.jpg,https://cdn/slot-3.jpg", "compact success list should still be available");
    assert(calls.length === 1 && calls[0].url.endsWith("/api/generation-jobs/job-sparse"), "worker job should be polled once when terminal");
  });

  await test("pollGenerationJob: terminal 'done' status stops polling immediately", async () => {
    let pollCount = 0;
    fetchImpl = async () => {
      pollCount++;
      return jsonResponse({
        status: "done",
        results: [{ slot: 0, status: "done", imageUrl: "https://cdn/only.jpg", error: null }],
      });
    };

    const endStatus = await new Promise<string>((resolve) => {
      mod.pollGenerationJob("job-done", {
        onSlot: () => {},
        onEnd: (status) => resolve(status),
      }, { intervalMs: 5 });
    });

    assert(endStatus === "done", `expected done, got ${endStatus}`);
    // Give any stray extra tick a chance to fire before asserting call count stayed at 1.
    await new Promise(r => setTimeout(r, 30));
    assert(pollCount === 1, `expected polling to stop after the terminal response, got ${pollCount} calls`);
  });

  await test("pollGenerationJob: owner mismatch after await aborts without slot/end callbacks", async () => {
    calls = [];
    let ownerActive = true;
    const slots: number[] = [];
    let ended = false;
    fetchImpl = async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      assert(headers["X-Request-Id"] === "intent-owner-switch", "poll must retain the generation request id");
      ownerActive = false; // simulate logout/account switch while this GET is in flight
      return jsonResponse({ status: "done", results: [{ slot: 0, status: "done", imageUrl: "https://cdn/should-drop.jpg", error: null }] });
    };
    let aborted = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("owner mismatch poll did not abort")), 1_000);
      mod.pollGenerationJob("job-owner-switch", {
        onSlot: slot => { slots.push(slot); },
        onEnd: () => { ended = true; clearTimeout(timeout); resolve(); },
        onAbort: () => { aborted = true; clearTimeout(timeout); resolve(); },
      }, {
        intervalMs: 1,
        headers: { Authorization: "Bearer owner-a" },
        requestId: "intent-owner-switch",
        shouldContinue: () => ownerActive,
      });
    });
    // The owner check after the awaited response must run before onSlot/onEnd.
    assert(aborted, "owner mismatch must abort the poll loop");
    assert(slots.length === 0 && !ended, "owner mismatch must produce no result callbacks");
  });

  await test("pollGenerationJob: wall-clock timeout fails remaining pending slots and stops", async () => {
    let pollCount = 0;
    fetchImpl = async () => {
      pollCount++;
      // Never resolves — always running/pending, forcing the timeout path.
      return jsonResponse({
        status: "running",
        results: [
          { slot: 0, status: "pending", imageUrl: null, error: null },
          { slot: 1, status: "done", imageUrl: "https://cdn/1.jpg", error: null },
        ],
      });
    };

    const slotEvents: Array<{ slot: number; status: string }> = [];
    const endStatus = await new Promise<string>((resolve) => {
      mod.pollGenerationJob("job-timeout", {
        onSlot: (slot, status) => { slotEvents.push({ slot, status }); },
        onEnd: (status) => resolve(status),
      }, { intervalMs: 5, timeoutMs: 25 });
    });

    assert(endStatus === "timeout", `expected timeout, got ${endStatus}`);
    const slot0Fail = slotEvents.filter(e => e.slot === 0 && e.status === "failed");
    assert(slot0Fail.length === 1, "slot 0 (never resolved) should be reported failed exactly once on timeout");
    // slot 1 already resolved done before timeout — must not be re-reported as failed.
    const slot1AfterDone = slotEvents.filter(e => e.slot === 1 && e.status === "failed");
    assert(slot1AfterDone.length === 0, "slot 1 (already done) must never be downgraded to failed by the timeout sweep");
    assert(pollCount >= 1, "timeout contract must exercise at least one real poll");
  });

  await test("pollGenerationJob: stop() cancels polling without firing onEnd", async () => {
    let pollCount = 0;
    let endFired = false;
    fetchImpl = async () => {
      pollCount++;
      return jsonResponse({ status: "running", results: [{ slot: 0, status: "pending", imageUrl: null, error: null }] });
    };
    const handle = mod.pollGenerationJob("job-cancel", {
      onSlot: () => {},
      onEnd: () => { endFired = true; },
    }, { intervalMs: 5 });
    await new Promise(r => setTimeout(r, 20));
    handle.stop();
    const countAtStop = pollCount;
    await new Promise(r => setTimeout(r, 30));
    assert(pollCount === countAtStop, "no further polling after stop()");
    assert(!endFired, "onEnd must not fire after an explicit stop()");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
