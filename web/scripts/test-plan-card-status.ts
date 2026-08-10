/**
 * test-plan-card-status.ts — Plan card status differentiation (PRD 0809 §8).
 * Run: npx tsx scripts/test-plan-card-status.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCardStatus, planCardStatusStyle } from "../src/lib/plan/cardStatus";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

console.log("\n=== exactly one status per card ===");
test("a scheduled Pin is scheduled", () => {
  assert.equal(planCardStatus({}), "scheduled");
  assert.equal(planCardStatus(null), "scheduled");
});
test("a posted Pin is published", () => {
  assert.equal(planCardStatus({ postedAt: "2026-08-10T02:00:00Z" }), "published");
});
test("an explicit publish error is failed", () => {
  assert.equal(planCardStatus({ publishError: "board unavailable" }), "failed");
  assert.equal(planCardStatus({ failureType: "publish" }), "failed");
  assert.equal(planCardStatus({ generationStatus: "failed" }), "failed");
});

console.log("\n=== the two orderings that would misreport ===");
test("published beats a STALE error — retried and succeeded is Published, not Failed", () => {
  assert.equal(planCardStatus({ postedAt: "2026-08-10T02:00:00Z", publishError: "an earlier attempt failed" }), "published");
});
test("not-yet-published is never inferred as failed", () => {
  // The normal scheduled state has no postedAt. Treating that as failure would paint
  // every upcoming Pin as broken.
  assert.equal(planCardStatus({ postedAt: null, publishError: null }), "scheduled");
  assert.equal(planCardStatus({ generationStatus: "ready" }), "scheduled");
});

console.log("\n=== colour is never the only signal ===");
test("every status carries an icon AND a text label, not just an accent", () => {
  for (const draft of [{}, { postedAt: "x" }, { publishError: "e" }]) {
    const s = planCardStatusStyle(draft);
    assert(s.icon, `${s.status} must have an icon`);
    assert(s.labelKey, `${s.status} must have a text label`);
    assert(/^#[0-9A-Fa-f]{6}$/.test(s.accent), `${s.status} accent must be a colour token`);
  }
});
test("the three statuses are visually distinct from each other", () => {
  const accents = new Set(["scheduled", "published", "failed"].map((_, i) =>
    planCardStatusStyle([{}, { postedAt: "x" }, { publishError: "e" }][i]).accent));
  assert.equal(accents.size, 3, "each status needs its own accent");
  const icons = new Set([{}, { postedAt: "x" }, { publishError: "e" }].map(d => planCardStatusStyle(d).icon));
  assert.equal(icons.size, 3, "each status needs its own icon — colour alone is not enough");
});

console.log("\n=== rendering rules ===");
test("the badge renders icon + label, and keeps the label accessible when compact", () => {
  const badge = readFileSync("src/components/plan/PlanCardStatusBadge.tsx", "utf8");
  assert(badge.includes("aria-label={label}"), "the status must be announced to assistive tech");
  assert(badge.includes("title={label}"), "the status must be discoverable on hover when compact");
  assert(/\{!compact && label\}/.test(badge), "the text label must render whenever there is room");
});
test("the image itself is never tinted — the badge is the signal", () => {
  const badge = readFileSync("src/components/plan/PlanCardStatusBadge.tsx", "utf8");
  assert(!/filter:|mixBlendMode|opacity:\s*0\.[0-9]/.test(badge), "must not wash the artwork in colour");
});
test("both calendar surfaces show it — week with a label, month icon-only", () => {
  const plan = readFileSync("src/components/plan/WeeklyPlanWorkspace.tsx", "utf8");
  const uses = plan.match(/<PlanCardStatusBadge/g) ?? [];
  assert(uses.length >= 2, "week and month tiles must both render the status");
  assert(/<PlanCardStatusBadge draft={d} compact/.test(plan), "the small month tile must use the compact form");
});

console.log(`\nPlan card status: ${passed} passed, 0 failed\n`);
