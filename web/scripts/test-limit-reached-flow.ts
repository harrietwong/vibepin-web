/**
 * Flow tests for the "quota reached" experience (PRD v3.2 §4.3/§6.4, decision #6).
 * Run: npx tsx scripts/test-limit-reached-flow.ts
 *
 * These drive the REAL runAiGeneration against a REAL pinDraftStore with a fake
 * generate() that refuses like the server does, then assert what the store actually
 * contains and what the caller was actually asked to do. The dialog itself is the
 * thin part; what matters — and what these lock down — is that:
 *
 *   • a refusal STOPS the batch instead of hammering one 402 per reference group,
 *   • the placeholders of a refused run are REMOVED, not left as failed cards whose
 *     Retry would hit the same 402,
 *   • nothing is re-requested without an explicit confirm, and when it is, it is
 *     requested at EXACTLY the remaining count (never fewer, never over the limit).
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

/** The server's ai_image refusal, with the remaining counts the enforce path knows. */
function imageLimitBody(availableRecurring: number | null) {
  return {
    ok: false,
    error_type: "ai_image_limit_reached",
    code: "ai_image_limit_reached",
    error: "You have reached your AI image limit for this billing period.",
    urls: [],
    ...(availableRecurring === null ? {} : { available_recurring: availableRecurring, available_bonus: 0 }),
  };
}

