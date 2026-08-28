/**
 * Unit tests for the Insights report layer (pure: no network, no database).
 *
 * `reportBuilder.ts` is the only module under test — it is where every decision a
 * report generator has to make lives, deliberately separated from
 * `reportStore.ts` (server-only, DB-backed, cannot load under tsx). `paidGate.ts`
 * is also pure and is exercised here for the shape it produces.
 *
 * Five things this file is careful to prove, because each is the kind of bug that
 * does not throw:
 *
 * **ISO week-year boundaries.** A week belongs to the year that owns its Thursday,
 * not the year `getFullYear()` would guess from the date itself. Getting this wrong
 * silently files a report under a `period_key` nothing else ever looks at.
 *
 * **Scorecard windows are inclusive on both ends.** T+7 is [7, 9] days, T+30 is
 * [30, 36] days. Off-by-one here either fires a scorecard a day early (nothing to
 * measure yet) or skips a Pin's only chance at one.
 *
 * **The hash is key-order independent and value-sensitive.** It is the entire
 * regeneration contract: two snapshots built from identical content by two code
 * paths must hash identically, and any real change must hash differently.
 *
 * **Regeneration never overwrites.** Same hash is a no-op; a changed hash inserts a
 * new version and supersedes the old row — the decision layer that keeps a "sent"
 * report immutable.
 *
 * **The paid gate ships no diagnosis, not a hidden one.** A free payload is scanned
 * recursively for the literal keys `headline` / `findings` / `recommendations` /
 * `evidence` — the scanner is proven first against a payload built to contain them,
 * so a pass on the locked payload is not just an empty object accident.
 *
 * Run: npm run test:insights-reports
 */

