/**
 * Unit tests for the /admin/creative-intelligence pure aggregation口径
 * (lib/creativeIntelligenceMetrics.ts) and the judge-calibration helpers
 * (lib/judgeCalibration.ts).
 * Run: npx tsx scripts/test-creative-intelligence-metrics.ts   (from web/)
 */

import assert from "node:assert";
import {
  buildRateCards,
  FUNNEL_EVENTS,
  OVERALL_BUCKETS,
  ratePct,
  summarizeJudgedPayloads,
} from "../src/lib/creativeIntelligenceMetrics";
import {
  buildCalibrationNote,
  buildCalibrationSourceId,
  parseCalibrationNote,
  usableCalibrationImageUrl,
} from "../src/lib/judgeCalibration";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── ratePct ─────────────────────────────────────────────────────────────────────

test("ratePct: normal ratio, one decimal", () => {
  assert.equal(ratePct(1, 3), 33.3);
  assert.equal(ratePct(50, 100), 50);
});

test("ratePct: zero/absent denominator → null (never a fabricated 0%)", () => {
  assert.equal(ratePct(5, 0), null);
  assert.equal(ratePct(5, null), null);
  assert.equal(ratePct(undefined, 10), null);
});

test("ratePct: can exceed 100% (events are not strictly 1:1)", () => {
  assert.equal(ratePct(12, 10), 120);
});

// ── summarizeJudgedPayloads ─────────────────────────────────────────────────────

test("judge summary: counts verdicts and buckets overalls", () => {
  const d = summarizeJudgedPayloads([
    { verdict: "ok", overall: 85 },
    { verdict: "ok", overall: 61 },
    { verdict: "borderline", overall: 55 },
    { verdict: "invalid", overall: 12 },
  ]);
  assert.equal(d.total, 4);
  assert.deepEqual(d.verdictCounts, { ok: 2, borderline: 1, invalid: 1 });
  assert.equal(d.verdictTotal, 4);
  assert.equal(d.overallTotal, 4);
  const byLabel = Object.fromEntries(d.overallBuckets.map(b => [b.label, b.count]));
  assert.equal(byLabel["80-100"], 1);
  assert.equal(byLabel["60-79"], 1);
  assert.equal(byLabel["40-59"], 1);
  assert.equal(byLabel["0-19"], 1);
  assert.equal(byLabel["20-39"], 0);
});

test("judge summary: malformed rows excluded from their denominators, never guessed", () => {
  const d = summarizeJudgedPayloads([
    { verdict: "ok" },                       // no overall → verdict counted, histogram not
    { verdict: "weird", overall: 70 },       // unknown verdict → histogram counted, verdict not
    { overall: "70" },                       // string overall → neither
    null,
    undefined,
  ]);
  assert.equal(d.verdictTotal, 1);
  assert.equal(d.overallTotal, 1);
  assert.equal(d.verdictCounts.ok, 1);
  assert.equal(d.total, 3, "only object payloads count toward total");
});

test("judge summary: overall clamped into 0-100 buckets", () => {
  const d = summarizeJudgedPayloads([
    { verdict: "ok", overall: 105 },
    { verdict: "ok", overall: -3 },
  ]);
  const byLabel = Object.fromEntries(d.overallBuckets.map(b => [b.label, b.count]));
  assert.equal(byLabel["80-100"], 1);
  assert.equal(byLabel["0-19"], 1);
});

test("judge summary: empty input → all zeros, buckets present", () => {
  const d = summarizeJudgedPayloads([]);
  assert.equal(d.total, 0);
  assert.equal(d.verdictTotal, 0);
  assert.equal(d.overallBuckets.length, OVERALL_BUCKETS.length);
  assert.ok(d.overallBuckets.every(b => b.count === 0));
});

// ── buildRateCards (the report's documented denominators) ──────────────────────

test("rate cards: direction = direction_selected/image_analysis_ready; reference = reference_selected/direction_selected", () => {
  const cards = buildRateCards({
    image_analysis_ready: 40,
    direction_selected: 10,
    reference_selected: 5,
  });
  const dir = cards.find(c => c.id === "direction_rate")!;
  const ref = cards.find(c => c.id === "reference_rate")!;
  assert.equal(dir.pct, 25);
  assert.equal(dir.basis, "direction_selected / image_analysis_ready");
  assert.equal(ref.pct, 50);
  assert.equal(ref.basis, "reference_selected / direction_selected");
});

test("rate cards: empty counts → n/a (null), zero numerators/denominators surfaced", () => {
  const cards = buildRateCards({});
  assert.ok(cards.every(c => c.pct === null));
  assert.ok(cards.every(c => c.numerator === 0 && c.denominator === 0));
});

test("funnel event list is the PRD order, ending in draft_published", () => {
  assert.equal(FUNNEL_EVENTS[0], "image_analysis_ready");
  assert.equal(FUNNEL_EVENTS[FUNNEL_EVENTS.length - 1], "draft_published");
  assert.equal(FUNNEL_EVENTS.length, 8);
});

// ── judge calibration helpers ───────────────────────────────────────────────────

test("calibration: source id is namespaced and dedup-keyed on draftId+judgeVersion", () => {
  assert.equal(buildCalibrationSourceId("pd_1", "qj_v1"), "judge_calibration:pd_1:qj_v1");
});

test("calibration: note round-trips through build/parse", () => {
  const raw = buildCalibrationNote({ agreement: "disagree", judgeVersion: "qj_v1", verdict: "invalid", overall: 22, draftId: "pd_9" });
  const parsed = parseCalibrationNote(raw)!;
  assert.equal(parsed.source, "judge_calibration");
  assert.equal(parsed.agreement, "disagree");
  assert.equal(parsed.judgeVersion, "qj_v1");
  assert.equal(parsed.verdict, "invalid");
  assert.equal(parsed.overall, 22);
  assert.equal(parsed.draftId, "pd_9");
});

test("calibration: parse rejects non-calibration notes", () => {
  assert.equal(parseCalibrationNote("just a human note"), null);
  assert.equal(parseCalibrationNote(JSON.stringify({ source: "other", agreement: "agree" })), null);
  assert.equal(parseCalibrationNote(JSON.stringify({ source: "judge_calibration", agreement: "maybe" })), null);
  assert.equal(parseCalibrationNote(null), null);
});

test("calibration: image URL filter accepts http(s) + same-origin paths, rejects blob/data/empty", () => {
  assert.equal(usableCalibrationImageUrl("https://x.com/a.jpg"), true);
  assert.equal(usableCalibrationImageUrl("/api/studio/upload/abc.png"), true);
  assert.equal(usableCalibrationImageUrl("blob:https://x.com/123"), false);
  assert.equal(usableCalibrationImageUrl("data:image/png;base64,xxx"), false);
  assert.equal(usableCalibrationImageUrl("//evil.com/a.jpg"), false);
  assert.equal(usableCalibrationImageUrl(""), false);
  assert.equal(usableCalibrationImageUrl(null), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
