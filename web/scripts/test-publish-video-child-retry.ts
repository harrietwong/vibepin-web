/**
 * test-publish-video-child-retry.ts — the VIDEO half of P19.
 *
 * 发布可靠性 P0 技术设计 v0.1 §2.2 G / §5.4.
 *
 * ── WHAT THIS FILE IS FOR, AND WHY IT IS NOT IN THE ROUTE HARNESS ───────────
 * The route-level reconcile harness proves P19 for IMAGES: a `confirmed_absent`
 * verdict removes the stored result row, the destination is owed again, and the
 * next tick sends exactly once. That harness stubs the video dispatcher whole,
 * so it can say nothing at all about video — the interesting behaviour is
 * entirely INSIDE the thing it replaces.
 *
 * So this file drives the REAL `dispatchV76PinterestVideo` with injected
 * dependencies. The provider create is a counted fake reached only through the
 * dispatcher's own ordering (ready claim → durable attempt → publish), which is
 * what makes "createVideoPin was called N times" a claim about production
 * ordering rather than about a mock.
 *
 * ── THE FOUR CLAIMS ─────────────────────────────────────────────────────────
 *   V1  no proof            ⇒ v78 RPC, parent early-returns, create == 0
 *   V2  proof present       ⇒ v82 RPC with the check id, child opens, create == 1
 *   V3  the child receipt   ⇒ onlyPending true, dispatch set is exactly the
 *                             proof's destination, lineage points at the parent,
 *                             fingerprint self-consistent, action id ≠ parent's
 *   V4  crash replay        ⇒ the same proof derives the SAME child intent id
 *
 * V1 is the flag-off / no-credential guarantee in its strongest form: the
 * create count is zero, not "one but idempotent".
 */
import assert from "node:assert/strict";
import {
  buildDueVideoReceipt,
  buildReconcileChildVideoReceipt,
} from "../src/lib/server/publish/v76PinterestVideoBindings";
import {
  dispatchV76PinterestVideo,
  type DurableVideoPublishDependencies,
  type DurableVideoPublishInput,
  type DurableVideoPublishState,
  type MaterializedVideoSource,
} from "../src/lib/server/publish/v76PinterestVideoPublish";
import { publishConfirmationFingerprint } from "../src/lib/studio/publishConfirmation";

let passed = 0;
let failed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); passed += 1; console.log(`  OK   ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).stack ?? (error as Error).message}`); }
}

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
const DRAFT = "pd_video_child_1";
const CONN = "conn-pin-1";
const BOARD = "b1";
const DUE_AT = "2026-09-01T09:00:00.000Z";
const UPDATED_AT = "2026-09-01T08:55:00.000Z";
const DEST_KEY = `pinterest:${CONN}`;
const CHECK_ID = "chk-abs-1";
const PARENT_INTENT_ID = "publish:content-video-1:parentaction0000";

/**
 * A single-video draft payload with TWO destinations, the second one FAILED.
 *
 * The failed sibling is the point. `onlyPending: true` drops destinations that
 * are `published` or `delivery_unknown` but KEEPS a failed one, so a child
 * receipt built from the whole draft would carry a two-element dispatch set and
 * `publish_intent_confirm_prepare_v82` would answer `retry_not_allowed`
 * (migrate_v82:450-454). V3 is what holds the narrowing in place.
 */
function payload(): Record<string, unknown> {
  return {
    contentId: "content-video-1",
    title: "Autumn table",
    description: "A short clip",
    altText: "Table",
    destinationUrl: "https://shop.example.com/autumn",
    imageUrl: "https://cdn.test/poster.jpg",
    media: [{
      id: "media-v1", kind: "video", url: "https://cdn.test/clip.mp4",
      width: 1080, height: 1920, durationMs: 8000,
      posterUrl: "https://cdn.test/poster.jpg", source: "upload",
    }],
    boardId: BOARD,
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: CONN, boardId: BOARD, boardName: "B", capturedAt: DUE_AT },
      { provider: "pinterest", socialConnectionId: "conn-pin-2", boardId: "b2", boardName: "B2", capturedAt: DUE_AT },
    ],
    destinationResults: [
      {
        destinationId: DEST_KEY, provider: "pinterest", socialConnectionId: CONN,
        status: "delivery_unknown", submittedAt: DUE_AT,
      },
      {
        destinationId: "pinterest:conn-pin-2", provider: "pinterest", socialConnectionId: "conn-pin-2",
        status: "failed", submittedAt: DUE_AT, errorMessage: "nope",
      },
    ],
  };
}

