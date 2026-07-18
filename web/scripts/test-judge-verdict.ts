/**
 * Unit tests for the pure Quality Judge verdict logic (Phase C).
 * Run: npx tsx scripts/test-judge-verdict.ts   (from web/)
 */

import assert from "node:assert/strict";
import {
  computeOverall,
  deriveVerdict,
  judgeFromRawScores,
  clampScore,
  SAFETY_FAIL_THRESHOLD,
  ARTIFACTS_SEVERE_THRESHOLD,
  OVERALL_LOW_THRESHOLD,
  BORDERLINE_OVERALL_THRESHOLD,
  type QualityScores,
} from "../src/lib/ai-copy/judgeVerdict";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

// A solid, all-round-good generated image.
const good: QualityScores = {
  productPreservation: 90, realism: 88, creatorLikeness: 85, sceneFit: 87,
  pinterestFit: 84, composition: 86, artifacts: 92, safety: 100,
};

// ── clampScore ──────────────────────────────────────────────────────────────

test("clampScore: clamps to 0-100, rounds, rejects non-numbers", () => {
  assert.equal(clampScore(150), 100);
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(72.6), 73);
  assert.equal(clampScore("80"), undefined);
  assert.equal(clampScore(NaN), undefined);
  assert.equal(clampScore(undefined), undefined);
});

// ── computeOverall ──────────────────────────────────────────────────────────

test("computeOverall: mean of quality dims, safety excluded", () => {
  // Mean of the 7 quality dims (safety 100 excluded) = (90+88+85+87+84+86+92)/7 = 87.4 → 87.
  assert.equal(computeOverall(good), 87);
});

test("computeOverall: undefined when NO quality dim present (safety alone doesn't count)", () => {
  assert.equal(computeOverall({ safety: 100 }), undefined);
  assert.equal(computeOverall({}), undefined);
});

test("computeOverall: averages only the present dims", () => {
  assert.equal(computeOverall({ realism: 40, composition: 60 }), 50);
});

// ── deriveVerdict: the happy path ─────────────────────────────────────────────

test("verdict: a good image is ok", () => {
  assert.equal(deriveVerdict(good), "ok");
});

// ── deriveVerdict: safety hard gate ───────────────────────────────────────────

test("verdict: safety below threshold → invalid (even if everything else is great)", () => {
  assert.equal(deriveVerdict({ ...good, safety: SAFETY_FAIL_THRESHOLD - 1 }), "invalid");
});

test("verdict: safety exactly AT threshold is NOT invalid (boundary, conservative)", () => {
  assert.notEqual(deriveVerdict({ ...good, safety: SAFETY_FAIL_THRESHOLD }), "invalid");
});

// ── deriveVerdict: artifacts + overall combined rule ──────────────────────────

test("verdict: severe artifacts AND low overall → invalid", () => {
  // All-low broken image: overall well below OVERALL_LOW_THRESHOLD, artifacts severe.
  const broken: QualityScores = {
    productPreservation: 20, realism: 15, creatorLikeness: 20, sceneFit: 25,
    pinterestFit: 20, composition: 22, artifacts: 10, safety: 100,
  };
  assert.ok((computeOverall(broken) as number) < OVERALL_LOW_THRESHOLD);
  assert.ok(10 < ARTIFACTS_SEVERE_THRESHOLD);
  assert.equal(deriveVerdict(broken), "invalid");
});

test("verdict: severe artifacts but HEALTHY overall → NOT invalid (no false-kill)", () => {
  // Artifacts tanked (some glitch) but the rest of the image is strong → keep it.
  const oneLowArtifact: QualityScores = { ...good, artifacts: 10 };
  assert.ok((computeOverall(oneLowArtifact) as number) >= OVERALL_LOW_THRESHOLD);
  assert.notEqual(deriveVerdict(oneLowArtifact), "invalid");
});

test("verdict: low overall but artifacts FINE → NOT invalid (mediocre, not broken)", () => {
  // Mediocre-everywhere image (low overall) but no severe artifact → borderline, shown.
  const mediocre: QualityScores = {
    productPreservation: 35, realism: 30, creatorLikeness: 32, sceneFit: 38,
    pinterestFit: 34, composition: 36, artifacts: 70, safety: 100,
  };
  assert.ok((computeOverall(mediocre) as number) < OVERALL_LOW_THRESHOLD);
  assert.equal(deriveVerdict(mediocre), "borderline");
});

