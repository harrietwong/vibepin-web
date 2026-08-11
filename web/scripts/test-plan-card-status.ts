/**
 * test-plan-card-status.ts — Plan card status differentiation (PRD 0809 §8).
 * Run: npx tsx scripts/test-plan-card-status.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCardStatus, planCardStatusStyle } from "../src/lib/plan/cardStatus";
import { isActionablePublishFailure } from "../src/lib/studio/pinLifecycle";

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
test("a real publish failure is failed", () => {
  assert.equal(planCardStatus({ failureType: "publish", publishError: "board unavailable" }), "failed");
});

console.log("\n=== the two orderings that would misreport ===");
test("published beats a STALE error — retried and succeeded is Published, not Failed", () => {
  assert.equal(planCardStatus({ postedAt: "2026-08-10T02:00:00Z", publishError: "an earlier attempt failed" }), "published");
});
test("not-yet-published is never inferred as failed", () => {
  // The normal scheduled state has no postedAt. Treating that as failure would paint
  // every upcoming Pin as broken.
  assert.equal(planCardStatus({ postedAt: null, publishError: null }), "scheduled");
});

console.log("\n=== the badge and the banner must agree ===");
test("the card uses the SAME failure rule as the 'N Pins failed' banner", () => {
  // A first version defined failure here independently (any of publishError /
  // failureType / a "fail" generation status). The calendar then showed far more Failed
  // badges than the banner counted, because the banner requires all three conditions.
  const cases = [
    { failureType: "publish", publishError: "boom" },                       // actionable
    { failureType: "publish", publishError: "boom", archivedAt: "2026-01-01" }, // archived ⇒ off the board
    { failureType: "generation", publishError: "boom" },                    // not a PUBLISH failure
    { failureType: "publish" },                                             // no error text
    {},
  ];
  for (const c of cases) {
    const banner = isActionablePublishFailure(c as never);
    const badge = planCardStatus(c as never) === "failed";
    assert.equal(badge, banner, `badge and banner disagree for ${JSON.stringify(c)}`);
  }
});

test("an archived failure is not badged — it is off the board", () => {
  assert.equal(planCardStatus({ failureType: "publish", publishError: "boom", archivedAt: "2026-01-01" }), "scheduled");
});

test("a GENERATION failure is not a publish failure", () => {
  assert.equal(planCardStatus({ failureType: "generation", publishError: "boom" }), "scheduled");
});

console.log("\n=== colour is never the only signal ===");
test("every status carries an icon AND a text label, not just an accent", () => {
  for (const draft of [{}, { postedAt: "x" }, { failureType: "publish", publishError: "e" }]) {
    const s = planCardStatusStyle(draft);
    assert(s.icon, `${s.status} must have an icon`);
    assert(s.labelKey, `${s.status} must have a text label`);
    assert(/^#[0-9A-Fa-f]{6}$/.test(s.accent), `${s.status} accent must be a colour token`);
  }
});
test("the three statuses are visually distinct from each other", () => {
  const trio = [{}, { postedAt: "x" }, { failureType: "publish", publishError: "e" }];
  const accents = new Set(trio.map(d => planCardStatusStyle(d as never).accent));
  assert.equal(accents.size, 3, "each status needs its own accent");
  const icons = new Set(trio.map(d => planCardStatusStyle(d as never).icon));
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