import assert from "node:assert/strict";
import {
  ageInDays,
  buildScorecardReport,
  buildWeeklyReport,
  evidenceHashOf,
  hasScorecardMeasurement,
  headlineOf,
  isoWeekKey,
  isWeeklyDue,
  regenerationDecision,
  SCORECARD_WINDOWS,
  scorecardDueKind,
  stableStringify,
  type CurrentReportRow,
} from "../src/lib/insights/reportBuilder";
import type { Evidence, EvidenceSet } from "../src/lib/insights/evidence";
import type { InsightsDiagnosis } from "../src/lib/insights/recommendations";
import type { InsightReportSnapshot, ScorecardMetrics } from "../src/lib/insights/reportTypes";
import {
  INSIGHTS_DIAGNOSIS_LOCKED,
  lockDashboardDiagnosis,
} from "../src/lib/insights/paidGate";
import type { InsightsContent, InsightsDashboard } from "../src/lib/insights/types";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const NOW = new Date("2026-08-27T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// ── fixtures ─────────────────────────────────────────────────────────────────

function evidenceRow(overrides: Partial<Evidence> & { kind: Evidence["kind"] }): Evidence {
  return {
    id: overrides.kind,
    value: 10,
    baseline: 5,
    n: 10,
    eligible_n: 10,
    total_n: 10,
    confidence: "directional",
    details: {},
    ...overrides,
  };
}

function evidenceSet(overrides: Partial<EvidenceSet> = {}): EvidenceSet {
  return {
    ruleVersion: "insights-rules-1",
    thresholdVersion: "insights-thresholds-1",
    keywordSetVersion: 3,
    keywordSetHash: "hash-abc",
    category: "home-decor",
    account: [evidenceRow({ kind: "A1" })],
    byPin: new Map<string, Evidence[]>(),
    sample: {
      totalPins: 12,
      comparablePins: 8,
      cohorts: 2,
      ageBasis: "lifetime",
      observedDays: 28,
    },
    ...overrides,
  };
}

function diagnosis(overrides: Partial<InsightsDiagnosis> = {}): InsightsDiagnosis {
  return {
    headline: { key: "insights.recommendation.headline.f2" },
    findings: [
      { evidenceId: "F2", kind: "F2", confidence: "directional", text: { key: "insights.evidence.f2" } },
    ],
    recommendations: [
      {
        id: "rec-1",
        observationIds: ["F2"],
        keep: { key: "insights.recommendation.keep.f2" },
        change: { variable: "hook", phrasing: { key: "insights.recommendation.change.f2" } },
        test: { key: "insights.recommendation.test.f2" },
      },
    ],
    confidence: "directional",
    ruleVersion: "insights-rules-1",
    thresholdVersion: "insights-thresholds-1",
    keywordSetVersion: 3,
    category: "home-decor",
    sampleCaveat: { key: "insights.evidence.caveat.lifetime" },
    ...overrides,
  };
}

// ── ISO week-year ────────────────────────────────────────────────────────────

test("isoWeekKey: a Monday whose Thursday falls in January belongs to next year's W01", () => {
  // 2025-12-29 is a Monday; its ISO week's Thursday is 2026-01-01.
  assert.equal(isoWeekKey(new Date("2025-12-29T00:00:00.000Z")), "2026-W01");
});

test("isoWeekKey: a January date whose Thursday falls in December belongs to the previous year's final week", () => {
  // 2027-01-01 is a Friday; its ISO week's Thursday is 2026-12-31, so it is
  // filed under the PREVIOUS calendar year, week 53 (2026 has 53 ISO weeks).
  assert.equal(isoWeekKey(new Date("2027-01-01T00:00:00.000Z")), "2026-W53");
});

test("isoWeekKey: the Monday and Sunday of the same ISO week share a key", () => {
  const monday = isoWeekKey(new Date("2026-08-24T00:00:00.000Z"));
  const sunday = isoWeekKey(new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(monday, "2026-W35");
  assert.equal(sunday, "2026-W35");
  assert.equal(monday, sunday);
});

test("isoWeekKey: an ordinary midyear date uses the calendar year", () => {
  assert.equal(isoWeekKey(new Date("2026-01-05T00:00:00.000Z")), "2026-W02");
});

// ── weekly due (Monday-only unless forced) ──────────────────────────────────

test("isWeeklyDue: true only on Monday UTC, unless forced", () => {
  const monday = new Date("2026-08-24T00:00:00.000Z");
  const tuesday = new Date("2026-08-25T00:00:00.000Z");
  const sunday = new Date("2026-08-30T23:59:59.000Z");
  assert.equal(isWeeklyDue(monday), true);
  assert.equal(isWeeklyDue(tuesday), false);
  assert.equal(isWeeklyDue(sunday), false);
  assert.equal(isWeeklyDue(tuesday, true), true, "force overrides the day-of-week gate");
  assert.equal(isWeeklyDue(sunday, false), false, "force defaults to false, never on by accident");
});

// ── scorecard due windows ────────────────────────────────────────────────────

test("SCORECARD_WINDOWS: T+7 is [7, 9] and T+30 is [30, 36]", () => {
  assert.deepEqual(SCORECARD_WINDOWS.scorecard_t7, { minDays: 7, maxDays: 9, periodKey: "T7" });
  assert.deepEqual(SCORECARD_WINDOWS.scorecard_t30, { minDays: 30, maxDays: 36, periodKey: "T30" });
});

test("scorecardDueKind: T+7 window boundaries are inclusive on both ends", () => {
  assert.equal(scorecardDueKind(daysAgo(6), NOW), null, "day 6 is too young");
  assert.equal(scorecardDueKind(daysAgo(7), NOW), "scorecard_t7", "day 7 opens the window");
  assert.equal(scorecardDueKind(daysAgo(8), NOW), "scorecard_t7");
  assert.equal(scorecardDueKind(daysAgo(9), NOW), "scorecard_t7", "day 9 closes the window");
  assert.equal(scorecardDueKind(daysAgo(10), NOW), null, "day 10 is past the window");
});

test("scorecardDueKind: T+30 window boundaries are inclusive on both ends", () => {
  assert.equal(scorecardDueKind(daysAgo(29), NOW), null, "day 29 is too young");
  assert.equal(scorecardDueKind(daysAgo(30), NOW), "scorecard_t30", "day 30 opens the window");
  assert.equal(scorecardDueKind(daysAgo(33), NOW), "scorecard_t30");
  assert.equal(scorecardDueKind(daysAgo(36), NOW), "scorecard_t30", "day 36 closes the window");
  assert.equal(scorecardDueKind(daysAgo(37), NOW), null, "day 37 is past the window");
});

test("scorecardDueKind: the gap between windows (10..29) and no publish date are both not-due", () => {
  assert.equal(scorecardDueKind(daysAgo(15), NOW), null);
  assert.equal(scorecardDueKind(null, NOW), null);
});

test("ageInDays: whole days, and null when there is no publish date or it is unparseable", () => {
  assert.equal(ageInDays(daysAgo(7), NOW), 7);
  assert.equal(ageInDays(null, NOW), null);
  assert.equal(ageInDays("not-a-date", NOW), null);
});

test("hasScorecardMeasurement: zero counts as measured, null does not; only null blocks it", () => {
  const zeroed: ScorecardMetrics = { impressions: 0, saves: null, pinClicks: null, outboundClicks: null };
  const allNull: ScorecardMetrics = { impressions: null, saves: null, pinClicks: null, outboundClicks: null };
  assert.equal(hasScorecardMeasurement(zeroed), true, "a measured zero is a finding, not an absence");
  assert.equal(hasScorecardMeasurement(allNull), false);
});

// ── stable serialization + hash ──────────────────────────────────────────────

test("stableStringify: object key order does not affect the output, at any depth", () => {
  const a = { schema: "s1", content: { headline: "h", meta: { x: 1, y: 2 } } };
  const b = { content: { meta: { y: 2, x: 1 }, headline: "h" }, schema: "s1" };
  assert.equal(stableStringify(a), stableStringify(b));
});

test("stableStringify: array order IS preserved (findings are ranked)", () => {
  const a = { list: [1, 2, 3] };
  const b = { list: [3, 2, 1] };
  assert.notEqual(stableStringify(a), stableStringify(b));
});

test("stableStringify: a changed value changes the output", () => {
  const a = { headline: "h1" };
  const b = { headline: "h2" };
  assert.notEqual(stableStringify(a), stableStringify(b));
});

function weeklySnapshot(diag: InsightsDiagnosis, set: EvidenceSet): InsightReportSnapshot {
  return buildWeeklyReport({ set, diagnosis: diag, now: NOW, dataThrough: daysAgo(0) }).snapshot;
}

test("evidenceHashOf: identical content built with different key insertion order hashes the same", () => {
  const set = evidenceSet();
  // Build the same diagnosis twice, assembling the object literal with a
  // different property order each time, to prove the hash does not leak
  // JS's key-insertion order.
  const diagA = diagnosis();
  const diagB: InsightsDiagnosis = {
    sampleCaveat: diagA.sampleCaveat,
    category: diagA.category,
    keywordSetVersion: diagA.keywordSetVersion,
    thresholdVersion: diagA.thresholdVersion,
    ruleVersion: diagA.ruleVersion,
    confidence: diagA.confidence,
    recommendations: diagA.recommendations,
    findings: diagA.findings,
    headline: diagA.headline,
  };
  const snapshotA = weeklySnapshot(diagA, set);
  const snapshotB = weeklySnapshot(diagB, set);
  assert.equal(evidenceHashOf(snapshotA), evidenceHashOf(snapshotB));
});

test("evidenceHashOf: any content value change changes the hash", () => {
  const set = evidenceSet();
  const base = weeklySnapshot(diagnosis(), set);
  const changedHeadline = weeklySnapshot(diagnosis({ headline: { key: "insights.recommendation.headline.f1" } }), set);
  const changedFindingText = weeklySnapshot(
    diagnosis({
      findings: [
        { evidenceId: "F2", kind: "F2", confidence: "directional", text: { key: "insights.evidence.f2.other" } },
      ],
    }),
    set,
  );
  assert.notEqual(evidenceHashOf(base), evidenceHashOf(changedHeadline));
  assert.notEqual(evidenceHashOf(base), evidenceHashOf(changedFindingText));
  assert.notEqual(evidenceHashOf(changedHeadline), evidenceHashOf(changedFindingText));
});

test("evidenceHashOf: meta (dataThrough) is excluded — a moving collection timestamp does not change the hash", () => {
  const set = evidenceSet();
  const early = buildWeeklyReport({ set, diagnosis: diagnosis(), now: NOW, dataThrough: daysAgo(3) }).snapshot;
  const later = buildWeeklyReport({ set, diagnosis: diagnosis(), now: NOW, dataThrough: daysAgo(0) }).snapshot;
  assert.notEqual(early.meta.dataThrough, later.meta.dataThrough, "sanity: meta really did differ");
  assert.equal(evidenceHashOf(early), evidenceHashOf(later));
});

test("evidenceHashOf: same content under a different period key hashes differently", () => {
  const set = evidenceSet();
  const weekOne = buildWeeklyReport({ set, diagnosis: diagnosis(), now: new Date("2026-08-24T00:00:00.000Z"), dataThrough: null });
  const weekTwo = buildWeeklyReport({ set, diagnosis: diagnosis(), now: new Date("2026-08-31T00:00:00.000Z"), dataThrough: null });
  assert.notEqual(weekOne.snapshot.periodKey, weekTwo.snapshot.periodKey);
  assert.notEqual(weekOne.evidenceHash, weekTwo.evidenceHash);
});

// ── buildScorecardReport sanity (feeds the hash + regeneration tests below) ──

function scorecardRecord(overrides: { metrics?: Partial<ScorecardMetrics>; kind?: "scorecard_t7" | "scorecard_t30" } = {}) {
  const set = evidenceSet();
  const metrics: ScorecardMetrics = {
    impressions: 100,
    saves: 4,
    pinClicks: 2,
    outboundClicks: 1,
    ...overrides.metrics,
  };
  return buildScorecardReport({
    kind: overrides.kind ?? "scorecard_t7",
    subject: {
      contentId: "pin-1",
      draftId: "draft-1",
      title: "A pantry shelf",
      publishedAt: daysAgo(7),
      postUrl: "https://pinterest.com/pin/pin-1",
    },
    pinEvidence: [evidenceRow({ id: "C1:pin-1", kind: "C1" })],
    metrics,
    set,
    accountHeadline: { key: "insights.recommendation.headline.f2" },
    now: NOW,
    dataThrough: daysAgo(0),
  });
}

test("buildScorecardReport: identical metrics hash the same, a changed metric hashes differently", () => {
  const a = scorecardRecord();
  const b = scorecardRecord();
  const changed = scorecardRecord({ metrics: { saves: 40 } });
  assert.equal(a.evidenceHash, b.evidenceHash);
  assert.notEqual(a.evidenceHash, changed.evidenceHash);
});

// ── regeneration decision ────────────────────────────────────────────────────

test("regenerationDecision: no current row inserts version 1 with nothing to supersede", () => {
  const decision = regenerationDecision(null, "hash-1");
  assert.deepEqual(decision, { action: "insert", version: 1, supersedeId: null });
});

test("regenerationDecision: identical hash is a no-op", () => {
  const current: CurrentReportRow = { id: "row-1", version: 3, evidenceHash: "hash-1" };
  const decision = regenerationDecision(current, "hash-1");
  assert.deepEqual(decision, { action: "noop" });
});

test("regenerationDecision: a changed hash inserts version+1 and supersedes the previous row", () => {
  const current: CurrentReportRow = { id: "row-1", version: 3, evidenceHash: "hash-old" };
  const decision = regenerationDecision(current, "hash-new");
  assert.deepEqual(decision, { action: "insert", version: 4, supersedeId: "row-1" });
});

test("regenerationDecision: end to end — same evidence twice is a no-op, changed evidence versions up", () => {
  const record1 = scorecardRecord();
  const record2 = scorecardRecord();
  const record3 = scorecardRecord({ metrics: { saves: 99 } });

  const afterFirstWrite: CurrentReportRow = { id: "row-1", version: 1, evidenceHash: record1.evidenceHash };
  const secondDecision = regenerationDecision(afterFirstWrite, record2.evidenceHash);
  assert.deepEqual(secondDecision, { action: "noop" }, "regenerating from identical evidence writes nothing");

  const thirdDecision = regenerationDecision(afterFirstWrite, record3.evidenceHash);
  assert.deepEqual(thirdDecision, { action: "insert", version: 2, supersedeId: "row-1" });
});

test("headlineOf: reads the weekly headline and the scorecard's account headline", () => {
  const weekly = weeklySnapshot(diagnosis(), evidenceSet());
  assert.equal(headlineOf(weekly).key, "insights.recommendation.headline.f2");

  const scorecard = scorecardRecord();
  assert.equal(headlineOf(scorecard.snapshot).key, "insights.recommendation.headline.f2");
});

// ── paid-gate shaping ─────────────────────────────────────────────────────────

/**
 * Every object key found anywhere inside `value`, at any depth, through both
 * plain objects and arrays.
 */
function allKeysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeysDeep(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      allKeysDeep(nested, out);
    }
  }
  return out;
}