const parentReceipt = buildDueVideoReceipt({
  draftId: DRAFT, updatedAt: UPDATED_AT, scheduledAt: DUE_AT, payload: payload(),
});

function childReceipt() {
  return buildReconcileChildVideoReceipt({
    draftId: DRAFT, updatedAt: UPDATED_AT, scheduledAt: DUE_AT, payload: payload(),
    reconcileCheckId: CHECK_ID,
    parentIntentId: PARENT_INTENT_ID,
    destinationId: DEST_KEY,
  });
}

/** What the dispatcher is told the durable ledger currently says. */
type Recorder = {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  creates: number;
};

/**
 * Dependencies that mirror the production binding's SHAPE, with the provider
 * create counted.
 *
 * `inspect` answers for whichever intent the receipt names: the PARENT is at
 * `delivery_unknown` (the state reconciliation found), any other intent — i.e.
 * a freshly opened child — is `missing`, which is the branch that calls
 * `confirmPrepare` and then proceeds to a real send.
 */
function deps(rec: Recorder): DurableVideoPublishDependencies {
  const source: MaterializedVideoSource = {
    mediaId: "media-v1", ordinal: 0, bucketId: "generated-private",
    sourceObjectPath: "src/clip.mp4", objectPath: "dst/clip.mp4",
    contentType: "video/mp4", byteSize: 1024,
    checksumSha256: "c".repeat(64), fileName: "clip.mp4",
    file: new Blob([new Uint8Array(8)], { type: "video/mp4" }),
  };
  return {
    async inspect(input: DurableVideoPublishInput): Promise<DurableVideoPublishState> {
      return input.receipt.intentId === parentReceipt.intentId
        ? { kind: "delivery_unknown", evidence: { reason: "original_round" } }
        : { kind: "missing" };
    },
    async confirmPrepare(input: DurableVideoPublishInput) {
      // The production switch, reproduced exactly: a reconcile proof selects
      // v82, its absence keeps v78 byte-identical.
      if (input.reconcileCheckId) {
        rec.rpcCalls.push({
          fn: "publish_intent_confirm_prepare_v82",
          args: { p_reconcile_check_id: input.reconcileCheckId, p_intent: input.receipt.intentId },
        });
        return;
      }
      rec.rpcCalls.push({
        fn: "publish_intent_confirm_prepare_v78",
        args: { p_intent: input.receipt.intentId },
      });
    },
    async leaseMaterialization() {
      return { leaseToken: "lease-1", deliveryId: "delivery-1" };
    },
    async materializeSources() { return [source]; },
    async loadReadySources() { return [source]; },
    async settleItem() { return { deliveryReady: true }; },
    async claimReady() { return { claimToken: "claim-1", attempt: 2 }; },
    async startAttempt() {
      return { attemptId: "attempt-1", status: "started" as const, replayed: false };
    },
    async publishVideo() {
      rec.creates += 1;
      // The adapter's own result shape — `outcome` + `evidence`, not an HTTP
      // body. The dispatcher only reports `published` for `succeeded`, so
      // getting this wrong would silently turn a successful send into
      // `delivery_unknown` and V2 would be testing the wrong thing.
      return {
        outcome: "succeeded" as const,
        evidence: {
          stage: "published" as const,
          classification: "definite_success" as const,
          pinId: "pin-child-1",
          pinUrl: "https://pin/child-1",
          mediaId: "media-v1",
        },
      };
    },
    async settleAttempt() { /* terminal bookkeeping, not under test here */ },
  } as unknown as DurableVideoPublishDependencies;
}

function input(over: Partial<DurableVideoPublishInput>): DurableVideoPublishInput {
  return {
    uid: OWNER,
    receipt: parentReceipt,
    destination: {
      id: DEST_KEY, provider: "pinterest", socialConnectionId: CONN,
      boardId: BOARD, boardName: "B",
    },
    scheduleAt: DUE_AT,
    nowMs: Date.parse(DUE_AT) + 60_000,
    ...over,
  } as DurableVideoPublishInput;
}

