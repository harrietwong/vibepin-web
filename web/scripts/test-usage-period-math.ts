/**
 * test-usage-period-math.ts — fast, DB-FREE unit test for the Phase 3 usage-account
 * period math and plan→limit mapping (src/lib/server/usage/period.ts).
 *
 * This is the hermetic half of Phase 3's coverage: the DRIFT-FREE rollover itself is
 * proven against real Postgres in test-db-usage-lifecycle.ts, but the TS inputs that
 * feed the RPC — the month-clamping arithmetic, the free-plan monthly window anchored
 * on signup, the paid-plan period derived from the Creem mirror dates, and the
 * plan→three-limits mapping — are pure functions and are asserted here with no
 * network. Keeping this in the fast suite means a regression in the arithmetic is
 * caught by `npm test` without needing test-DB credentials.
 *
 * period.ts imports only planEntitlements.ts (pure config); no supabase, no env.
 */

export {};

import {
  planToAccountLimits,
  addMonthsUtcClamped,
  freePeriodForNow,
  paidPeriodFromMirror,
} from "../src/lib/server/usage/period";
import { PLAN_ENTITLEMENTS } from "../src/lib/server/planEntitlements";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}
const iso = (d: Date) => d.toISOString();

async function main(): Promise<void> {
  console.log("\n=== usage period math (DB-free) ===\n");

  // ── plan → limits mapping ──────────────────────────────────────────────────────
  await test("planToAccountLimits maps each of the 4 plans to config numbers", () => {
    for (const plan of ["free", "starter", "pro", "business"] as const) {
      const e = PLAN_ENTITLEMENTS[plan];
      const lim = planToAccountLimits(plan);
      assertEq(lim.aiImagesLimit, e.monthlyAiImages, `${plan} ai images`);
      assertEq(lim.aiTextGenerationsLimit, e.monthlyAiTextGenerations, `${plan} ai text`);
      assertEq(lim.scheduledPostsLimit, e.monthlyScheduledPosts, `${plan} scheduled posts`);
    }
  });

  await test("business scheduled_posts limit maps to null (unlimited), not 0", () => {
    assertEq(planToAccountLimits("business").scheduledPostsLimit, null, "business unlimited posts");
    // free/starter/pro are finite integers (a real cap), never null.
    assert(typeof planToAccountLimits("free").scheduledPostsLimit === "number", "free finite");
    assert(typeof planToAccountLimits("starter").aiImagesLimit === "number", "starter finite");
  });

  // ── addMonthsUtcClamped — matches Postgres interval-month clamping ──────────────
  await test("addMonths clamps 2024-01-31 + 1mo to 2024-02-29 (leap), not Mar 2", () => {
    const jan31 = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
    assertEq(iso(addMonthsUtcClamped(jan31, 1)), iso(new Date(Date.UTC(2024, 1, 29, 12, 0, 0))), "Jan31+1");
  });

  await test("addMonths clamps 2023-01-31 + 1mo to 2023-02-28 (non-leap)", () => {
    const jan31 = new Date(Date.UTC(2023, 0, 31, 0, 0, 0));
    assertEq(iso(addMonthsUtcClamped(jan31, 1)), iso(new Date(Date.UTC(2023, 1, 28, 0, 0, 0))), "Jan31+1 nonleap");
  });

  await test("addMonths is drift-free: 31st anchor restores day when month is long enough", () => {
    const anchor = new Date(Date.UTC(2024, 0, 31, 8, 30, 0)); // Jan 31
    // From the FIXED anchor: Jan31, Feb29, Mar31, Apr30, May31 — day restored each long month.
    assertEq(iso(addMonthsUtcClamped(anchor, 0)), iso(new Date(Date.UTC(2024, 0, 31, 8, 30))), "k=0");
    assertEq(iso(addMonthsUtcClamped(anchor, 1)), iso(new Date(Date.UTC(2024, 1, 29, 8, 30))), "k=1 clamp");
    assertEq(iso(addMonthsUtcClamped(anchor, 2)), iso(new Date(Date.UTC(2024, 2, 31, 8, 30))), "k=2 restored");
    assertEq(iso(addMonthsUtcClamped(anchor, 3)), iso(new Date(Date.UTC(2024, 3, 30, 8, 30))), "k=3 clamp");
    assertEq(iso(addMonthsUtcClamped(anchor, 4)), iso(new Date(Date.UTC(2024, 4, 31, 8, 30))), "k=4 restored");
  });

  await test("addMonths handles year wrap and negative offsets", () => {
    const nov = new Date(Date.UTC(2024, 10, 15)); // 2024-11-15
    assertEq(iso(addMonthsUtcClamped(nov, 3)), iso(new Date(Date.UTC(2025, 1, 15))), "Nov+3 → Feb next year");
    assertEq(iso(addMonthsUtcClamped(nov, -12)), iso(new Date(Date.UTC(2023, 10, 15))), "Nov-12 → prior year");
  });

  // ── freePeriodForNow — monthly window anchored on signup ────────────────────────
  await test("free window contains now and is anchored on signup", () => {
    const signup = new Date(Date.UTC(2024, 0, 15, 10, 0, 0)); // Jan 15
    const now = new Date(Date.UTC(2024, 3, 20)); // Apr 20 — three+ months later
    const p = freePeriodForNow(signup, now);
    assertEq(iso(p.periodAnchor), iso(signup), "anchor is signup");
    assert(p.periodStart.getTime() <= now.getTime(), "start <= now");
    assert(p.periodEnd.getTime() > now.getTime(), "end > now");
    // Apr 20 falls in the window [Apr 15, May 15).
    assertEq(iso(p.periodStart), iso(new Date(Date.UTC(2024, 3, 15, 10, 0))), "start Apr 15");
    assertEq(iso(p.periodEnd), iso(new Date(Date.UTC(2024, 4, 15, 10, 0))), "end May 15");
  });

  await test("free window drift-free across many cycles (31st signup)", () => {
    const signup = new Date(Date.UTC(2024, 0, 31)); // Jan 31
    // 14 months later — the anchor day (31) must still govern where it can.
    const now = new Date(Date.UTC(2025, 2, 15)); // Mar 15 2025
    const p = freePeriodForNow(signup, now);
    assertEq(iso(p.periodAnchor), iso(signup), "anchor stays signup, no creep");
    // Mar 2025 window from a Jan-31 anchor: [2025-02-28, 2025-03-31) contains Mar 15.
    assertEq(iso(p.periodStart), iso(new Date(Date.UTC(2025, 1, 28))), "Feb 28 (clamped)");
    assertEq(iso(p.periodEnd), iso(new Date(Date.UTC(2025, 2, 31))), "Mar 31 (restored)");
  });

  await test("free window when now is before the first boundary → [signup, signup+1mo)", () => {
    const signup = new Date(Date.UTC(2024, 5, 10));
    const now = new Date(Date.UTC(2024, 5, 20)); // same month
    const p = freePeriodForNow(signup, now);
    assertEq(iso(p.periodStart), iso(signup), "start = signup");
    assertEq(iso(p.periodEnd), iso(addMonthsUtcClamped(signup, 1)), "end = signup + 1mo");
  });

  // ── paidPeriodFromMirror — Creem mirror dates ──────────────────────────────────
  await test("paid: both dates present → verbatim, anchor = start", () => {
    const start = "2024-03-01T00:00:00.000Z";
    const end = "2024-04-01T00:00:00.000Z";
    const p = paidPeriodFromMirror(start, end, new Date(Date.UTC(2024, 2, 15)));
    assertEq(iso(p.periodStart), iso(new Date(start)), "start verbatim");
    assertEq(iso(p.periodEnd), iso(new Date(end)), "end verbatim");
    assertEq(iso(p.periodAnchor), iso(new Date(start)), "anchor = start");
  });

  await test("paid: only END present → derive start = end − 1mo, anchor = derived start", () => {
    const end = "2024-04-30T00:00:00.000Z";
    const p = paidPeriodFromMirror(null, end, new Date(Date.UTC(2024, 3, 10)));
    assertEq(iso(p.periodEnd), iso(new Date(end)), "end kept");
    // Apr 30 − 1mo clamps to Mar 30.
    assertEq(iso(p.periodStart), iso(new Date(Date.UTC(2024, 2, 30))), "derived start = Mar 30");
    assertEq(iso(p.periodAnchor), iso(p.periodStart), "anchor = derived start");
  });

  await test("paid: only START present → derive end = start + 1mo", () => {
    const start = "2024-05-05T00:00:00.000Z";
    const p = paidPeriodFromMirror(start, null, new Date(Date.UTC(2024, 4, 10)));
    assertEq(iso(p.periodStart), iso(new Date(start)), "start kept");
    assertEq(iso(p.periodEnd), iso(new Date(Date.UTC(2024, 5, 5))), "end = start + 1mo");
  });

  await test("paid: neither date → monthly window anchored on now", () => {
    const now = new Date(Date.UTC(2024, 6, 7, 9, 0, 0));
    const p = paidPeriodFromMirror(null, null, now);
    assertEq(iso(p.periodStart), iso(now), "start = now");
    assertEq(iso(p.periodEnd), iso(addMonthsUtcClamped(now, 1)), "end = now + 1mo");
    assertEq(iso(p.periodAnchor), iso(now), "anchor = now");
  });

  await test("paid: end not after start (bad input) → treated as end-only derivation", () => {
    const start = "2024-04-01T00:00:00.000Z";
    const end = "2024-03-01T00:00:00.000Z"; // end before start — invalid
    const p = paidPeriodFromMirror(start, end, new Date(Date.UTC(2024, 2, 15)));
    // Falls to the END branch: keep end, derive start = end − 1mo.
    assertEq(iso(p.periodEnd), iso(new Date(end)), "keeps end");
    assertEq(iso(p.periodStart), iso(new Date(Date.UTC(2024, 1, 1))), "derived start = Feb 1");
    assert(p.periodEnd.getTime() > p.periodStart.getTime(), "period ordered after repair");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
