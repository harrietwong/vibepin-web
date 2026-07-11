/**
 * Single-output retry scope regression tests.
 *
 * Reproduces the critical bug ("Try again on one failed output regenerated the whole
 * batch and reverted the successful sibling") at the reducer level, and locks in the
 * fix: retry touches ONLY the target output slot.
 *
 * Run: npx tsx scripts/test-retry-scope.ts
 */
import {
  markOutputRetrying, applyRetrySuccess, applyRetryFailure, recomputeGroupStatus,
  getBatchStatus, planSingleOutputRetry, outputSlotId, retryIdempotencyKey,
  SINGLE_OUTPUT_RETRY_COUNT, type RetryGroupLike,
} from "../src/lib/studio/retryScope";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

// Minimal output item; identity (===) is what proves "sibling never mutated".
type Item = { id: string; url: string; planningStatus: string };
type Group = RetryGroupLike<Item>;

// Batch: output 0 completed, output 1 failed (the reported scenario).
function oneSuccessOneFail(): Group {
  return {
    items: [{ id: "out-0", url: "https://cdn/out-0.png", planningStatus: "added" }],
    expectedCount: 2,
    status: "partial",
  };
}

console.log("\n=== Single-output retry scope ===\n");

// ── Test 1 — One success, one failure → retry only output 1 ─────────────────────
{
  const g0 = oneSuccessOneFail();
  const sibling = g0.items[0];
  const retrying = markOutputRetrying(g0, /* outputIndex */ 1);

  check("T1: retry plan forces outputCount = 1", planSingleOutputRetry(1).outputCount === 1 && SINGLE_OUTPUT_RETRY_COUNT === 1);
  check("T1: target outputIndex preserved on the plan", planSingleOutputRetry(1).targetOutputIndex === 1);
  check("T1: successful sibling object identity is UNCHANGED while retrying",
    retrying.items.length === 1 && retrying.items[0] === sibling);
  check("T1: sibling image URL unchanged", retrying.items[0].url === "https://cdn/out-0.png");
  check("T1: group is NOT set to generating (sibling never regenerates)", retrying.status === "partial");
  check("T1: only slot 1 marked retrying", JSON.stringify(retrying.retryingSlots) === JSON.stringify([1]));
}

// ── Test 2 — Retry succeeds → replace only the failed slot ──────────────────────
{
  const g0 = markOutputRetrying(oneSuccessOneFail(), 1);
  const sibling = g0.items[0];
  const merged = applyRetrySuccess(g0, 1, [{ id: "out-1", url: "https://cdn/out-1-new.png", planningStatus: "not_added" }]);

  check("T2: sibling output 0 remains, identity unchanged", merged.items[0] === sibling);
  check("T2: new successful output appended (no extra outputs)", merged.items.length === 2 && merged.items[1].id === "out-1");
  check("T2: batch becomes completed", merged.status === "done");
  check("T2: retrying flag cleared for the slot", (merged.retryingSlots ?? []).length === 0);
}

// ── Test 3 — Retry fails → only target reverts, sibling safe ────────────────────
{
  const g0 = markOutputRetrying(oneSuccessOneFail(), 1);
  const sibling = g0.items[0];
  const reverted = applyRetryFailure(g0, 1);

  check("T3: sibling output 0 unchanged + still present (downloadable)", reverted.items.length === 1 && reverted.items[0] === sibling);
  check("T3: batch shows partial completion (not failed)", reverted.status === "partial");
  check("T3: target slot retry flag cleared (returns to failed slot)", (reverted.retryingSlots ?? []).length === 0);
}

// ── Test 4 — Double click → exactly one retry / one new output ──────────────────
{
  // markOutputRetrying is idempotent on the slot set; the component's retryGuard keys
  // off the SAME slotId so the 2nd click is dropped before any request is made.
  const slotId = outputSlotId("batch-1", 0, 1);
  const guard = new Set<string>();
  let requests = 0;
  function attempt() {
    if (guard.has(slotId)) return;     // duplicate-click guard (mirrors retryGuard.current)
    guard.add(slotId);
    requests++;
  }
  attempt(); attempt(); attempt();      // 3 rapid clicks
  check("T4: exactly one retry request for repeated clicks", requests === 1);
  check("T4: marking the same slot twice does not duplicate it",
    JSON.stringify(markOutputRetrying(markOutputRetrying(oneSuccessOneFail(), 1), 1).retryingSlots) === JSON.stringify([1]));
  check("T4: idempotency key is stable per (slot, attempt)",
    retryIdempotencyKey(slotId, 2) === "retry:batch-1:g0:o1:2");
}

// ── Test 5 — Reload during retry → completed output persists, no batch-wide spinner
{
  // After reload, only persisted COMPLETED images exist; status derives from them.
  const restored: Group = { items: [{ id: "out-0", url: "https://cdn/out-0.png", planningStatus: "added" }], expectedCount: 2, status: "partial" };
  check("T5: restored status derives from completed count (partial, not generating)",
    recomputeGroupStatus(restored.items.length, restored.expectedCount) === "partial");
  check("T5: no retryingSlots inferred for a freshly restored batch", (restored.retryingSlots ?? []).length === 0);
}

// ── Test 6 — Fully-failed batch: retry one slot generates ONE, not the batch ─────
{
  const allFailed: Group = { items: [], expectedCount: 2, status: "failed" };
  check("T6: retry plan still forces outputCount = 1 for a fully-failed batch",
    planSingleOutputRetry(1).outputCount === 1);
  const afterOne = applyRetrySuccess(markOutputRetrying(allFailed, 1), 1, [{ id: "out-new", url: "https://cdn/new.png", planningStatus: "not_added" }]);
  check("T6: only one output is added (the other stays failed)", afterOne.items.length === 1 && afterOne.status === "partial");
}

// ── Derived batch status (Part H) ───────────────────────────────────────────────
console.log("\n=== Derived batch status ===\n");
check("status: partially_generating when any output generating/retrying",
  getBatchStatus([{ status: "completed" }, { status: "generating" }]) === "partially_generating");
check("status: completed when all completed",
  getBatchStatus([{ status: "completed" }, { status: "completed" }]) === "completed");
check("status: partially_completed when some completed, rest failed",
  getBatchStatus([{ status: "completed" }, { status: "failed" }]) === "partially_completed");
check("status: failed when all failed",
  getBatchStatus([{ status: "failed" }, { status: "failed" }]) === "failed");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
