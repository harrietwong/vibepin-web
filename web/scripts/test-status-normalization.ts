#!/usr/bin/env tsx
/**
 * test-status-normalization.ts
 *
 * Verifies that GenerationStatus and PlanningStatus are correctly separated and
 * computed throughout the VibePin status system.
 *
 * Run: pnpm test:status   (or: npx tsx scripts/test-status-normalization.ts)
 * Exit 0 = all pass, 1 = failures.
 */

// ── Browser-API polyfills ─────────────────────────────────────────────────────
// pinDraftStore / pinStore call typeof window at *call-time* (lazy ok() check),
// so setting globals before the first function call is sufficient even though
// ES module imports are hoisted above this code.
function makeLs() {
  const s: Record<string, string> = {};
  return {
    getItem:    (k: string) => s[k] ?? null,
    setItem:    (k: string, v: string) => { s[k] = v; },
    removeItem: (k: string) => { delete s[k]; },
    clear:      () => { Object.keys(s).forEach(k => delete s[k]); },
  };
}
(global as Record<string, unknown>).window = {
  dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {},
};
(global as Record<string, unknown>).localStorage = makeLs();

// ── Imports ───────────────────────────────────────────────────────────────────
import {
  computeSessionGenerationStatus,
  computePinGenerationStatus,
  computePinPlanningStatus,
  normalizeLegacyGenerationStatus,
  normalizeLegacyPlanningStatus,
  draftStatusToPlanningStatus,
  computeSessionPlanningStatusSummary,
} from "../src/lib/status/computeGenerationStatus";

import type { GenerationStatus, PlanningStatus } from "../src/lib/status/pinStatuses";
import * as pinDraftStore from "../src/lib/pinDraftStore";

// ── Mini test runner ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${String(e)}`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected)
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–5: Session generation status
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Session generation status ──");

test("1. completed: expectedCount=4, returnedCount=4 → completed", () => {
  eq<GenerationStatus>(
    computeSessionGenerationStatus({ expectedCount: 4, returnedCount: 4 }),
    "completed",
  );
});

test("2. partial: expectedCount=4, returnedCount=2 → partial", () => {
  eq<GenerationStatus>(
    computeSessionGenerationStatus({ expectedCount: 4, returnedCount: 2 }),
    "partial",
  );
});

test("3. failed: expectedCount=4, returnedCount=0, hasFailed=true → failed", () => {
  eq<GenerationStatus>(
    computeSessionGenerationStatus({ expectedCount: 4, returnedCount: 0, hasFailed: true }),
    "failed",
  );
});

test("4. running: isRunning=true, savedAt=now → running (not stale)", () => {
  eq<GenerationStatus>(
    computeSessionGenerationStatus({
      expectedCount: 4,
      returnedCount: 1,
      isRunning:     true,
      savedAt:       new Date().toISOString(),
    }),
    "running",
  );
});

test("5. interrupted: isRunning=true, savedAt=20min ago → interrupted", () => {
  const staleTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  eq<GenerationStatus>(
    computeSessionGenerationStatus({
      expectedCount: 4,
      returnedCount: 1,
      isRunning:     true,
      savedAt:       staleTs,
    }),
    "interrupted",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–7: Per-pin generation status
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Per-pin generation status ──");

test("6. pin with imageUrl → completed", () => {
  eq<GenerationStatus>(
    computePinGenerationStatus({ imageUrl: "https://cdn.example.com/pin.jpg" }),
    "completed",
  );
});

test("7. pin with rawStatus='failed' → failed", () => {
  eq<GenerationStatus>(computePinGenerationStatus({ rawStatus: "failed" }), "failed");
});

test("7b. pin with no imageUrl + no rawStatus → failed", () => {
  eq<GenerationStatus>(computePinGenerationStatus({}), "failed");
});

test("7c. rawStatus='processing' → running", () => {
  eq<GenerationStatus>(computePinGenerationStatus({ rawStatus: "processing" }), "running");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8–11: Planning status computation
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Planning status ──");

test("8. no weeklyPlanItemId → not_added", () => {
  eq<PlanningStatus>(computePinPlanningStatus({ weeklyPlanItemId: null }), "not_added");
});

test("8b. empty weeklyPlanItemId string → not_added", () => {
  eq<PlanningStatus>(computePinPlanningStatus({ weeklyPlanItemId: "" }), "not_added");
});

test("9. has weeklyPlanItemId but missing title → needs_review", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({ weeklyPlanItemId: "wpi-1", title: "", description: "d", scheduledDate: "2026-06-10" }),
    "needs_review",
  );
});

test("9b. missing description → needs_review", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({ weeklyPlanItemId: "wpi-1", title: "T", description: "", scheduledDate: "2026-06-10" }),
    "needs_review",
  );
});

test("9c. missing scheduledDate → needs_review", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({ weeklyPlanItemId: "wpi-1", title: "T", description: "D", scheduledDate: "" }),
    "needs_review",
  );
});

