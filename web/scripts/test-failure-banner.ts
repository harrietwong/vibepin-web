/**
 * Unit tests for FailureBanner's pure logic (PRD "Create Pins & Plan 失败情况优化"
 * §2): count→copy mapping (title/body/cta) and the session-dismiss visibility rule,
 * including the "CTA click = dismiss" semantics (PRD §2.2). Run:
 * npx tsx scripts/test-failure-banner.ts (from web/)
 *
 * Component rendering (count===0 → null, context-suppression while filter==="failed")
 * is intentionally NOT covered here (no React test renderer in this repo) — only the
 * extracted pure helpers are exercised. Context suppression itself is a plain JSX
 * conditional in StudioBoard.tsx (`{filter !== "failed" && <FailureBanner .../>}`),
 * not a pure function, so it isn't unit-testable here either; verified by inspection.
 */

import assert from "node:assert";
import { getFailureBannerCopy, computeVisibleFailureCount } from "../src/components/shared/FailureBanner";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

// ── getFailureBannerCopy (PRD §2.1 wording) ──────────────────────────────────────

test("copy: singular for count === 1", () => {
  const { title, body, cta } = getFailureBannerCopy(1);
  assert.equal(title, "1 Pin failed to publish");
  assert.equal(body, "Review the error and choose how to continue.");
  assert.equal(cta, "Review failed Pin");
});

test("copy: plural for count > 1", () => {
  const { title, body, cta } = getFailureBannerCopy(3);
  assert.equal(title, "3 Pins failed to publish");
  assert.equal(body, "Review the errors and choose how to continue.");
  assert.equal(cta, "Review failed Pins");
});

test("copy: plural wording used for count === 0 too (caller gates rendering, not this fn)", () => {
  const { title } = getFailureBannerCopy(0);
  assert.equal(title, "0 Pins failed to publish");
});

// ── computeVisibleFailureCount (session-dismiss rule, PRD §2.2) ──────────────────
// Both the × close AND the CTA (which now calls onDismiss before onReview — see
// FailureBanner's handleReview) drive this same dismissedAt state, so this pure
// function covers the "dismiss" half of "CTA click = dismiss" for both entry points;
// the "and also navigate" half is a side effect (onReview call) verified by inspection
// of FailureBanner.tsx's handleReview (onDismiss?.() then onReview()).

test("visible: never dismissed (dismissedAt=null) → full count shows", () => {
  assert.equal(computeVisibleFailureCount(2, null), 2);
  assert.equal(computeVisibleFailureCount(0, null), 0);
});

test("visible: dismissed at same count → hidden (0)", () => {
  assert.equal(computeVisibleFailureCount(2, 2), 0);
});

test("visible: dismissed, count later dropped (Retry fixed one) → still hidden", () => {
  assert.equal(computeVisibleFailureCount(1, 2), 0);
});

test("visible: dismissed, NEW failure pushes count above dismissedAt → reappears", () => {
  assert.equal(computeVisibleFailureCount(3, 2), 3);
});

test("visible: dismissed at 0 is a no-op state — any positive count shows", () => {
  assert.equal(computeVisibleFailureCount(1, 0), 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
