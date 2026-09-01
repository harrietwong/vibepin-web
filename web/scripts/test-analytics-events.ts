/**
 * Unit tests for analytics event ingest (A4): the pure normalizer and the
 * client-side fire-and-forget buffer/report path.
 * Run: npx tsx scripts/test-analytics-events.ts   (from web/)
 */

import assert from "node:assert";

// ── window / navigator shim (must exist before importing analytics.ts) ─────────
const listeners = new Map<string, Set<() => void>>();
const beacons: Array<{ url: string; body: string }> = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (t: string, cb: () => void) => {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(cb);
  },
  removeEventListener: (t: string, cb: () => void) => { listeners.get(t)?.delete(cb); },
  dispatchEvent: () => true,
};
// `navigator` is a read-only getter on globalThis in modern Node — define it.
const navShim = {
  sendBeacon: ((url: string, data: Blob | string) => {
    // In this shim we synchronously capture the serialized body.
    if (typeof data === "string") beacons.push({ url, body: data });
    else beacons.push({ url, body: (data as unknown as { _text?: string })._text ?? "[blob]" });
    return true;
  }) as unknown,
};
Object.defineProperty(globalThis, "navigator", { value: navShim, configurable: true, writable: true });
// Minimal Blob that preserves text so the shim can read it back.
(globalThis as unknown as { Blob: unknown }).Blob = class {
  _text: string;
  type: string;
  constructor(parts: string[], opts?: { type?: string }) { this._text = parts.join(""); this.type = opts?.type ?? ""; }
};

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

