/**
 * Settings → Billing view-model tests (billingUsageView.ts + its SettingsModal wiring).
 * Run: npx tsx scripts/test-billing-usage-view.ts
 *
 * Pins the 2026-09-26 fix for "plan card says Free · 10 images, usage card says 800
 * included": both cards must derive from ONE /api/billing/usage payload.
 *
 *  1. used / limit / remaining / pct maths, incl. the metered snapshot limit vs the
 *     unmetered included allowance, and "no ledger row = 0 used".
 *  2. Colour thresholds: normal < 80% <= warning < 100% <= danger; 0 cap = danger.
 *  3. Unlimited (null cap) → no bar, no remainder.
 *  4. Same source: the plan card's numbers ARE the meters' limits (same objects), and
 *     the SettingsModal source names the plan from planSummaryView, not Creem status.
 */

import { readFileSync } from "node:fs";
import {
  bucketView,
  effectiveLimit,
  planSummaryView,
  toneFor,
  USAGE_WARNING_RATIO,
  type BillingUsageInput,
} from "../src/lib/billingUsageView";
import en from "../src/lib/i18n/messages/en";
import zhCN from "../src/lib/i18n/messages/zh-CN";
import zhTW from "../src/lib/i18n/messages/zh-TW";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log("\nBilling usage view-model tests\n");

// ── 1) used / limit / remaining ────────────────────────────────────────────────

test("metered: used from the ledger, limit = account snapshot (not the plan config)", () => {
  const v = bucketView({ used: 120, limit: 150, included: 800 }, "metered");
  assertEq(v.measured, true, "measured");
  assertEq(v.used, 120, "used");
  assertEq(v.limit, 150, "snapshot limit wins");
  assertEq(v.remaining, 30, "remaining = limit - used");
  assertEq(v.pct, 80, "pct");
});

test("unmetered (no ledger row): 0 used against the plan's included allowance", () => {
  const v = bucketView({ used: null, limit: null, included: 800 }, "unmetered");
  assertEq(v.measured, false, "not measured");
  assertEq(v.used, 0, "no row = 0 used");
  assertEq(v.limit, 800, "included allowance");
  assertEq(v.remaining, 800, "all remaining");
  assertEq(v.pct, 0, "empty bar");
  assertEq(v.tone, "normal", "normal tone");
});

test("remaining never goes negative when usage overshoots the cap", () => {
  const v = bucketView({ used: 12, limit: 10, included: 10 }, "metered");
  assertEq(v.remaining, 0, "floored at 0");
  assertEq(v.pct, 100, "bar capped at 100%");
});

test("effectiveLimit: metered → limit, unmetered → included", () => {
  assertEq(effectiveLimit({ used: 1, limit: 5, included: 9 }, "metered"), 5, "metered");
  assertEq(effectiveLimit({ used: null, limit: null, included: 9 }, "unmetered"), 9, "unmetered");
});

// ── 2) Colour thresholds ───────────────────────────────────────────────────────

test("tone thresholds: <80% normal, >=80% warning, >=100% danger", () => {
  assertEq(USAGE_WARNING_RATIO, 0.8, "threshold constant");
  assertEq(toneFor(0, 10), "normal", "0%");
  assertEq(toneFor(7, 10), "normal", "70%");
  assertEq(toneFor(639, 800), "normal", "79.9% stays normal (raw ratio, not rounded pct)");
  assertEq(toneFor(640, 800), "warning", "exactly 80%");
  assertEq(toneFor(9, 10), "warning", "90%");
  assertEq(toneFor(10, 10), "danger", "100% = used up");
  assertEq(toneFor(11, 10), "danger", "over the cap");
  assertEq(toneFor(0, 0), "danger", "0 cap = nothing available");
});

test("bucketView carries the tone through for the bar colour", () => {
  assertEq(bucketView({ used: 240, limit: 300, included: 300 }, "metered").tone, "warning", "80% of posts");
  assertEq(bucketView({ used: 300, limit: 300, included: 300 }, "metered").tone, "danger", "posts used up");
  assertEq(bucketView({ used: 1, limit: 300, included: 300 }, "metered").tone, "normal", "low usage");
});

// ── 3) Unlimited ───────────────────────────────────────────────────────────────

test("unlimited (null cap): no remainder, no bar, tone unlimited — metered and unmetered", () => {
  const m = bucketView({ used: 57, limit: null, included: null }, "metered");
  assertEq(m.tone, "unlimited", "metered tone");
  assertEq(m.limit, null, "no limit");
  assertEq(m.remaining, null, "no remainder");
  assertEq(m.pct, 0, "no bar");
  assertEq(m.used, 57, "used still shown");
  const u = bucketView({ used: null, limit: null, included: null }, "unmetered");
  assertEq(u.tone, "unlimited", "unmetered tone");
  assertEq(u.used, 0, "0 used");
});