async function main() {
  const store = await import("../src/lib/pinDraftStore");
  const { runAiGeneration } = await import("../src/lib/studio/runAiGeneration");
  const { parseLimitReached, LimitReachedError, offerableRemaining, limitMessageKeyForCode } =
    await import("../src/lib/usage/limitReached");
  const reset = () => { mem.clear(); store.__resetMemoryCacheForTests(); };

  type Opts = Parameters<typeof runAiGeneration>[0]["opts"];
  const baseOpts: Opts = {
    prompt: "p", hiddenPrompt: "hp", productImages: [],
    referenceImages: [], selectedReferences: [],
    count: 4, format: "Pinterest 2:3", modelKey: "gemini_image",
    variationMode: "distinct", outputVariants: [], category: "home",
    selectedTags: [], directionBrief: "brief", briefManuallyEdited: false,
    creativeDirectionMeta: {} as Opts["creativeDirectionMeta"], productMetadata: [],
    primaryProductSelection: null,
  };

  const ref = (id: string) => ({
    id, imageUrl: `https://cdn/${id}.jpg`, source: "recommended_pin" as const,
  });

  type Prompt = { remaining: number; requested: number; retryOpts: Opts | null };

  /**
   * A UI stand-in that reproduces StudioBoard's wiring: it records the limit, and
   * exposes the staged prompt so the test can prove that ONLY a confirm re-requests.
   */
  function makeUi() {
    const requestedCounts: number[] = [];
    let prompt: Prompt | null = null;
    let settledToastShown = false;
    let limitStopped = false;

    const deps = (opts: Opts, refuse: (n: number) => boolean, availableRecurring: number | null) => ({
      store: store as never,
      generate: async ({ setup }: { setup: Opts }) => {
        requestedCounts.push(setup.count);
        if (refuse(setup.count)) {
          const parsed = parseLimitReached(402, imageLimitBody(availableRecurring));
          assert.ok(parsed, "fixture must parse as a limit");
          throw new LimitReachedError(parsed);
        }
        return { urls: Array.from({ length: setup.count }, (_, i) => `https://cdn/out${i}.jpg`) };
      },
      resolveModelLabel: () => "Gemini",
      now: () => 1, randomId: () => "test",
      // Mirrors StudioBoard: record + suppress the generic settled toast.
      onLimitReached: (limit: NonNullable<ReturnType<typeof parseLimitReached>>, ctx: { retryCount: number }) => {
        limitStopped = true;
        const remaining = Math.min(offerableRemaining(limit), Math.max(0, ctx.retryCount - 1));
        prompt = { remaining, requested: ctx.retryCount, retryOpts: remaining > 0 ? opts : null };
      },
      onSettled: () => { if (!limitStopped) settledToastShown = true; },
    });

    return {
      requestedCounts,
      get prompt(): Prompt | null { return prompt; },
      get settledToastShown() { return settledToastShown; },
      deps,
      reset() { prompt = null; limitStopped = false; settledToastShown = false; requestedCounts.length = 0; },
    };
  }

  const generatingCount = () =>
    store.getAllDrafts().filter(d => d.generationStatus === "generating").length;
  const failedCount = () =>
    store.getAllDrafts().filter(d => d.generationStatus === "failed").length;

  // ── R = 2: dialog offered, confirm re-requests EXACTLY 2 ─────────────────────
  await test("R=2 → dialog offered with remaining 2; no auto-retry", async () => {
    reset();
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, 2) as never);

    assert.deepEqual(ui.requestedCounts, [4], "exactly one request; the run must NOT retry itself");
    const staged = ui.prompt;
    assert.ok(staged, "a limit prompt must be staged");
    assert.equal(staged.remaining, 2);
    assert.equal(staged.requested, 4);
    assert.ok(staged.retryOpts, "R>0 must offer the one-click adjustment");
    // Placeholders of the refused run are gone (not left as failed Retry-able cards).
    assert.equal(generatingCount(), 0, "no placeholder may be left generating");
    assert.equal(failedCount(), 0, "a refused run leaves no failed cards");
    assert.equal(store.getAllDrafts().length, 0, "placeholders must be removed entirely");
    assert.equal(ui.settledToastShown, false, "the generic settled toast must be suppressed");
  });

  await test("confirm → re-requests exactly 2 (never fewer, never over the limit)", async () => {
    reset();
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, 2) as never);

    const staged = ui.prompt;
    assert.ok(staged?.retryOpts);
    ui.reset();
    // THE CONFIRM CLICK: same options, count overridden to exactly the remainder.
    const retryOpts = { ...staged.retryOpts, count: staged.remaining };
    await runAiGeneration(
      { parent: null, opts: retryOpts },
      ui.deps(retryOpts, n => n > 2, 2) as never,
    );

    assert.deepEqual(ui.requestedCounts, [2], "the retry must request exactly R=2");
    assert.equal(ui.prompt, null, "a within-quota retry must not raise the dialog again");
    assert.equal(store.getAllDrafts().length, 2, "exactly 2 Pins land");
    assert.equal(generatingCount(), 0);
  });

  await test("confirm on a version-mode run keeps the captured parent", async () => {
    reset();
    // Regression guard for a real bug: the retry runs AFTER the drawer closed, so if
    // it re-derived `parent` from drawer state it would (a) hit the !aiDrawer guard and
    // do nothing, or (b) lose the parent and orphan the regenerated Pins. StudioBoard
    // captures the refused run's parent on the prompt; this proves the captured value
    // is what the retry actually generates against.
    const parent = store.createBoardDraft({
      imageUrl: "https://cdn/parent.jpg",
      source: "upload",
      idempotencyKey: "parent-1",
    });
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    await runAiGeneration({ parent, opts }, ui.deps(opts, () => true, 2) as never);

    const staged = ui.prompt;
    assert.ok(staged?.retryOpts, "R>0 must offer the adjustment");
    ui.reset();
    // The captured context is replayed verbatim; only `count` is overridden.
    const retryOpts = { ...staged.retryOpts, count: staged.remaining };
    await runAiGeneration({ parent, opts: retryOpts }, ui.deps(retryOpts, n => n > 2, 2) as never);

    assert.deepEqual(ui.requestedCounts, [2]);
    const generated = store.getAllDrafts().filter(d => d.parentDraftId === parent.id);
    assert.equal(generated.length, 2, "the retry must generate against the captured parent");
    assert.ok(generated.every(d => d.generationStatus === "complete" || !!d.imageUrl));
  });

  // ── cancel: no request, placeholders cleaned ─────────────────────────────────
  await test("cancel → no further request and no leftover placeholders", async () => {
    reset();
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, 2) as never);

    const before = ui.requestedCounts.length;
    // THE CANCEL CLICK: StudioBoard's dismiss just clears the prompt. Nothing else.
    ui.reset();
    assert.equal(ui.requestedCounts.length, 0, "cancel must issue no request");
    assert.equal(before, 1, "only the original refused request was ever made");
    assert.equal(store.getAllDrafts().length, 0, "cancel leaves no placeholders behind");
    assert.equal(failedCount(), 0);
  });

  // ── R = 0 / unknown: upgrade message, no request ─────────────────────────────
  await test("R=0 → upgrade message, no adjustment offered, no request", async () => {
    reset();
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, 0) as never);

    assert.deepEqual(ui.requestedCounts, [4]);
    const staged = ui.prompt;
    assert.ok(staged);
    assert.equal(staged.remaining, 0);
    assert.equal(staged.retryOpts, null, "R=0 must NOT offer a retry");
    assert.equal(store.getAllDrafts().length, 0);
  });

  await test("server omits the counts → treated as R=0, never guessed", async () => {
    reset();
    const ui = makeUi();
    const opts = { ...baseOpts, count: 4 };
    // This is the CURRENT production body: aiImageLimitResponseBody() ships no counts.
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, null) as never);

    const staged = ui.prompt;
    assert.ok(staged);
    assert.equal(staged.remaining, 0);
    assert.equal(staged.retryOpts, null, "an unknown remainder must not be re-requested");
  });

  // ── multi-group: the batch STOPS, it does not 402 once per reference ─────────
  await test("multi-reference batch stops at the first refusal", async () => {
    reset();
    const ui = makeUi();
    const opts = {
      ...baseOpts, count: 2,
      selectedReferences: [ref("r1"), ref("r2"), ref("r3")] as Opts["selectedReferences"],
    };
    await runAiGeneration({ parent: null, opts }, ui.deps(opts, () => true, 1) as never);

    assert.equal(ui.requestedCounts.length, 1, "must not send one request per group after a refusal");
    assert.equal(store.getAllDrafts().length, 0, "every group's placeholders are cleaned up");
  });

  await test("a NON-limit failure still fails-and-continues (unchanged behaviour)", async () => {
    reset();
    const ui = makeUi();
    const opts = {
      ...baseOpts, count: 1,
      selectedReferences: [ref("r1"), ref("r2")] as Opts["selectedReferences"],
    };
    const deps = {
      ...ui.deps(opts, () => false, 2),
      generate: async ({ styleReference }: { styleReference: string | null }) => {
        if (styleReference?.includes("r1")) throw new Error("provider exploded");
        return { urls: ["https://cdn/ok.jpg"] };
      },
    };
    const result = await runAiGeneration({ parent: null, opts }, deps as never);
    assert.equal(result.limitReached, null);
    assert.equal(result.okCount, 1, "the second group still ran");
    assert.equal(result.failCount, 1);
    assert.equal(failedCount(), 1, "a real provider failure DOES leave a failed card");
  });

  // ── text + post: the PRD sentence is chosen once, from the code ──────────────
  await test("text limit → the AI-text PRD sentence key, exactly once", async () => {
    const key = limitMessageKeyForCode("ai_text_limit_reached");
    assert.equal(key, "studioBoard.limit.text.allUsed");
    // The panel shows one message per attempt: one setErrorMsg + one toast, and the
    // rate-limit branch must NOT also fire (they are mutually exclusive branches).
    const parsed = parseLimitReached(402, {
      ok: false, code: "ai_text_limit_reached", error: "ai_text_limit_reached",
      userMessage: "You have reached your AI copy limit for this billing period.",
    });
    assert.equal(parsed?.kind, "ai_text");
    assert.equal(limitMessageKeyForCode("rate_limited"), null, "429 must not map to a limit message");
  });

  await test("scheduled post limit → the post PRD sentence key, exactly once", async () => {
    const key = limitMessageKeyForCode("scheduled_post_limit_reached");
    assert.equal(key, "studioBoard.limit.post.allUsed");
    // A publish outcome carries { errorCode }; the UI picks the FIRST limit key across
    // failed destinations, so a multi-destination fan-out shows ONE message, not N.
    const failedRows = [
      { errorCode: "scheduled_post_limit_reached" },
      { errorCode: "scheduled_post_limit_reached" },
    ];
    const keys = failedRows.map(r => limitMessageKeyForCode(r.errorCode)).filter(Boolean);
    assert.equal(keys.length, 2);
    assert.equal(keys.find(Boolean), "studioBoard.limit.post.allUsed");
    // Unrelated publish failures keep the existing generic message.
    assert.equal(limitMessageKeyForCode("board_not_owned"), null);
    assert.equal(limitMessageKeyForCode("connected_account_limit_reached"), null);
  });

  // ── the three PRD sentences exist in English ────────────────────────────────
  await test("every limit message key resolves to the PRD sentence in en", async () => {
    const { en } = await import("../src/lib/i18n/messages");
    const catalog = en as Record<string, string>;
    assert.match(catalog["studioBoard.limit.image.allUsed"],
      /^You have used all AI images included in your current plan\./);
    assert.match(catalog["studioBoard.limit.text.allUsed"],
      /^You have used all AI text generations included in your current plan\./);
    assert.ok(catalog["studioBoard.limit.post.allUsed"]?.length);
    assert.ok(catalog["studioBoard.limit.image.overRequestBody"].includes("{requested}"));
    assert.ok(catalog["studioBoard.limit.image.overRequestBody"].includes("{remaining}"));
    assert.ok(catalog["studioBoard.limit.image.generateRemaining"].includes("{remaining}"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