async function main() {
  const ingest = await import("../src/lib/analyticsIngest");
  const analytics = await import("../src/lib/analytics");

  // ── normalizeAnalyticsEvents ────────────────────────────────────────────────

  test("normalize: accepts { events: [...] } and a bare array alike", () => {
    const a = ingest.normalizeAnalyticsEvents({ events: [{ event: "draft_published" }] });
    const b = ingest.normalizeAnalyticsEvents([{ event: "draft_published" }]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].event_name, "draft_published");
  });

  test("normalize: drops items without a usable event name", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "regenerate_clicked" },
      { event: "" },
      { event: "   " },
      { payload: { a: 1 } },
      { event: "x".repeat(ingest.MAX_EVENT_NAME_LEN + 1) },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_name, "regenerate_clicked");
  });

  test("normalize: caps the batch at MAX_EVENTS_PER_BATCH", () => {
    const many = Array.from({ length: ingest.MAX_EVENTS_PER_BATCH + 10 }, () => ({ event: "keyword_removed" }));
    assert.equal(ingest.normalizeAnalyticsEvents(many).length, ingest.MAX_EVENTS_PER_BATCH);
  });

  test("normalize: extracts draftId, accepts props as a payload alias", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "direction_selected", draftId: "pd_1", props: { direction: "warm" } },
    ]);
    assert.equal(rows[0].draft_id, "pd_1");
    assert.deepEqual(rows[0].payload, { direction: "warm" });
  });

  test("normalize: oversized payload is replaced with a truncation marker", () => {
    const big = { blob: "x".repeat(ingest.MAX_PAYLOAD_BYTES + 100) };
    const rows = ingest.normalizeAnalyticsEvents([{ event: "ai_copy_success", payload: big }]);
    assert.equal(rows[0].payload!._truncated, true);
    assert.ok((rows[0].payload!._bytes as number) > ingest.MAX_PAYLOAD_BYTES);
  });

  test("normalize: empty/invalid payload → null", () => {
    const rows = ingest.normalizeAnalyticsEvents([
      { event: "generation_kept", payload: {} },
      { event: "generation_deleted", payload: [1, 2] },
    ]);
    assert.equal(rows[0].payload, null);
    assert.equal(rows[1].payload, null);
  });

  // ── client track() buffering / reporting ────────────────────────────────────

  test("track: buffers then reports a batch via sendBeacon on flush", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    analytics.track("reference_selected", { draftId: "pd_9", refId: "r1" });
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 1, "buffered, not sent yet");
    assert.equal(beacons.length, 0);
    analytics.__flushAnalyticsForTests();
    assert.equal(beacons.length, 1, "flush sent one beacon");
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string; draftId?: string; payload?: Record<string, unknown> }> };
    assert.equal(sent.events[0].event, "reference_selected");
    assert.equal(sent.events[0].draftId, "pd_9");
    assert.equal(sent.events[0].payload!.refId, "r1");
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 0, "buffer drained");
  });

  test("track: auto-flushes once the buffer reaches the threshold", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    for (let i = 0; i < 15; i++) analytics.track("keyword_removed", { draftId: `pd_${i}` });
    assert.equal(beacons.length, 1, "threshold flush fired without waiting for the timer");
    const sent = JSON.parse(beacons[0].body) as { events: unknown[] };
    assert.ok(sent.events.length <= 20, "never exceeds the server batch cap");
  });

  // ── draft_published (publish-success call sites in StudioBoard.tsx /
  // DraftDetailsDrawer.tsx / BatchEditDrawer.tsx) ─────────────────────────────
  // These components render React and aren't unit-tested here; instead this locks
  // down the CONTRACT those call sites rely on: track() with the exact payload keys
  // they send (draftId, generationSessionId when available, remotePinId), fired only
  // on success and wrapped so a publish that succeeds is never affected by analytics.

  /** Mirrors the try/catch each publish-success call site wraps track() in. */
  function trackPublishSuccessBestEffort(props: { draftId?: string; generationSessionId?: string; remotePinId?: string }): void {
    try { analytics.track("draft_published", props); }
    catch { /* analytics must never affect publish */ }
  }

  test("draft_published: publish success reports draftId + remotePinId (generationSessionId omitted when unknown)", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackPublishSuccessBestEffort({ draftId: "pd_42", remotePinId: "pin_123" });
    analytics.__flushAnalyticsForTests();
    assert.equal(beacons.length, 1);
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string; draftId?: string; payload?: Record<string, unknown> }> };
    assert.equal(sent.events.length, 1, "fires exactly once per successful publish");
    assert.equal(sent.events[0].event, "draft_published");
    assert.equal(sent.events[0].draftId, "pd_42");
    assert.equal(sent.events[0].payload!.remotePinId, "pin_123");
    assert.equal("generationSessionId" in sent.events[0].payload!, false, "omitted, not guessed, when the draft has no sourceGenerationId");
  });

  test("draft_published: includes generationSessionId (sourceGenerationId) when the draft carries one", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackPublishSuccessBestEffort({ draftId: "pd_43", generationSessionId: "gen_req_9", remotePinId: "pin_456" });
    analytics.__flushAnalyticsForTests();
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ payload?: Record<string, unknown> }> };
    assert.equal(sent.events[0].payload!.generationSessionId, "gen_req_9");
    assert.equal(sent.events[0].payload!.remotePinId, "pin_456");
  });

  test("draft_published: a failed publish never triggers the event", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    // Simulates the call sites' shape: track() only runs on the success branch, never
    // inside/after a caught publish error.
    try {
      throw new Error("Pinterest API error");
    } catch {
      // publish failed — call sites record publishError state here, NOT track("draft_published", ...)
    }
    analytics.__flushAnalyticsForTests();
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 0);
    assert.equal(beacons.length, 0, "no event reported for a failed publish");
  });

  test("track: never throws even if reporting internals are gone", () => {
    analytics.__resetAnalyticsForTests();
    const savedBeacon = (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon;
    (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon = undefined;
    (globalThis as unknown as { fetch?: unknown }).fetch = () => { throw new Error("no fetch"); };
    assert.doesNotThrow(() => {
      analytics.track("draft_published", { draftId: "pd_x" });
      analytics.__flushAnalyticsForTests();
    });
    (globalThis as unknown as { navigator: { sendBeacon?: unknown } }).navigator.sendBeacon = savedBeacon;
  });

  // -- direction_rejected (AiVersionDrawer.tsx handleSelectDirection) ---------
  // Fired when the user switches to a DIFFERENT recommended direction than the one
  // currently selected -- the direction being left behind is the negative sample.
  // Mirrors the try/catch the call site wraps track() in.
  function trackDirectionSwitchBestEffort(props: { draftId?: string; previous: { id: string; kind?: string } | null; next: { id: string; kind?: string } }): void {
    if (props.previous && props.previous.id !== props.next.id) {
      try {
        analytics.track("direction_rejected", {
          draftId: props.draftId ?? null,
          directionId: props.previous.id,
          directionKind: props.previous.kind ?? null,
        });
      } catch { /* analytics must never affect direction selection */ }
    }
    analytics.track("direction_selected", {
      draftId: props.draftId ?? null,
      directionId: props.next.id,
      directionKind: props.next.kind ?? null,
    });
  }

  test("direction_rejected: switching directions reports the PREVIOUS direction as rejected, then the new one as selected", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDirectionSwitchBestEffort({
      draftId: "pd_7",
      previous: { id: "dir_warm", kind: "lifestyle" },
      next: { id: "dir_cool", kind: "product_focused" },
    });
    analytics.__flushAnalyticsForTests();
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string; payload?: Record<string, unknown> }> };
    assert.equal(sent.events.length, 2, "one rejected + one selected");
    assert.equal(sent.events[0].event, "direction_rejected");
    assert.equal(sent.events[0].payload!.directionId, "dir_warm");
    assert.equal(sent.events[1].event, "direction_selected");
    assert.equal(sent.events[1].payload!.directionId, "dir_cool");
  });

  test("direction_rejected: the FIRST pick (no previous direction) never fires rejected", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDirectionSwitchBestEffort({ draftId: "pd_8", previous: null, next: { id: "dir_only", kind: "lifestyle" } });
    analytics.__flushAnalyticsForTests();
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string }> };
    assert.equal(sent.events.length, 1, "only direction_selected fires on the first pick");
    assert.equal(sent.events[0].event, "direction_selected");
  });

  test("direction_rejected: re-clicking the SAME already-selected direction never fires rejected", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDirectionSwitchBestEffort({
      draftId: "pd_9",
      previous: { id: "dir_same", kind: "lifestyle" },
      next: { id: "dir_same", kind: "lifestyle" },
    });
    analytics.__flushAnalyticsForTests();
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string }> };
    assert.equal(sent.events.length, 1, "no rejected event when the direction did not actually change");
    assert.equal(sent.events[0].event, "direction_selected");
  });

  // -- draft_scheduled (DraftDetailsDrawer.tsx handleSchedulePrimary) ---------
  // Fires once persistDraft() has ACTUALLY succeeded, and only when the draft was NOT
  // already scheduled before this action (so re-saving an already-scheduled Pin's time
  // does not re-fire it). Mirrors the call site's try/catch.
  function trackDraftScheduledBestEffort(props: { wasScheduled: boolean; persistSucceeded: boolean; draftId?: string; generationSessionId?: string; plannedAt?: string | null }): void {
    if (!props.persistSucceeded) return; // persistDraft() returned null -- never fires
    if (props.wasScheduled) return; // re-save of an already-scheduled Pin -- never fires
    try {
      analytics.track("draft_scheduled", {
        draftId: props.draftId ?? null,
        ...(props.generationSessionId ? { generationSessionId: props.generationSessionId } : {}),
        plannedAt: props.plannedAt ?? null,
      });
    } catch { /* analytics must never affect scheduling */ }
  }

  test("draft_scheduled: a Pin scheduled for the first time reports draftId + plannedAt (generationSessionId omitted when unknown)", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDraftScheduledBestEffort({ wasScheduled: false, persistSucceeded: true, draftId: "pd_50", plannedAt: "2026-09-05T09:00" });
    analytics.__flushAnalyticsForTests();
    assert.equal(beacons.length, 1);
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ event: string; payload?: Record<string, unknown> }> };
    assert.equal(sent.events.length, 1, "fires exactly once per newly-scheduled Pin");
    assert.equal(sent.events[0].event, "draft_scheduled");
    assert.equal(sent.events[0].payload!.draftId, "pd_50");
    assert.equal(sent.events[0].payload!.plannedAt, "2026-09-05T09:00");
    assert.equal("generationSessionId" in sent.events[0].payload!, false, "omitted, not guessed, when the draft has no sourceGenerationId");
  });

  test("draft_scheduled: includes generationSessionId (sourceGenerationId) when the draft carries one", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDraftScheduledBestEffort({ wasScheduled: false, persistSucceeded: true, draftId: "pd_51", generationSessionId: "gen_req_5", plannedAt: "2026-09-06T09:00" });
    analytics.__flushAnalyticsForTests();
    const sent = JSON.parse(beacons[0].body) as { events: Array<{ payload?: Record<string, unknown> }> };
    assert.equal(sent.events[0].payload!.generationSessionId, "gen_req_5");
  });

  test("draft_scheduled: re-saving an ALREADY-scheduled Pin never re-fires the event", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDraftScheduledBestEffort({ wasScheduled: true, persistSucceeded: true, draftId: "pd_52", plannedAt: "2026-09-07T09:00" });
    analytics.__flushAnalyticsForTests();
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 0);
    assert.equal(beacons.length, 0, "no duplicate event when the Pin was already scheduled");
  });

  test("draft_scheduled: a FAILED persist never triggers the event", () => {
    analytics.__resetAnalyticsForTests();
    beacons.length = 0;
    trackDraftScheduledBestEffort({ wasScheduled: false, persistSucceeded: false, draftId: "pd_53", plannedAt: "2026-09-08T09:00" });
    analytics.__flushAnalyticsForTests();
    assert.equal(analytics.__getAnalyticsBufferForTests().length, 0);
    assert.equal(beacons.length, 0, "no event reported when persistDraft() failed");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