// ── 4) Same source ─────────────────────────────────────────────────────────────

const internalProUnmetered: BillingUsageInput = {
  plan: "pro",
  planSource: "whitelist",
  connectedAccountsPerPlatform: 2,
  state: "unmetered",
  aiImages: { used: null, limit: null, included: 800 },
  aiTextGenerations: { used: null, limit: null, included: 2000 },
  scheduledPosts: { used: null, limit: null, included: 300 },
};

test("the reported bug: internal Pro user → plan card says pro/internal with 800/300, not Free 10/5", () => {
  const v = planSummaryView(internalProUnmetered);
  assertEq(v.planKey, "pro", "plan card names the plan the quotas use");
  assertEq(v.internal, true, "whitelist → internal note");
  assertEq(v.images.limit, 800, "images");
  assertEq(v.posts.limit, 300, "posts");
  assertEq(v.text.limit, 2000, "text");
  assertEq(v.connectedAccountsPerPlatform, 2, "connections");
  assertEq(v.images.used, 0, "0 used");
  assertEq(v.images.remaining, 800, "800 remaining");
});

test("a subscribed user is not flagged internal", () => {
  assertEq(planSummaryView({ ...internalProUnmetered, planSource: "subscription" }).internal, false, "subscription");
  assertEq(planSummaryView({ ...internalProUnmetered, planSource: undefined }).internal, false, "missing source");
});

test("plan-card numbers and meter numbers are the SAME view (metered snapshot case)", () => {
  const v = planSummaryView({
    plan: "starter",
    planSource: "subscription",
    connectedAccountsPerPlatform: 1,
    state: "metered",
    aiImages: { used: 130, limit: 150, included: 150 },
    aiTextGenerations: { used: 10, limit: 500, included: 500 },
    scheduledPosts: { used: 150, limit: 150, included: 150 },
  });
  assertEq(v.images.limit, bucketView({ used: 130, limit: 150, included: 150 }, "metered").limit, "images parity");
  assertEq(v.images.tone, "warning", "130/150 = 86.7% → warning");
  assertEq(v.posts.tone, "danger", "150/150 → danger");
  assertEq(v.text.remaining, 490, "text remaining");
});

const modal = readFileSync("src/components/settings/SettingsModal.tsx", "utf8");

test("SettingsModal names the plan from planSummaryView (usage API), never from Creem effectivePlan", () => {
  assert(/const summaryView = usage && !usageSyncError \? planSummaryView\(usage\) : null;/.test(modal), "summaryView from usage payload");
  assert(/const planName = summaryView \? normalizePlanName\(summaryView\.planKey\) : null;/.test(modal), "planName from summaryView");
  assert(!/normalizePlanName\(billing\.effectivePlan\)/.test(modal), "Creem effectivePlan must not name the plan");
  assert(!/t\("billing\.freeDesc"\)/.test(modal), "static Free sentence must not render");
  assert(!/t\("billing\.paidDesc"\)/.test(modal), "static Paid sentence must not render");
});

test("SettingsModal plan description and meters read the same BucketViews", () => {
  assert(/\.replace\("\{images\}", summaryView\.images\.limit/.test(modal), "description images = meter limit");
  assert(/\.replace\("\{posts\}", summaryView\.posts\.limit/.test(modal), "description posts = meter limit");
  assert(/view=\{summaryView\.images\}/.test(modal), "images row");
  assert(/view=\{summaryView\.text\}/.test(modal), "text row");
  assert(/view=\{summaryView\.posts\}/.test(modal), "posts row");
  assert(/<UsageBar view=\{summaryView\.images\} \/>/.test(modal), "headline meter uses the images view");
});

test("bar colour maps danger → red, warning → amber, else brand gradient", () => {
  const fn = modal.slice(modal.indexOf("function usageBarColor"), modal.indexOf("function toneTextColor"));
  assert(/tone === "danger"\) return UI\.danger/.test(fn), "danger → UI.danger");
  assert(/tone === "warning"\) return UI\.warning/.test(fn), "warning → UI.warning");
  assert(/return UI\.gradient/.test(fn), "normal → gradient");
});

test("new copy exists in en / zh-CN / zh-TW with matching placeholders", () => {
  const keys = [
    "billing.internalBadge",
    "billing.internalPlanNote",
    "billing.internalNoBilling",
    "billing.planIncludes",
    "billing.usageUsedCount",
    "billing.usageLimitReached",
    "billing.bonusImages",
  ] as const;
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of keys) {
    const e = (en as Record<string, string>)[k];
    assert(e, `en.${k}`);
    for (const [name, cat] of [["zh-CN", zhCN], ["zh-TW", zhTW]] as const) {
      const v = (cat as Record<string, string>)[k];
      assert(v, `${name}.${k} missing`);
      assertEq(ph(v), ph(e), `${name}.${k} placeholders`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
