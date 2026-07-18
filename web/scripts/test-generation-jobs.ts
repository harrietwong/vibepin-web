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

// Stub the supabase browser session lookup so authHeaders() never makes a real call —
// createBrowserClient() itself doesn't hit the network on construction, and
// auth.getSession() resolves locally against an empty session, so no fetch mock is
// needed for auth; the mocked global.fetch below only ever sees /api/... calls.

const MOCK_SETUP: AiVersionOptions = {
  prompt: "test prompt",
  hiddenPrompt: "",
  productImages: ["https://cdn/product.jpg"],
  referenceImages: [],
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

  console.log("WP3-P1 generation-jobs: enqueue + poll");

  // ── enqueueGeneration ──────────────────────────────────────────────────────
  await test("enqueueGeneration: worker-mode shape returns {jobId, slots} as-is", async () => {
    calls = [];
    fetchImpl = async (url) => {
      assert(url.includes("/api/generate"), `expected /api/generate, got ${url}`);
      return jsonResponse({ jobId: "job-123", slots: 3 });
    };
    const result = await mod.enqueueGeneration({ setup: MOCK_SETUP });
    assert(result !== null, "expected a non-null enqueue result");
    assert(result!.jobId === "job-123", `expected jobId job-123, got ${result!.jobId}`);
    assert(result!.slots === 3, `expected slots 3, got ${result!.slots}`);
    assert(calls.length === 1, `expected exactly 1 fetch call, got ${calls.length}`);
  });

  await test("enqueueGeneration: worker unhealthy (503) throws generation_unavailable, no zombie swallow", async () => {
    fetchImpl = async () => jsonResponse({ error: "generation_unavailable" }, 503);
    let threw = false;
    try {
      await mod.enqueueGeneration({ setup: MOCK_SETUP });
    } catch (e) {
      threw = true;
      assert((e as Error).message === "generation_unavailable", `expected generation_unavailable message, got ${(e as Error).message}`);
    }
    assert(threw, "expected enqueueGeneration to throw on 503");
  });

  await test("enqueueGeneration: inline-mode response shape (no jobId) returns null", async () => {
    fetchImpl = async () => jsonResponse({ ok: true, urls: ["https://cdn/a.jpg"], keyword: "x" });
    const result = await mod.enqueueGeneration({ setup: MOCK_SETUP });
    assert(result === null, "expected null so the caller falls back to the inline path");
  });

  await test("enqueueGeneration: non-503 non-ok response throws", async () => {
    fetchImpl = async () => jsonResponse({ error: "boom" }, 500);
    let threw = false;
    try { await mod.enqueueGeneration({ setup: MOCK_SETUP }); }
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