(async () => {
  console.log("Video child retry (§2.2 G):");

  // ── V1 ─────────────────────────────────────────────────────────────────────
  await test("V1: no reconcile proof ⇒ v78, parent stays unknown, ZERO provider creates", async () => {
    const rec: Recorder = { rpcCalls: [], creates: 0 };
    const result = await dispatchV76PinterestVideo(input({}), deps(rec));
    assert.equal(result.outcome, "delivery_unknown",
      "the dispatcher early-returns on the unknown parent, as it always did");
    assert.equal(rec.creates, 0, `no provider create without a proof, saw ${rec.creates}`);
    assert.equal(rec.rpcCalls.length, 0,
      "and it does not even reach confirmPrepare — the early return is before it");
    console.log(`         V1 evidence: createVideoPin=${rec.creates}, rpc=${JSON.stringify(rec.rpcCalls.map(c => c.fn))}`);
  });

  // ── V2 ─────────────────────────────────────────────────────────────────────
  await test("V2: with a proof ⇒ v82 RPC carries the check id and the send happens ONCE", async () => {
    const rec: Recorder = { rpcCalls: [], creates: 0 };
    const child = childReceipt();
    const result = await dispatchV76PinterestVideo(
      input({ receipt: child, reconcileCheckId: CHECK_ID }), deps(rec));
    assert.equal(result.outcome, "published", `the child really publishes, got ${result.outcome}`);
    assert.equal(rec.creates, 1, `exactly one provider create, saw ${rec.creates}`);
    assert.equal(rec.rpcCalls[0]?.fn, "publish_intent_confirm_prepare_v82",
      `the v82 entrance is taken, saw ${rec.rpcCalls[0]?.fn}`);
    assert.equal(rec.rpcCalls[0]?.args.p_reconcile_check_id, CHECK_ID,
      "and the proof id is what it is handed");
    console.log(`         V2 evidence: createVideoPin=${rec.creates} via ${rec.rpcCalls[0]?.fn} (with the original send, the design's "createPin == 2")`);
  });

  // ── V3 ─────────────────────────────────────────────────────────────────────
  await test("V3: the child receipt satisfies every shape condition the RPC checks", async () => {
    const child = childReceipt();
    // migrate_v82:440-448
    assert.equal(child.onlyPending, true, "onlyPending must be exactly true");
    assert.deepEqual(child.mode, { kind: "now" }, "mode must be {kind:now}");
    // migrate_v82:450-454 — the singleton, despite the FAILED sibling.
    assert.deepEqual(child.dispatchDestinationIds, [DEST_KEY],
      `the dispatch set is the proof's destination alone, saw ${JSON.stringify(child.dispatchDestinationIds)}`);
    // migrate_v82:457 — lineage by TEXT intent id.
    assert.equal(child.priorIntentId, PARENT_INTENT_ID, "priorIntentId is the parent's text id");
    assert.notEqual(child.intentId, parentReceipt.intentId,
      "the child is a NEW intent, not the parent replayed");
    // The fingerprint must be the builder's own, over the final shape. A
    // receipt whose fingerprint was patched in afterwards is the failure this
    // whole construction exists to avoid.
    assert.equal(
      publishConfirmationFingerprint({ ...child }), child.fingerprint,
      "the fingerprint is self-consistent with the receipt it rides on",
    );
    console.log(`         V3 evidence: dispatch=${JSON.stringify(child.dispatchDestinationIds)} prior=${child.priorIntentId} fingerprint self-consistent`);
  });

  // ── V4 ─────────────────────────────────────────────────────────────────────
  await test("V4: the same proof derives the SAME child intent id (crash replay is safe)", async () => {
    assert.equal(childReceipt().intentId, childReceipt().intentId,
      "deterministic per proof — a replay reaches its own child, not a second one");
    const other = buildReconcileChildVideoReceipt({
      draftId: DRAFT, updatedAt: UPDATED_AT, scheduledAt: DUE_AT, payload: payload(),
      reconcileCheckId: "chk-abs-2", parentIntentId: PARENT_INTENT_ID, destinationId: DEST_KEY,
    });
    assert.notEqual(other.intentId, childReceipt().intentId,
      "a DIFFERENT proof derives a different child — one redemption each");
    console.log(`         V4 evidence: child=${childReceipt().intentId.slice(0, 40)}… stable across builds`);
  });

  // ── V5: a proof for a destination the draft no longer schedules ────────────
  await test("V5: a proof naming an unscheduled destination is refused, not redirected", async () => {
    assert.throws(() => buildReconcileChildVideoReceipt({
      draftId: DRAFT, updatedAt: UPDATED_AT, scheduledAt: DUE_AT, payload: payload(),
      reconcileCheckId: CHECK_ID, parentIntentId: PARENT_INTENT_ID,
      destinationId: "pinterest:conn-GONE",
    }), /reconcile_destination_not_scheduled/,
    "it must refuse rather than fall back to some other destination");
  });

  console.log(`\nVideo child retry: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