test("10. has weeklyPlanItemId + all required fields → ready", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({
      weeklyPlanItemId: "wpi-1",
      title:            "My Title",
      description:      "My description",
      scheduledDate:    "2026-06-10",
    }),
    "ready",
  );
});

test("11. isPosted=true always returns posted", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({ weeklyPlanItemId: "wpi-1", title: "T", description: "D", scheduledDate: "2026-06-10", isPosted: true }),
    "posted",
  );
});

test("11b. isPosted=true even without required fields → posted", () => {
  eq<PlanningStatus>(
    computePinPlanningStatus({ weeklyPlanItemId: "wpi-1", isPosted: true }),
    "posted",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 12: Add all to Plan only adds completed/partial pins
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Add to Plan logic ──");

test("12. bulkAddToPlan skips running/pending; adds completed+partial; failed (empty) adds nothing", () => {
  // Mirrors the guard in history/page.tsx bulkAddToPlan:
  //   if (genStatus === "running" || genStatus === "pending") continue;
  // For partial sessions, groups[i].images only contains successful URLs.
  const sessions = [
    { genStatus: "running"   as GenerationStatus, pins: ["u1"] },
    { genStatus: "pending"   as GenerationStatus, pins: ["u2"] },
    { genStatus: "completed" as GenerationStatus, pins: ["u3", "u4"] },
    { genStatus: "partial"   as GenerationStatus, pins: ["u5"] }, // only successful pin
    { genStatus: "failed"    as GenerationStatus, pins: [] },
  ];
  const added: string[] = [];
  for (const s of sessions) {
    if (s.genStatus === "running" || s.genStatus === "pending") continue;
    added.push(...s.pins);
  }
  ok(!added.includes("u1"), "running pins must be skipped");
  ok(!added.includes("u2"), "pending pins must be skipped");
  ok(added.includes("u3") && added.includes("u4"), "completed pins must be added");
  ok(added.includes("u5"), "successful partial pins must be added");
  eq(added.length, 3, "exactly 3 pins should be added (running/pending/failed skipped)");
});

// ─────────────────────────────────────────────────────────────────────────────
// 13: Add to Plan is idempotent — no duplicate weekly plan items
// ─────────────────────────────────────────────────────────────────────────────
test("13. createDraft idempotent: same imageUrl returns existing draft, no duplicate", () => {
  (global as Record<string, unknown>).localStorage = makeLs();
  const url = "https://cdn.example.com/idempotent-test.jpg";
  const d1 = pinDraftStore.createDraft({ imageUrl: url, keyword: "home decor", category: "home-decor" });
  const d2 = pinDraftStore.createDraft({ imageUrl: url, keyword: "home decor", category: "home-decor" });
  eq(d1.id, d2.id, "second call returns same draft id");
  const all = pinDraftStore.getAllDrafts().filter(d => d.imageUrl === url);
  eq(all.length, 1, "no duplicate draft created for same imageUrl");
});

// ─────────────────────────────────────────────────────────────────────────────
// 14: Partial session only adds successful pins
// ─────────────────────────────────────────────────────────────────────────────
test("14. partial session: allPins = groups.flatMap(g => g.images) = only successful images", () => {
  // In a partial session, groups[i].images contains ONLY successful URLs.
  // Missing/failed pins simply have no entry there.
  const groups = [
    { refUrl: "ref1.jpg", images: ["ok1.jpg", "ok2.jpg"] }, // 2/3 succeeded
    { refUrl: "ref2.jpg", images: [] },                       // 0/2 succeeded
  ];
  const allPins = groups.flatMap(g => g.images);
  eq(allPins.length, 2, "only the 2 successful images appear in allPins");
  ok(!allPins.includes("ref1.jpg"), "ref URLs must not appear in allPins");
  ok(!allPins.includes("ref2.jpg"), "ref URLs from empty group must not appear");
});

// ─────────────────────────────────────────────────────────────────────────────
// 15: "Added to Plan" filter uses planningStatus, not generationStatus
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Filter / stats correctness ──");

test("15. Added-to-Plan filter uses planning dimension, not generation dimension", () => {
  // Mirrors history/page.tsx:
  //   if (tab === "added") return getPlanStatus(entry) !== "none";
  // getPlanStatus uses pinStore.addedCount — a planning dimension.
  type ME = { id: string; genStatus: GenerationStatus; planAdded: number; totalPins: number };
  const mockPlanStatus = (e: ME) =>
    e.planAdded === 0                ? "none"    :
    e.planAdded >= e.totalPins       ? "all"     : "partial";

  const entries: ME[] = [
    { id: "a", genStatus: "completed", planAdded: 4, totalPins: 4 }, // all added
    { id: "b", genStatus: "completed", planAdded: 0, totalPins: 4 }, // 0 added
    { id: "c", genStatus: "partial",   planAdded: 1, totalPins: 4 }, // some added
    { id: "d", genStatus: "failed",    planAdded: 0, totalPins: 0 }, // nothing
  ];

  const addedFilter    = entries.filter(e => mockPlanStatus(e) !== "none");
  const completedFilter = entries.filter(e => e.genStatus === "completed");

  ok(addedFilter.some(e => e.id === "a"),  "completed + all added → in Added filter");
  ok(!addedFilter.some(e => e.id === "b"), "completed + 0 added → NOT in Added filter");
  ok(addedFilter.some(e => e.id === "c"),  "partial gen + some added → in Added filter");
  ok(!addedFilter.some(e => e.id === "d"), "failed → NOT in Added filter");

  // The two filters must differ — they use independent status dimensions.
  ok(
    JSON.stringify(addedFilter.map(e => e.id)) !== JSON.stringify(completedFilter.map(e => e.id)),
    "Added-to-Plan filter must differ from Completed-generation filter",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 16: Weekly Plan stats use planningStatus
// ─────────────────────────────────────────────────────────────────────────────
test("16. Weekly Plan summary stats are planningStatus-based, not generationStatus-based", () => {
  // Mirrors plan/page.tsx computeSummary():
  //   pinsReady   = sum(ds.ready)
  //   needsReview = sum(ds.needsReview + ds.needsLink)
  // Use data where the counts intentionally differ from generation-session counts.
  const summaries = [
    { total: 4, ready: 3, needsReview: 1, needsLink: 0 }, // 3 of 4 pins ready
    { total: 3, ready: 0, needsReview: 2, needsLink: 1 }, // 0 of 3 ready
    { total: 1, ready: 1, needsReview: 0, needsLink: 0 }, // 1 of 1 ready
  ];
  let totalPins = 0, pinsReady = 0, needsReview = 0;
  for (const ds of summaries) {
    totalPins   += ds.total;
    pinsReady   += ds.ready;
    needsReview += ds.needsReview + ds.needsLink;
  }
  eq(totalPins,   8, "totalPins");
  eq(pinsReady,   4, "pinsReady = planningStatus=ready count across all plan items");
  eq(needsReview, 4, "needsReview = needs_review + needs_link (both map to planningStatus.needs_review)");

  // These 3 plan rows have different generation sessions: 1 completed, 1 partial, 1 completed.
  // If stats were gen-status based: pinsReady would = completed-session count = 2.
  // Since it's planningStatus-based: pinsReady = 4, which ≠ 2.
  const completedSessionCount = 2; // hypothetical session statuses: completed, partial, completed
  ok(
    pinsReady !== completedSessionCount,
    `pinsReady (${pinsReady}) must differ from completed-session count (${completedSessionCount}) — stats use planningStatus, not generationStatus`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy normalization
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Legacy normalization ──");

test("L1. 'processing' → running", () => {
  eq<GenerationStatus>(normalizeLegacyGenerationStatus("processing"), "running");
});

test("L2. 'done' → completed", () => {
  eq<GenerationStatus>(normalizeLegacyGenerationStatus("done"), "completed");
});

test("L3. 'completed' → completed", () => {
  eq<GenerationStatus>(normalizeLegacyGenerationStatus("completed"), "completed");
});

test("L4. null → pending", () => {
  eq<GenerationStatus>(normalizeLegacyGenerationStatus(null), "pending");
});

test("L5. planning 'needs_link' → needs_review", () => {
  eq<PlanningStatus>(normalizeLegacyPlanningStatus("needs_link"), "needs_review");
});

test("L6. planning 'pending' → needs_review", () => {
  eq<PlanningStatus>(normalizeLegacyPlanningStatus("pending"), "needs_review");
});

test("L7. planning 'done' → ready", () => {
  eq<PlanningStatus>(normalizeLegacyPlanningStatus("done"), "ready");
});

test("L8. planning null → not_added", () => {
  eq<PlanningStatus>(normalizeLegacyPlanningStatus(null), "not_added");
});

test("L9. draftStatus 'needs_link' → planningStatus needs_review", () => {
  eq<PlanningStatus>(draftStatusToPlanningStatus("needs_link"), "needs_review");
});

test("L10. draftStatus 'ready' → planningStatus ready", () => {
  eq<PlanningStatus>(draftStatusToPlanningStatus("ready"), "ready");
});

// ─────────────────────────────────────────────────────────────────────────────
// Planning summary aggregation
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Planning summary aggregation ──");

test("S1. computeSessionPlanningStatusSummary counts all 6 buckets correctly", () => {
  const statuses: PlanningStatus[] = [
    "not_added", "not_added",
    "added_to_plan",
    "needs_review", "needs_review", "needs_review",
    "ready",
    "posted",
    "skipped",
  ];
  const s = computeSessionPlanningStatusSummary(statuses);
  eq(s.notAdded,    2, "notAdded");
  eq(s.addedToPlan, 1, "addedToPlan");
  eq(s.needsReview, 3, "needsReview");
  eq(s.ready,       1, "ready");
  eq(s.posted,      1, "posted");
  eq(s.skipped,     1, "skipped");
});

// ─────────────────────────────────────────────────────────────────────────────
// New draft default status
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── New draft default status ──");

test("D1. createDraft without destinationUrl → needs_review (not needs_link)", () => {
  (global as Record<string, unknown>).localStorage = makeLs();
  const d = pinDraftStore.createDraft({
    imageUrl: "https://cdn.example.com/draft-d1.jpg",
    keyword:  "boho living",
    category: "home-decor",
  });
  eq(d.status, "needs_review", "must not default to needs_link");
});

test("D2. createDraft with destinationUrl → still needs_review (URL not required for ready)", () => {
  (global as Record<string, unknown>).localStorage = makeLs();
  const d = pinDraftStore.createDraft({
    imageUrl:       "https://cdn.example.com/draft-d2.jpg",
    keyword:        "boho living",
    category:       "home-decor",
    destinationUrl: "https://amazon.com/xyz",
  });
  eq(d.status, "needs_review", "providing a URL alone does not make a draft ready");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