const FORBIDDEN_DIAGNOSIS_KEYS = ["headline", "findings", "recommendations", "evidence"];

function contentRow(overrides: Partial<InsightsContent> & { id: string; diagnosis: string }): InsightsContent {
  return {
    title: "A pantry shelf",
    imageUrl: null,
    postUrl: null,
    publishedAt: daysAgo(7),
    format: "image",
    metrics: { views: 10, interactions: 2, saves: 1, shares: 0, websiteClicks: null, trafficRate: null },
    websiteClickAvailability: "unavailable",
    ...overrides,
  };
}

function dashboardWithDiagnosis(diag: InsightsDashboard["diagnosis"]): InsightsDashboard {
  return {
    platform: "pinterest",
    scope: "account",
    connectionState: "ready",
    account: { id: "acct-1", name: "Studio", username: "studio" },
    range: { startDate: daysAgo(28).slice(0, 10), endDate: daysAgo(0).slice(0, 10), days: 28 },
    summary: { views: 100, interactions: 10, saves: 4, shares: 1, websiteClicks: 2, trafficRate: 0.02 },
    daily: [],
    content: [contentRow({ id: "pin-1", diagnosis: "insights.diagnosis.notCollected" })],
    availability: { views: "account_level", websiteClicks: "account_level", message: "" },
    collection: null,
    diagnosis: diag,
    latestAvailableAt: daysAgo(0),
    syncedAt: daysAgo(0),
    warning: null,
  };
}