test("verdict: a single low dimension does NOT misjudge an otherwise good image", () => {
  assert.equal(deriveVerdict({ ...good, sceneFit: 20 }), "ok");
  assert.equal(deriveVerdict({ ...good, productPreservation: 15 }), "ok");
});

test("verdict: artifacts boundary — AT the severe threshold does not trip the rule", () => {
  const atBoundary: QualityScores = {
    productPreservation: 20, realism: 15, creatorLikeness: 20, sceneFit: 25,
    pinterestFit: 20, composition: 22, artifacts: ARTIFACTS_SEVERE_THRESHOLD, safety: 100,
  };
  // overall is low, but artifacts == threshold (not strictly below) → not invalid.
  assert.notEqual(deriveVerdict(atBoundary), "invalid");
});

// ── deriveVerdict: borderline vs ok band ──────────────────────────────────────

test("verdict: overall just below borderline threshold → borderline", () => {
  const dims = BORDERLINE_OVERALL_THRESHOLD - 1;
  const scores: QualityScores = {
    productPreservation: dims, realism: dims, creatorLikeness: dims, sceneFit: dims,
    pinterestFit: dims, composition: dims, artifacts: dims, safety: 100,
  };
  assert.equal(deriveVerdict(scores), "borderline");
});

test("verdict: overall AT borderline threshold → ok (shown, no badge)", () => {
  const dims = BORDERLINE_OVERALL_THRESHOLD;
  const scores: QualityScores = {
    productPreservation: dims, realism: dims, creatorLikeness: dims, sceneFit: dims,
    pinterestFit: dims, composition: dims, artifacts: dims, safety: 100,
  };
  assert.equal(deriveVerdict(scores), "ok");
});

// ── Missing scores must NEVER cause invalid ───────────────────────────────────

test("verdict: no scores at all → ok (never invalid on missing data)", () => {
  assert.equal(deriveVerdict({}), "ok");
});

test("verdict: missing safety → safety gate is skipped (not invalid)", () => {
  const noSafety: QualityScores = { ...good };
  delete noSafety.safety;
  assert.notEqual(deriveVerdict(noSafety), "invalid");
});

test("verdict: severe artifacts + low overall but MISSING safety → still invalid via artifact rule", () => {
  const broken: QualityScores = {
    productPreservation: 20, realism: 15, creatorLikeness: 20, sceneFit: 25,
    pinterestFit: 20, composition: 22, artifacts: 10,
  };
  assert.equal(deriveVerdict(broken), "invalid");
});

test("verdict: missing artifacts → artifact rule skipped even with low overall (borderline, not invalid)", () => {
  const lowNoArtifacts: QualityScores = {
    productPreservation: 20, realism: 15, creatorLikeness: 20, sceneFit: 25,
    pinterestFit: 20, composition: 22, safety: 100,
  };
  assert.equal(deriveVerdict(lowNoArtifacts), "borderline");
});

// ── judgeFromRawScores: end-to-end clamp + verdict ────────────────────────────

test("judgeFromRawScores: clamps raw model output and derives a consistent verdict", () => {
  const { scores, overall, verdict } = judgeFromRawScores({
    productPreservation: 120,   // clamps to 100
    realism: 90, creatorLikeness: 88, sceneFit: 85, pinterestFit: 87,
    composition: 86, artifacts: 92, safety: 100,
    junkField: "ignored",
  });
  assert.equal(scores.productPreservation, 100);
  assert.equal((scores as Record<string, unknown>).junkField, undefined);
  assert.equal(typeof overall, "number");
  assert.equal(verdict, "ok");
});

test("judgeFromRawScores: unsafe raw output → invalid", () => {
  const { verdict } = judgeFromRawScores({ ...good, safety: 10 });
  assert.equal(verdict, "invalid");
});

test("judgeFromRawScores: garbage/empty raw → ok (no scores, never invalid)", () => {
  assert.equal(judgeFromRawScores(null).verdict, "ok");
  assert.equal(judgeFromRawScores({}).verdict, "ok");
  assert.equal(judgeFromRawScores({ nope: 1 }).verdict, "ok");
});

console.log(`\n${passed} passed, 0 failed`);
