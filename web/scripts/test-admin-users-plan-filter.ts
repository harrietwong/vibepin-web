/**
 * Regression test for matchesPlanFilter() in UsersTableClient.tsx (Codex review
 * follow-up, non-blocking item 2): unrecognized plan_key/app_metadata.plan values
 * must not be silently swept into the "Free" filter just because effectivePlan
 * floors them to "free" for display.
 *
 * Run: npx tsx scripts/test-admin-users-plan-filter.ts   (from web/)
 */

import assert from "node:assert";
import { matchesPlanFilter } from "../src/app/admin/users/UsersTableClient";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
}

test("all: every row matches regardless of planUnknown", () => {
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: false }, "all"), true);
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: true }, "all"), true);
  assert.equal(matchesPlanFilter({ effectivePlan: "pro", planUnknown: true }, "all"), true);
});

test("free: a genuine free user (no anomaly) matches", () => {
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: false }, "free"), true);
});

test("free: an unrecognized-plan row does NOT match, even though effectivePlan floored to 'free'", () => {
  // This is the exact regression: an operator filtering "Free" must not see a
  // customer whose plan_key/app_metadata.plan the vocabulary didn't recognize —
  // that is a data-quality anomaly, not a genuine free user.
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: true }, "free"), false);
});

test("pro/starter/business: an unrecognized-plan row never matches a specific plan filter", () => {
  assert.equal(matchesPlanFilter({ effectivePlan: "pro", planUnknown: true }, "pro"), false);
  assert.equal(matchesPlanFilter({ effectivePlan: "starter", planUnknown: true }, "starter"), false);
  assert.equal(matchesPlanFilter({ effectivePlan: "business", planUnknown: true }, "business"), false);
});

test("pro: a genuine pro user (no anomaly) matches", () => {
  assert.equal(matchesPlanFilter({ effectivePlan: "pro", planUnknown: false }, "pro"), true);
});

test("unknown: only planUnknown rows match, regardless of their floored effectivePlan", () => {
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: true }, "unknown"), true);
  assert.equal(matchesPlanFilter({ effectivePlan: "free", planUnknown: false }, "unknown"), false);
  assert.equal(matchesPlanFilter({ effectivePlan: "pro", planUnknown: false }, "unknown"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