test("sanity: the deep-key scanner actually finds forbidden keys when they are present", () => {
  // A payload deliberately shaped like a report snapshot's content, so the scanner
  // is proven against something structurally close to what would leak — not just
  // against a top-level property.
  const decoy = {
    weekly: {
      headline: { key: "insights.recommendation.headline.f2" },
      findings: [{ evidenceId: "F2" }],
      recommendations: [{ id: "rec-1" }],
      evidence: [{ id: "A1" }],
    },
  };
  const found = allKeysDeep(decoy);
  for (const key of FORBIDDEN_DIAGNOSIS_KEYS) assert.ok(found.has(key), `scanner failed to find "${key}"`);
});

test("paid gate: a free (locked) dashboard payload contains none of headline/findings/recommendations/evidence, at any depth", () => {
  const paidDashboard = dashboardWithDiagnosis(diagnosis());
  const lockedDashboard = lockDashboardDiagnosis(paidDashboard);

  assert.deepEqual(lockedDashboard.diagnosis, INSIGHTS_DIAGNOSIS_LOCKED);
  const foundKeys = allKeysDeep(lockedDashboard);
  for (const key of FORBIDDEN_DIAGNOSIS_KEYS) {
    assert.equal(foundKeys.has(key), false, `locked payload leaked the "${key}" key`);
  }
});

