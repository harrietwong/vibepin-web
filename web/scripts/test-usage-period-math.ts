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
 * period.ts imports only planEntitlements.ts (pure config); no supabase, no env — the
 * statically-imported cases below prove that purity by construction.
 *
 * The computePeriodForPlan cases (the annual monthly-sub-window contract) are the one
 * exception: that function lives in ensureAccount.ts, whose module graph reaches
 * src/lib/supabase.ts, which builds a client at MODULE SCOPE and therefore needs the
 * three public env vars merely to be importable. So this file (a) sets placeholder
 * values — the same three test-creem-webhook-ordering.ts uses — and (b) loads
 * ensureAccount with a DYNAMIC import inside main(), because static imports are hoisted
 * above these assignments and would crash on `supabaseUrl is required`. No network is
 * touched: only computePeriodForPlan's FREE branch calls the auth admin API, and every
 * case here is on the PAID branch.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

import {
  planToAccountLimits,
  addMonthsUtcClamped,
  freePeriodForNow,
  paidPeriodFromMirror,
  monthlyWindowFrom,
  clampToSubscriptionEnd,
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

  // == ANNUAL SUBSCRIPTIONS -> MONTHLY SUB-WINDOWS (裁决 #2 / PRD v3.2 §9.1) ======
  // An annual subscriber pays yearly but gets the SAME monthly allowances as a
  // monthly subscriber, reset monthly, anchored on the subscription start. The Creem
  // hint is a 12-month window; monthlyWindowFrom carves the month containing `now`
  // out of it, and clampToSubscriptionEnd keeps it inside the subscription.

  // --- monthlyWindowFrom: the v56 rule, in TS -----------------------------------
  await test("monthlyWindowFrom: N=1 when now is inside the first month", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40); // 2026-08-28T09:40Z
    const w = monthlyWindowFrom(anchor, Date.UTC(2026, 8, 1));
    assertEq(w.n, 1, "N");
    assertEq(iso(w.start), "2026-08-28T09:40:00.000Z", "start = anchor");
    assertEq(iso(w.end), "2026-09-28T09:40:00.000Z", "end = anchor + 1mo");
  });

  await test("monthlyWindowFrom: window is half-open - now == a boundary starts the NEXT month", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40);
    // Exactly on anchor+1mo: the SQL loop advances while `anchor + N months <= now`,
    // so the boundary instant belongs to the window that STARTS there.
    const w = monthlyWindowFrom(anchor, Date.UTC(2026, 8, 28, 9, 40));
    assertEq(w.n, 2, "N=2 at the boundary");
    assertEq(iso(w.start), "2026-09-28T09:40:00.000Z", "start = the boundary itself");
    assert(w.start.getTime() <= Date.UTC(2026, 8, 28, 9, 40), "start <= now");
    assert(w.end.getTime() > Date.UTC(2026, 8, 28, 9, 40), "end > now");
  });

  await test("monthlyWindowFrom: now at/behind the anchor -> [anchor, anchor+1mo)", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40);
    for (const now of [anchor, anchor - 86_400_000, Date.UTC(2020, 0, 1)]) {
      const w = monthlyWindowFrom(anchor, now);
      assertEq(w.n, 1, "N stays 1 for a future/instant anchor");
      assertEq(iso(w.start), "2026-08-28T09:40:00.000Z", "start = anchor");
      assertEq(iso(w.end), "2026-09-28T09:40:00.000Z", "end = anchor + 1mo");
    }
  });

  await test("monthlyWindowFrom: month-end clamp - 2026-01-31 anchor -> Feb window ends 2026-02-28 (non-leap)", () => {
    const anchor = Date.UTC(2026, 0, 31, 0, 0, 0);
    const w = monthlyWindowFrom(anchor, Date.UTC(2026, 1, 10));
    assertEq(iso(w.start), "2026-01-31T00:00:00.000Z", "start Jan 31");
    assertEq(iso(w.end), "2026-02-28T00:00:00.000Z", "end Feb 28 - 2026 is not a leap year");
  });

  await test("monthlyWindowFrom: month-end clamp - 2024-01-31 anchor -> Feb window ends 2024-02-29 (leap)", () => {
    const anchor = Date.UTC(2024, 0, 31, 0, 0, 0);
    const w = monthlyWindowFrom(anchor, Date.UTC(2024, 1, 10));
    assertEq(iso(w.start), "2024-01-31T00:00:00.000Z", "start Jan 31");
    assertEq(iso(w.end), "2024-02-29T00:00:00.000Z", "end Feb 29 - 2024 IS a leap year");
    // And the day-of-month is RESTORED the moment the month is long enough (no ratchet).
    const march = monthlyWindowFrom(anchor, Date.UTC(2024, 2, 10));
    assertEq(iso(march.start), "2024-02-29T00:00:00.000Z", "Mar window starts Feb 29");
    assertEq(iso(march.end), "2024-03-31T00:00:00.000Z", "Mar window ends Mar 31 - day restored");
  });

  await test("monthlyWindowFrom == the SQL rule for 24 consecutive months from a mid-month anchor", () => {
    // Independent re-derivation of the v56 loop: smallest N with anchor + N months > now,
    // window = [anchor+(N-1)mo, anchor+N mo). Asserted for probes inside every one of
    // the first 24 months, plus contiguity (each end is the next start).
    const anchorDate = new Date(Date.UTC(2026, 7, 28, 9, 40, 0));
    const anchor = anchorDate.getTime();
    let prevEnd: number | null = null;
    for (let k = 0; k < 24; k++) {
      const expectStart = addMonthsUtcClamped(anchorDate, k);
      const expectEnd = addMonthsUtcClamped(anchorDate, k + 1);
      const mid = expectStart.getTime() + Math.floor((expectEnd.getTime() - expectStart.getTime()) / 2);
      for (const now of [expectStart.getTime(), mid, expectEnd.getTime() - 1]) {
        const w = monthlyWindowFrom(anchor, now);
        assertEq(w.n, k + 1, `month ${k}: N`);
        assertEq(iso(w.start), iso(expectStart), `month ${k}: start (now=${new Date(now).toISOString()})`);
        assertEq(iso(w.end), iso(expectEnd), `month ${k}: end (now=${new Date(now).toISOString()})`);
        assert(w.start.getTime() <= now && now < w.end.getTime(), `month ${k}: now inside [start,end)`);
      }
      if (prevEnd !== null) {
        assertEq(expectStart.getTime(), prevEnd, `month ${k}: contiguous with the previous window`);
      }
      prevEnd = expectEnd.getTime();
    }
  });

  // --- clampToSubscriptionEnd ---------------------------------------------------
  await test("clampToSubscriptionEnd truncates a window that overhangs the subscription end", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40);
    const subEnd = Date.UTC(2027, 7, 28, 9, 40); // +12mo
    // Month 12 would run [2027-08-28, 2027-09-28) - past the subscription end.
    const raw = monthlyWindowFrom(anchor, Date.UTC(2027, 7, 28, 10, 0));
    assertEq(iso(raw.end), "2027-09-28T09:40:00.000Z", "raw end overhangs");
    const w = clampToSubscriptionEnd(raw, subEnd, anchor);
    assertEq(iso(w.end), "2027-08-28T09:40:00.000Z", "clamped to the subscription end");
    assert(w.end.getTime() > w.start.getTime(), "still a valid, ordered period");
  });

  await test("clampToSubscriptionEnd repairs a STALE window (now past the subscription end) instead of inverting it", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40);
    const subEnd = Date.UTC(2027, 7, 28, 9, 40);
    // A late renewal webhook: now is a month past expiry. The naive window starts AFTER
    // subEnd; clamping only the end would give end <= start and the RPC would raise.
    const raw = monthlyWindowFrom(anchor, Date.UTC(2027, 9, 5));
    assert(raw.start.getTime() >= subEnd, "precondition: naive window starts past subEnd");
    const w = clampToSubscriptionEnd(raw, subEnd, anchor);
    assert(w.end.getTime() > w.start.getTime(), "period stays ordered (no RPC invalid_parameter_value)");
    assertEq(iso(w.end), "2027-08-28T09:40:00.000Z", "ends exactly at the subscription end");
    assertEq(iso(w.start), "2027-07-28T09:40:00.000Z", "= the last in-subscription month");
  });

  await test("clampToSubscriptionEnd is a no-op for a non-finite end or an end at/before the anchor", () => {
    const anchor = Date.UTC(2026, 7, 28, 9, 40);
    const raw = monthlyWindowFrom(anchor, Date.UTC(2026, 8, 1));
    assertEq(iso(clampToSubscriptionEnd(raw, Number.NaN, anchor).end), iso(raw.end), "NaN end -> untouched");
    assertEq(iso(clampToSubscriptionEnd(raw, anchor, anchor).end), iso(raw.end), "end == anchor -> untouched");
    assertEq(iso(clampToSubscriptionEnd(raw, anchor - 1, anchor).end), iso(raw.end), "end < anchor -> untouched");
  });

  // --- computePeriodForPlan: the annual hint end-to-end --------------------------
  // Dynamic import (see the header): ensureAccount.ts reaches supabase.ts, which needs
  // the placeholder env set at the top of this file to be importable at all. The PAID
  // branch asserted below hits NO network — only the FREE branch calls the admin API.
  const { computePeriodForPlan } = await import("../src/lib/server/usage/ensureAccount");

  const ANNUAL_START = "2026-08-28T09:40:00.000Z";
  const ANNUAL_END = "2027-08-28T09:40:00.000Z";
  const annualHint = { currentPeriodStart: ANNUAL_START, currentPeriodEnd: ANNUAL_END };

  await test("ANNUAL month 1: period is one month, anchored on the subscription start", async () => {
    const p = await computePeriodForPlan("u1", "pro", annualHint, new Date("2026-09-05T00:00:00.000Z"));
    assertEq(iso(p.periodStart), "2026-08-28T09:40:00.000Z", "start = subscription start");
    assertEq(iso(p.periodEnd), "2026-09-28T09:40:00.000Z", "end = start + 1 month, NOT + 1 year");
    assertEq(iso(p.periodAnchor), ANNUAL_START, "anchor = subscription start");
  });

  await test("ANNUAL month 2: period advanced one month, still inside the subscription", async () => {
    const p = await computePeriodForPlan("u1", "pro", annualHint, new Date("2026-10-05T00:00:00.000Z"));
    assertEq(iso(p.periodStart), "2026-09-28T09:40:00.000Z", "start = anchor + 1mo");
    assertEq(iso(p.periodEnd), "2026-10-28T09:40:00.000Z", "end = anchor + 2mo");
    assertEq(iso(p.periodAnchor), ANNUAL_START, "anchor unchanged across months");
    assert(p.periodEnd.getTime() <= new Date(ANNUAL_END).getTime(), "never past the subscription end");
  });

  await test("ANNUAL month 12 (final): window ends AT the subscription end, never past it", async () => {
    const p = await computePeriodForPlan("u1", "pro", annualHint, new Date("2027-08-01T00:00:00.000Z"));
    assertEq(iso(p.periodStart), "2027-07-28T09:40:00.000Z", "start = anchor + 11mo");
    assertEq(iso(p.periodEnd), "2027-08-28T09:40:00.000Z", "end = the subscription end");
    assertEq(iso(p.periodAnchor), ANNUAL_START, "anchor unchanged");
  });

  await test("ANNUAL: every one of the 12 months is ~1 month wide and inside the subscription", async () => {
    const subEnd = new Date(ANNUAL_END).getTime();
    const anchor = new Date(ANNUAL_START);
    for (let k = 0; k < 12; k++) {
      const probe = new Date(addMonthsUtcClamped(anchor, k).getTime() + 60_000); // 1 min into month k
      const p = await computePeriodForPlan("u1", "pro", annualHint, probe);
      const widthDays = (p.periodEnd.getTime() - p.periodStart.getTime()) / 86_400_000;
      assert(widthDays >= 28 && widthDays <= 31, `month ${k} width ${widthDays}d is monthly, not annual`);
      assert(p.periodEnd.getTime() <= subEnd, `month ${k} end is inside the subscription`);
      assert(
        p.periodStart.getTime() <= probe.getTime() && probe.getTime() < p.periodEnd.getTime(),
        `month ${k} contains now`,
      );
      assertEq(iso(p.periodAnchor), ANNUAL_START, `month ${k} anchor`);
    }
  });

  await test("ANNUAL year 2 (renewal): the new hint start is the new anchor, still monthly", async () => {
    // The renewal webhook carries the next year dates. Year-2 start lies on the SAME
    // monthly lattice as year 1 (anchor + 12mo), so the RPC own rollover already lands
    // there; this asserts the TS side hands the RPC a monthly period either way.
    const y2 = { currentPeriodStart: "2027-08-28T09:40:00.000Z", currentPeriodEnd: "2028-08-28T09:40:00.000Z" };
    const p = await computePeriodForPlan("u1", "pro", y2, new Date("2027-09-10T00:00:00.000Z"));
    assertEq(iso(p.periodAnchor), "2027-08-28T09:40:00.000Z", "new anchor = new subscription start");
    assertEq(iso(p.periodStart), "2027-08-28T09:40:00.000Z", "start");
    assertEq(iso(p.periodEnd), "2027-09-28T09:40:00.000Z", "end = +1 month");
    // Year-2 start is exactly year-1 anchor + 12 months -> the same lattice.
    assertEq(
      iso(addMonthsUtcClamped(new Date(ANNUAL_START), 12)),
      "2027-08-28T09:40:00.000Z",
      "year-2 start sits on the year-1 monthly lattice",
    );
  });

  // --- REGRESSION: monthly plans must be byte-identical to the PRE-CHANGE code ---
  await test("MONTHLY hints are byte-identical to the pre-change implementation (3 captured cases)", async () => {
    // These literals were captured by RUNNING the OLD computePeriodForPlan /
    // paidPeriodFromMirror at 027a873b BEFORE the annual sub-window change landed. They
    // are the frozen contract: a monthly subscription hint window already IS
    // anchor + 1 month, so deriving the sub-window must reproduce it exactly.
    const captured = [
      {
        name: "monthly mid-month, now inside window",
        hint: { currentPeriodStart: "2026-08-28T09:40:00.000Z", currentPeriodEnd: "2026-09-28T09:40:00.000Z" },
        now: "2026-09-05T00:00:00.000Z",
        periodStart: "2026-08-28T09:40:00.000Z",
        periodEnd: "2026-09-28T09:40:00.000Z",
        periodAnchor: "2026-08-28T09:40:00.000Z",
      },
      {
        name: "monthly month-end anchor (Jan 31 -> Feb 29 leap)",
        hint: { currentPeriodStart: "2024-01-31T12:00:00.000Z", currentPeriodEnd: "2024-02-29T12:00:00.000Z" },
        now: "2024-02-10T00:00:00.000Z",
        periodStart: "2024-01-31T12:00:00.000Z",
        periodEnd: "2024-02-29T12:00:00.000Z",
        periodAnchor: "2024-01-31T12:00:00.000Z",
      },
      {
        name: "monthly, now just after start",
        hint: { currentPeriodStart: "2026-03-15T00:00:00.000Z", currentPeriodEnd: "2026-04-15T00:00:00.000Z" },
        now: "2026-03-15T00:00:01.000Z",
        periodStart: "2026-03-15T00:00:00.000Z",
        periodEnd: "2026-04-15T00:00:00.000Z",
        periodAnchor: "2026-03-15T00:00:00.000Z",
      },
    ];
    for (const c of captured) {
      const p = await computePeriodForPlan("u1", "starter", c.hint, new Date(c.now));
      assertEq(iso(p.periodStart), c.periodStart, `${c.name}: periodStart`);
      assertEq(iso(p.periodEnd), c.periodEnd, `${c.name}: periodEnd`);
      assertEq(iso(p.periodAnchor), c.periodAnchor, `${c.name}: periodAnchor`);
    }
  });

  await test("MONTHLY with a STALE hint (now past the period end) still reproduces the hint verbatim", async () => {
    // A monthly renewal webhook that arrives late, or a lazy ensure after expiry. The
    // stale-window repair in clampToSubscriptionEnd must return [start, end) unchanged -
    // exactly what the pass-through did - and never an inverted period.
    const hint = { currentPeriodStart: "2026-03-15T00:00:00.000Z", currentPeriodEnd: "2026-04-15T00:00:00.000Z" };
    const p = await computePeriodForPlan("u1", "pro", hint, new Date("2026-06-20T00:00:00.000Z"));
    assertEq(iso(p.periodStart), "2026-03-15T00:00:00.000Z", "start verbatim");
    assertEq(iso(p.periodEnd), "2026-04-15T00:00:00.000Z", "end verbatim");
    assert(p.periodEnd.getTime() > p.periodStart.getTime(), "ordered - the RPC would reject otherwise");
  });

  await test("DEGRADED hints keep working (end-only / start-only / neither) and stay ordered", async () => {
    // end-only: paidPeriodFromMirror derives start = end - 1mo and anchors there; the
    // sub-window then reproduces that same month.
    const endOnly = await computePeriodForPlan(
      "u1",
      "pro",
      { currentPeriodEnd: "2024-04-30T00:00:00.000Z" },
      new Date(Date.UTC(2024, 3, 10)),
    );
    assertEq(iso(endOnly.periodStart), "2024-03-30T00:00:00.000Z", "end-only start");
    assertEq(iso(endOnly.periodEnd), "2024-04-30T00:00:00.000Z", "end-only end");

    // start-only: there is NO real subscription end, so nothing is clamped and the
    // window rolls monthly from the start (here: 2 months in).
    const startOnly = await computePeriodForPlan(
      "u1",
      "pro",
      { currentPeriodStart: "2026-05-05T00:00:00.000Z" },
      new Date("2026-07-10T00:00:00.000Z"),
    );
    assertEq(iso(startOnly.periodAnchor), "2026-05-05T00:00:00.000Z", "start-only anchor");
    assertEq(iso(startOnly.periodStart), "2026-07-05T00:00:00.000Z", "start-only rolls monthly, not frozen at the synthetic end");
    assertEq(iso(startOnly.periodEnd), "2026-08-05T00:00:00.000Z", "start-only end");

    // neither: a now-anchored month.
    const neither = await computePeriodForPlan("u1", "pro", {}, new Date(Date.UTC(2024, 6, 7, 9, 0, 0)));
    assertEq(iso(neither.periodStart), "2024-07-07T09:00:00.000Z", "neither: start = now");
    assertEq(iso(neither.periodEnd), "2024-08-07T09:00:00.000Z", "neither: end = now + 1mo");

    for (const p of [endOnly, startOnly, neither]) {
      assert(p.periodEnd.getTime() > p.periodStart.getTime(), "every degraded period stays ordered");
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