test("paid gate: a paid (unlocked) dashboard payload does carry headline/findings/recommendations", () => {
  const paidDashboard = dashboardWithDiagnosis(diagnosis());
  const foundKeys = allKeysDeep(paidDashboard);
  assert.ok(foundKeys.has("headline"));
  assert.ok(foundKeys.has("findings"));
  assert.ok(foundKeys.has("recommendations"));
});

test("paid gate: locking blanks per-row diagnosis text but keeps data-state rows intact", () => {
  const paidDashboard: InsightsDashboard = {
    ...dashboardWithDiagnosis(diagnosis()),
    content: [
      contentRow({ id: "pin-1", diagnosis: "insights.diagnosis.notCollected" }),
      contentRow({ id: "pin-2", diagnosis: "insights.diagnosis.someReading" }),
    ],
  };
  const locked = lockDashboardDiagnosis(paidDashboard);
  assert.equal(locked.content[0]?.diagnosis, "insights.diagnosis.notCollected", "data-state row survives the gate");
  assert.equal(locked.content[1]?.diagnosis, "", "a reading row is blanked, not translated to the client");
});

test("paid gate: locking never mutates the input dashboard", () => {
  const paidDashboard = dashboardWithDiagnosis(diagnosis());
  const before = JSON.stringify(paidDashboard);
  lockDashboardDiagnosis(paidDashboard);
  assert.equal(JSON.stringify(paidDashboard), before);
});

console.log(`\n${passed} Insights report-layer tests passed.`);
