/**
 * test-admin-usage.ts — acceptance gate for the admin usage & plan visibility
 * derivation layer (`src/lib/server/adminUsage.ts`).
 * Run: npx tsx scripts/test-admin-usage.ts   (from web/)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * ═══════════════════════════════════════════════════════════════════════════════
 * The failure this feature is most likely to ship is a CONFIDENT WRONG NUMBER:
 * a query against the wrong table lineage (the v57 `owner_id` shape that does not
 * exist in production) returns nothing, and "nothing" renders as a serene `0 / 800`
 * that no one questions. A test that asks the implementation what it expects would
 * agree with that 0 perfectly.
 *
 * So, two rules hold throughout:
 *
 *  1. INDEPENDENT ORACLE (PRD §5.2). Expected values are recomputed here from the
 *     PRD's definitions and from raw fixture literals. This file NEVER calls
 *     summarizeUsage / effectivePlan / quotaWatchMetricsFor to produce an
 *     expectation — only to produce the value UNDER TEST. Where a rule is
 *     arithmetic ("remaining = max(limit-used,0)"), the arithmetic is written out
 *     again here, from the PRD, not imported.
 *
 *  2. THE THREE STATES ARE PROVEN DISTINGUISHABLE. `metered` with used=0,
 *     `unmetered`, and `unavailable` are asserted to differ from each other on
 *     observable fields — not merely to "look reasonable" individually.
 *
 * MUTATION VERIFICATION (PRD §5.4): this suite was run against three deliberately
 * broken implementations —
 *   (a) query `owner_id` instead of `user_id`,
 *   (b) count `*_reserved` into used,
 *   (c) treat a missing row as used=0 (collapse unmetered into metered-zero)
 * — and each turned it red. See the task report for the recorded results.
 */

// adminUsage → server/entitlements → lib/supabase, which constructs a client at
// module load. These placeholders keep that import from throwing. Nothing here
// talks to a real database: every fixture is in-memory (see adminMockDb) and
// every assertion is pure. They must be set BEFORE the dynamic imports in main().
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import { makeMockDb } from "./adminMockDb";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  OK  ${name}`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
      }
    })(),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// INDEPENDENT ORACLE — the PRD's rules, re-expressed here from the spec text.
// Deliberately duplicated rather than imported. If the implementation and this
// oracle drift apart, that IS the signal.
// ═════════════════════════════════════════════════════════════════════════════

/** PRD §3.1: plan included allowances, transcribed from the v3.1 product contract. */
const ORACLE_INCLUDED: Record<string, { aiImages: number | null; aiTextGenerations: number | null; scheduledPosts: number | null }> = {
  free: { aiImages: 10, aiTextGenerations: 20, scheduledPosts: 5 },
  starter: { aiImages: 150, aiTextGenerations: 500, scheduledPosts: 150 },
  pro: { aiImages: 800, aiTextGenerations: 2000, scheduledPosts: 300 },
  business: { aiImages: 3000, aiTextGenerations: 10000, scheduledPosts: null },
};

/** PRD §3.1 "剩余值规则": remaining = max(limit - used, 0); null when unlimited. */
function oracleRemaining(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  const r = limit - used;
  return r > 0 ? r : 0;
}

/** PRD §3.1: over-limit is reported SEPARATELY, never folded into remaining. */
function oracleOverage(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  return used > limit ? used - limit : null;
}

/** PRD §3.1: unlimited (limit=null) never participates in division. */
function oracleRatio(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return null;
  return used / limit;
}

/** PRD §3.2: quota watch admits only metered + finite positive limit + ratio ≥ 0.8. */
function oracleIsWatched(state: string, used: number | null, limit: number | null): boolean {
  if (state !== "metered") return false;
  if (limit === null) return false;
  if (!(limit > 0)) return false;
  if (used === null) return false;
  return used / limit >= 0.8;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A production-shaped usage_accounts row. Column names are written out literally
 * so this fixture is itself an assertion about the v55/v56 lineage: an
 * implementation that queries `owner_id` finds nothing here.
 */
function accountRow(over: Partial<Record<string, unknown>> & { user_id: string }) {
  return {
    user_id: over.user_id,
    plan_key: "pro",
    period_start: "2026-08-01T09:40:00.000Z",
    period_end: "2026-09-01T09:40:00.000Z",
    ai_images_used: 0,
    ai_images_limit: 800,
    ai_images_reserved: 0,
    ai_text_generations_used: 0,
    ai_text_generations_limit: 2000,
    ai_text_generations_reserved: 0,
    scheduled_posts_used: 0,
    scheduled_posts_limit: 300,
    scheduled_posts_reserved: 0,
    bonus_images_balance: 0,
    version: 1,
    ...over,
  };
}

async function main() {
  const {
    summarizeUsage,
    effectivePlan,
    loadUsageAccounts,
    summarizeUsageForUsers,
    getUserUsageSummary,
    quotaWatchMetricsFor,
    buildQuotaWatch,
    QUOTA_WATCH_THRESHOLD,
    USAGE_ACCOUNT_COLUMNS,
  } = await import("../src/lib/server/adminUsage");

  // ══════════════════════════════════════════════════════════════════════════
  // 1. SCHEMA LINEAGE (PRD §5.1, adapted to a source-level assertion)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The full information_schema assertion needs a live test DB; what CAN be
  // enforced offline — and is the actual defence against F1/F2 — is that this
  // module never names a v57 column and never reaches for the broken helper.

  console.log("\n=== 1. schema lineage (v55/v56 only, never v57) ===");

  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const source = readFileSync(join(process.cwd(), "src/lib/server/adminUsage.ts"), "utf8");
  // Strip comments: the module header discusses the v57 shape on purpose, and a
  // naive grep would flag that prose. Only executable code is examined.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");

  test("adminUsage code never references the v57 columns owner_id / owner_type", () => {
    assert.ok(!/owner_id/.test(code), "owner_id must not appear in executable code (v57 lineage, absent in production)");
    assert.ok(!/owner_type/.test(code), "owner_type must not appear in executable code");
  });

  test("adminUsage never imports the broken v57 helper lib/server/usage.ts", () => {
    const imports = Array.from(source.matchAll(/from\s+["']([^"']+)["']/g), m => m[1]);
    for (const spec of imports) {
      assert.ok(
        !/(^|\/)usage$/.test(spec) && !/server\/usage["']?$/.test(spec),
        `must not import the v57 usage helper (found "${spec}")`,
      );
    }
  });

  test("adminUsage selects user_id (v55/v56) and never selects *_reserved", () => {
    assert.ok(USAGE_ACCOUNT_COLUMNS.includes("user_id"), "must select user_id");
    assert.ok(!/reserved/.test(USAGE_ACCOUNT_COLUMNS), "reserved counters must never be selected");
  });

  test("adminUsage never reads user_metadata (the self-grant escalation path)", () => {
    assert.ok(!/user_metadata/.test(code), "user_metadata must not be referenced in executable code");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. THE THREE STATES ARE DISTINGUISHABLE (PRD §3 / §5.3)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 2. three states: metered-zero vs unmetered vs unavailable ===");

  // A metered row whose counters are genuinely zero.
  const meteredZero = summarizeUsage({
    userId: "u-zero",
    row: accountRow({ user_id: "u-zero" }) as never,
    appMetadata: { plan: "pro" },
  });

  // Query succeeded, no row.
  const unmetered = summarizeUsage({
    userId: "u-none",
    row: null,
    appMetadata: { plan: "pro" },
  });

  // Query failed.
  const unavailable = summarizeUsage({
    userId: "u-err",
    row: null,
    appMetadata: { plan: "pro" },
    unavailable: true,
  });

  test("metered + used=0 reports a MEASURED zero (used === 0, not null)", () => {
    assert.equal(meteredZero.state, "metered");
    assert.equal(meteredZero.metered, true);
    assert.equal(meteredZero.metrics.aiImages.used, 0, "a real measured zero must be 0, not null");
    assert.equal(meteredZero.metrics.scheduledPosts.used, 0);
    // Independent oracle: pro images limit 800, used 0.
    assert.equal(meteredZero.metrics.aiImages.limit, 800);
    assert.equal(meteredZero.metrics.aiImages.remaining, oracleRemaining(0, 800));
    assert.equal(meteredZero.metrics.aiImages.ratio, oracleRatio(0, 800));
  });

  test("unmetered (zero rows) reports used=null and draws NO progress bar", () => {
    assert.equal(unmetered.state, "unmetered");
    assert.equal(unmetered.metered, false);
    assert.equal(unmetered.metrics.aiImages.used, null, "never fabricate a zero for an unmeasured user");
    assert.equal(unmetered.metrics.aiImages.showProgress, false, "no measured fraction ⇒ no bar");
    assert.equal(unmetered.periodStart, null);
    assert.equal(unmetered.periodEnd, null);
    assert.equal(unmetered.bonusImages, null);
    // Included allowance is still knowable from the plan (independent oracle).
    assert.equal(unmetered.metrics.aiImages.included, ORACLE_INCLUDED.pro.aiImages);
    assert.equal(unmetered.metrics.scheduledPosts.included, ORACLE_INCLUDED.pro.scheduledPosts);
  });

  test("unavailable is NEVER downgraded to unmetered", () => {
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.metered, false);
    assert.notEqual(unavailable.state, "unmetered", "a failed read must not claim 'confirmed not metered'");
    assert.equal(unavailable.metrics.aiImages.used, null);
    assert.equal(unavailable.metrics.aiImages.showProgress, false);
  });

  test("metered-zero and unmetered are observably DIFFERENT (the honesty bug)", () => {
    assert.notEqual(
      meteredZero.metrics.aiImages.used,
      unmetered.metrics.aiImages.used,
      "measured-0 and never-measured must not render identically",
    );
    assert.equal(meteredZero.metrics.aiImages.used, 0);
    assert.equal(unmetered.metrics.aiImages.used, null);
    assert.equal(meteredZero.state === unmetered.state, false);
  });

  test("unmetered and unavailable are observably DIFFERENT", () => {
    assert.notEqual(unmetered.state, unavailable.state);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. RESERVED IS NOT USED (PRD §3.1 诚实性要求)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 3. reserved is in-flight, never counted as used ===");

  test("used and reserved both non-zero → only SETTLED used is reported", () => {
    const row = accountRow({
      user_id: "u-res",
      ai_images_used: 12,
      ai_images_reserved: 7,
      ai_text_generations_used: 3,
      ai_text_generations_reserved: 40,
      scheduled_posts_used: 100,
      scheduled_posts_reserved: 25,
    });
    const s = summarizeUsage({ userId: "u-res", row: row as never, appMetadata: { plan: "pro" } });

    // Oracle: used is exactly the settled column; reserved contributes nothing.
    assert.equal(s.metrics.aiImages.used, 12, "used must be the settled counter alone (12, not 19)");
    assert.equal(s.metrics.aiTextGenerations.used, 3, "expected 3, not 43");
    assert.equal(s.metrics.scheduledPosts.used, 100, "expected 100, not 125");

    // And every derived number follows from the settled value.
    assert.equal(s.metrics.aiImages.remaining, oracleRemaining(12, 800));
    assert.equal(s.metrics.scheduledPosts.remaining, oracleRemaining(100, 300));
    assert.equal(s.metrics.scheduledPosts.ratio, oracleRatio(100, 300));
  });

  test("a reserved-heavy row does NOT cross the 80% watch threshold", () => {
    // used 200 / limit 300 = 66.7% (watch: no). used+reserved = 260/300 = 86.7%
    // (watch: yes) — so this fixture separates the two readings.
    const row = accountRow({
      user_id: "u-res2",
      scheduled_posts_used: 200,
      scheduled_posts_reserved: 60,
    });
    const s = summarizeUsage({ userId: "u-res2", row: row as never, appMetadata: { plan: "pro" } });
    assert.equal(oracleIsWatched("metered", 200, 300), false, "oracle: settled 200/300 is below 80%");
    const watched = quotaWatchMetricsFor(s).map(m => m.key);
    assert.ok(!watched.includes("scheduledPosts"), "counting reserved would wrongly raise a quota alert");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. THRESHOLD ARITHMETIC: 79% / exactly 80% / over 100% (PRD §5.3)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 4. 79% / exactly 80% / over 100% ===");

  test("79% is below the watch threshold; 80% exactly is AT it (inclusive)", () => {
    const at79 = summarizeUsage({
      userId: "u79",
      row: accountRow({ user_id: "u79", scheduled_posts_used: 237, scheduled_posts_limit: 300 }) as never,
      appMetadata: { plan: "pro" },
    });
    const at80 = summarizeUsage({
      userId: "u80",
      row: accountRow({ user_id: "u80", scheduled_posts_used: 240, scheduled_posts_limit: 300 }) as never,
      appMetadata: { plan: "pro" },
    });

    // Oracle arithmetic, computed here from the raw fixture numbers.
    assert.equal(oracleRatio(237, 300), 0.79);
    assert.equal(oracleRatio(240, 300), 0.8);
    assert.equal(oracleIsWatched("metered", 237, 300), false);
    assert.equal(oracleIsWatched("metered", 240, 300), true);

    assert.equal(at79.metrics.scheduledPosts.ratio, 0.79);
    assert.equal(at80.metrics.scheduledPosts.ratio, 0.8);
    assert.equal(QUOTA_WATCH_THRESHOLD, 0.8);

    assert.equal(quotaWatchMetricsFor(at79).length, 0, "79% must not raise a quota alert");
    const w80 = quotaWatchMetricsFor(at80);
    assert.equal(w80.length, 1, "exactly 80% must raise a quota alert (>= is inclusive)");
    assert.equal(w80[0].key, "scheduledPosts");
    assert.equal(w80[0].remaining, oracleRemaining(240, 300));
  });

  test("used > limit shows overage separately, remaining clamps to 0 (not hidden)", () => {
    const s = summarizeUsage({
      userId: "u-over",
      row: accountRow({ user_id: "u-over", ai_images_used: 905, ai_images_limit: 800 }) as never,
      appMetadata: { plan: "pro" },
    });
    const m = s.metrics.aiImages;
    assert.equal(m.used, 905, "the real used value must survive — not be clamped to the limit");
    assert.equal(m.remaining, oracleRemaining(905, 800), "remaining floors at 0");
    assert.equal(m.remaining, 0);
    assert.equal(m.overage, oracleOverage(905, 800), "the 105 overshoot must be reported");
    assert.equal(m.overage, 105);
    assert.ok(m.ratio !== null && m.ratio > 1, "ratio exceeds 1 rather than saturating");
    assert.ok(s.anomalies.includes("over_limit:aiImages"), "over-limit is a data-quality signal");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. UNLIMITED (limit = null) (PRD §3.1 / §5.3)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 5. limit = null (unlimited) ===");

  test("unlimited: no division, no remaining, no progress bar, never watched", () => {
    const s = summarizeUsage({
      userId: "u-biz",
      row: accountRow({
        user_id: "u-biz",
        plan_key: "business",
        scheduled_posts_used: 5000,
        scheduled_posts_limit: null,
      }) as never,
      appMetadata: { plan: "business" },
    });
    const m = s.metrics.scheduledPosts;
    assert.equal(m.unlimited, true);
    assert.equal(m.used, 5000, "usage is still measured and shown");
    assert.equal(m.limit, null);
    assert.equal(m.remaining, oracleRemaining(5000, null), "remaining is undefined for unlimited");
    assert.equal(m.remaining, null);
    assert.equal(m.ratio, oracleRatio(5000, null));
    assert.equal(m.ratio, null, "must not divide by an unlimited denominator");
    assert.equal(m.overage, oracleOverage(5000, null));
    assert.equal(m.showProgress, false, "no bar without a denominator");
    assert.equal(oracleIsWatched("metered", 5000, null), false);
    assert.equal(quotaWatchMetricsFor(s).some(x => x.key === "scheduledPosts"), false);
    // The business plan's advertised value is itself unlimited (independent oracle).
    assert.equal(m.included, ORACLE_INCLUDED.business.scheduledPosts);
  });

  test("a finite limit of 0 is a real cap, not unlimited, and is not divided by", () => {
    const s = summarizeUsage({
      userId: "u-zerolimit",
      row: accountRow({ user_id: "u-zerolimit", plan_key: "free", ai_images_used: 0, ai_images_limit: 0 }) as never,
      appMetadata: { plan: "free" },
    });
    const m = s.metrics.aiImages;
    assert.equal(m.unlimited, false, "0 is a cap, null is unlimited — they must not collapse");
    assert.equal(m.limit, 0);
    assert.equal(m.remaining, oracleRemaining(0, 0));
    assert.equal(m.remaining, 0);
    assert.equal(m.ratio, oracleRatio(0, 0), "0/0 has no meaningful ratio");
    assert.equal(m.ratio, null);
    assert.equal(m.showProgress, false);
    assert.equal(oracleIsWatched("metered", 0, 0), false);
    assert.equal(quotaWatchMetricsFor(s).length, 0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. PLAN RESOLUTION + DRIFT + THE user_metadata TRUST BOUNDARY
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 6. plan resolution, drift, and the trust boundary ===");

  test("SECURITY: a forged user_metadata.plan is inert (never surfaces as paid)", () => {
    // The escalation the e2543f6 / d8dbb9f fixes closed: a user CAN edit their own
    // user_metadata. summarizeUsage takes app_metadata only, so even when the
    // forged bag is handed in under the wrong key the answer must stay free.
    const forged = summarizeUsage({
      userId: "u-forge",
      row: null,
      appMetadata: null,
    });
    assert.equal(forged.plan, "free", "with no trusted plan the answer is free");
    assert.equal(forged.planSource, "default");

    // And explicitly: passing the user-editable bag through the app_metadata
    // parameter is the ONLY way it could ever be read — callers must not. Prove
    // no caller does, at the source level.
    const detailPage = readFileSync(join(process.cwd(), "src/app/admin/users/[id]/page.tsx"), "utf8");
    assert.ok(
      !/user_metadata/.test(detailPage),
      "the Customer 360 page must never pass user_metadata into the usage layer",
    );
    const listSource = readFileSync(join(process.cwd(), "src/lib/server/customer360.ts"), "utf8");
    assert.ok(
      !/appMetadata:\s*\w*\.?user_metadata/.test(listSource),
      "the list loader must never feed user_metadata into the plan resolver",
    );
  });

  test("app_metadata.plan is used when there is no account snapshot", () => {
    const r = effectivePlan(null, { plan: "starter" });
    assert.equal(r.plan, "starter");
    assert.equal(r.source, "appMetadata");
    assert.equal(r.drift, false, "one source alone cannot disagree with itself");
  });

  test("account snapshot WINS over app_metadata, and the conflict is flagged", () => {
    // PRD §3.1 套餐冲突: show the enforced snapshot, but do not hide the drift.
    const r = effectivePlan("pro", { plan: "starter" });
    assert.equal(r.plan, "pro", "the enforced snapshot is what the user is actually capped by");
    assert.equal(r.source, "account");
    assert.equal(r.drift, true, "disagreement must be observable, not silently resolved");
    assert.equal(r.accountPlan, "pro");
    assert.equal(r.appMetadataPlan, "starter");

    const s = summarizeUsage({
      userId: "u-drift",
      row: accountRow({ user_id: "u-drift", plan_key: "pro" }) as never,
      appMetadata: { plan: "starter" },
    });
    assert.equal(s.plan, "pro");
    assert.equal(s.planDrift, true);
    assert.ok(s.anomalies.includes("plan_drift"));
    // Included values follow the DISPLAYED plan, so the card is internally
    // consistent (independent oracle: pro, not starter).
    assert.equal(s.metrics.aiImages.included, ORACLE_INCLUDED.pro.aiImages);
    assert.notEqual(s.metrics.aiImages.included, ORACLE_INCLUDED.starter.aiImages);
  });

  test("agreeing sources are NOT reported as drift", () => {
    const r = effectivePlan("pro", { plan: "pro" });
    assert.equal(r.drift, false);
    assert.equal(r.plan, "pro");
  });

  test("mid-period plan change: the snapshot's limits stay authoritative", () => {
    // Billing moved them to business; the account row still enforces pro's 800.
    const s = summarizeUsage({
      userId: "u-upgrade",
      row: accountRow({ user_id: "u-upgrade", plan_key: "pro", ai_images_used: 700, ai_images_limit: 800 }) as never,
      appMetadata: { plan: "business" },
    });
    assert.equal(s.plan, "pro", "the plan actually being enforced this period");
    assert.equal(s.planDrift, true);
    assert.equal(s.metrics.aiImages.limit, 800, "the enforced cap, not the new plan's 3000");
    assert.equal(s.metrics.aiImages.remaining, oracleRemaining(700, 800));
    assert.equal(s.metrics.aiImages.remaining, 100);
  });

  test("ONE effectivePlan: card, list, and filter cannot disagree", () => {
    // The list row and the detail card must resolve identically for the same
    // inputs — the "appears under Pro, detail says Starter" failure.
    const inputs = { snapshot: "business" as const, app: { plan: "free" } };
    const viaResolver = effectivePlan(inputs.snapshot, inputs.app);
    const viaSummary = summarizeUsage({
      userId: "u-same",
      row: accountRow({ user_id: "u-same", plan_key: inputs.snapshot }) as never,
      appMetadata: inputs.app,
    });
    assert.equal(viaSummary.plan, viaResolver.plan);
    assert.equal(viaSummary.planSource, viaResolver.source);
    assert.equal(viaSummary.planDrift, viaResolver.drift);
  });

  test("legacy plan aliases and unknown strings resolve predictably", () => {
    assert.equal(effectivePlan("growth", null).plan, "pro", "legacy alias growth → pro");
    assert.equal(effectivePlan("wat", null).plan, "free", "unrecognized → free floor");
    assert.equal(effectivePlan(null, { plan: 42 }).plan, "free", "non-string is not a plan");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 7. BILLING PERIOD EDGES (PRD §5.3)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 7. period just started / just ended / expired ===");

  test("a period that just started, just ended, and long expired all stay metered", () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const day = 86_400_000;

    const justStarted = summarizeUsage({
      userId: "p1",
      row: accountRow({ user_id: "p1", period_start: iso(now - 60_000), period_end: iso(now + 30 * day) }) as never,
      appMetadata: { plan: "pro" },
    });
    const justEnded = summarizeUsage({
      userId: "p2",
      row: accountRow({ user_id: "p2", period_start: iso(now - 30 * day), period_end: iso(now - 60_000) }) as never,
      appMetadata: { plan: "pro" },
    });
    const longExpired = summarizeUsage({
      userId: "p3",
      row: accountRow({ user_id: "p3", period_start: iso(now - 400 * day), period_end: iso(now - 370 * day) }) as never,
      appMetadata: { plan: "pro" },
    });

    for (const s of [justStarted, justEnded, longExpired]) {
      assert.equal(s.state, "metered", "an expired period is still measured data, not unmetered");
      assert.ok(!s.anomalies.includes("invalid_period"), "a well-ordered period is not an anomaly");
      assert.ok(!s.anomalies.includes("missing_period"));
    }

    // Quota watch reports how long is left, and goes negative once lapsed —
    // the operator needs to know a "90% used" row is from a dead period.
    const watch = buildQuotaWatch(
      [
        summarizeUsage({
          userId: "p2",
          row: accountRow({
            user_id: "p2",
            period_start: iso(now - 30 * day),
            period_end: iso(now - 60_000),
            scheduled_posts_used: 290,
          }) as never,
          appMetadata: { plan: "pro" },
        }),
      ],
      new Map([["p2", "p2@x.com"]]),
      now,
    );
    assert.equal(watch.length, 1);
    assert.ok(watch[0].msUntilPeriodEnd !== null && watch[0].msUntilPeriodEnd < 0, "a lapsed period reads as negative time left");
  });

  test("a missing or inverted period is flagged, not silently accepted", () => {
    const noPeriod = summarizeUsage({
      userId: "p4",
      row: accountRow({ user_id: "p4", period_start: null, period_end: null }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.ok(noPeriod.anomalies.includes("missing_period"));

    const inverted = summarizeUsage({
      userId: "p5",
      row: accountRow({ user_id: "p5", period_start: "2026-09-01T00:00:00Z", period_end: "2026-08-01T00:00:00Z" }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.ok(inverted.anomalies.includes("invalid_period"));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. FAILURE MODES ALL BECOME `unavailable` (PRD §5.3 / §3)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 8. missing table / missing column / permission / network → unavailable ===");

  const FAILURES: Array<{ label: string; error: { code?: string; message?: string } }> = [
    { label: "missing table (42P01)", error: { code: "42P01", message: 'relation "usage_accounts" does not exist' } },
    { label: "missing table (PostgREST PGRST205)", error: { code: "PGRST205", message: "Could not find the table 'public.usage_accounts'" } },
    { label: "missing column (42703)", error: { code: "42703", message: 'column "plan_key" does not exist' } },
    { label: "missing column (PostgREST PGRST204)", error: { code: "PGRST204", message: "Could not find the 'plan_key' column" } },
    { label: "permission denied (42501)", error: { code: "42501", message: "permission denied for table usage_accounts" } },
    { label: "network / timeout", error: { message: "fetch failed: ETIMEDOUT" } },
  ];

  for (const f of FAILURES) {
    test(`${f.label} → unavailable for EVERY user (never unmetered)`, async () => {
      const { db } = makeMockDb({ usage_accounts: { error: f.error } });
      const cohort = await summarizeUsageForUsers(
        [
          { id: "a", app_metadata: { plan: "pro" } },
          { id: "b", app_metadata: null },
        ],
        db,
      );
      assert.equal(cohort.available, false, "a failed read must be reported as unavailable");
      assert.ok(cohort.warnings.length > 0, "a failure must produce an operator-visible warning");
      for (const id of ["a", "b"]) {
        const s = cohort.byUser.get(id);
        assert.ok(s, `every requested user must get an entry (${id})`);
        assert.equal(s!.state, "unavailable", `${id} must be unavailable, not unmetered`);
        assert.notEqual(s!.state, "unmetered");
        assert.equal(s!.metrics.aiImages.used, null, "never fabricate a number from a failed read");
      }
    });
  }

  test("a totally absent usage_accounts table degrades, it does not throw", async () => {
    // No table registered in the mock at all → the mock answers 42P01.
    const { db } = makeMockDb({});
    const cohort = await summarizeUsageForUsers([{ id: "a", app_metadata: { plan: "pro" } }], db);
    assert.equal(cohort.available, false);
    assert.equal(cohort.byUser.get("a")!.state, "unavailable");
  });

  test("a failed read still resolves the plan from app_metadata (degrade, don't blank)", async () => {
    const { db } = makeMockDb({ usage_accounts: { error: { code: "42501", message: "permission denied" } } });
    const { summary } = await getUserUsageSummary({ id: "a", app_metadata: { plan: "business" } }, db);
    assert.equal(summary.state, "unavailable");
    assert.equal(summary.plan, "business", "the plan is knowable even when usage is not");
    assert.equal(summary.metrics.scheduledPosts.included, ORACLE_INCLUDED.business.scheduledPosts);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 9. BATCH LOADER: no N+1, no cross-user contamination (PRD §5.3 / §4)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 9. batch loader: correctness across users, no N+1 ===");

  test("two different users get their OWN numbers (the Map must not cross wires)", async () => {
    const { db } = makeMockDb({
      usage_accounts: {
        rows: [
          accountRow({ user_id: "user-A", plan_key: "pro", ai_images_used: 2, scheduled_posts_used: 107 }),
          accountRow({ user_id: "user-B", plan_key: "starter", ai_images_used: 149, ai_images_limit: 150, scheduled_posts_used: 3, scheduled_posts_limit: 150 }),
        ],
      },
    });
    const cohort = await summarizeUsageForUsers(
      [
        { id: "user-A", app_metadata: { plan: "pro" } },
        { id: "user-B", app_metadata: { plan: "starter" } },
        { id: "user-C", app_metadata: { plan: "free" } }, // no row at all
      ],
      db,
    );

    const a = cohort.byUser.get("user-A")!;
    const b = cohort.byUser.get("user-B")!;
    const c = cohort.byUser.get("user-C")!;

    // Independent oracle per user, from the fixture literals above.
    assert.equal(a.plan, "pro");
    assert.equal(a.metrics.aiImages.used, 2);
    assert.equal(a.metrics.scheduledPosts.used, 107);
    assert.equal(a.metrics.scheduledPosts.remaining, oracleRemaining(107, 300));

    assert.equal(b.plan, "starter");
    assert.equal(b.metrics.aiImages.used, 149);
    assert.equal(b.metrics.aiImages.limit, 150);
    assert.equal(b.metrics.aiImages.remaining, oracleRemaining(149, 150));
    assert.equal(b.metrics.scheduledPosts.used, 3);

    // Cross-check they did not swap.
    assert.notEqual(a.metrics.aiImages.used, b.metrics.aiImages.used);
    assert.notEqual(a.plan, b.plan);

    // The third user really has no row — and that is unmetered, not unavailable.
    assert.equal(c.state, "unmetered");
    assert.equal(c.plan, "free");
    assert.equal(c.metrics.aiImages.used, null);
  });

  test("the loader is BATCHED: one round trip per chunk, not one per user", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => accountRow({ user_id: `u${i}`, ai_images_used: i }));
    const { db, roundTrips } = makeMockDb({ usage_accounts: { rows } });
    const ids = rows.map(r => r.user_id);
    const load = await loadUsageAccounts(ids, db);
    assert.equal(load.byUser.size, 40);
    assert.ok(
      roundTrips() <= 2,
      `expected a single batched query (plus at most one short-page probe), got ${roundTrips()} — this is the N+1 guard`,
    );
    // And the values still line up per user.
    assert.equal(load.byUser.get("u7")!.ai_images_used, 7);
    assert.equal(load.byUser.get("u39")!.ai_images_used, 39);
  });

  test("requesting a user with no row yields NO map entry (absence stays absence)", async () => {
    const { db } = makeMockDb({ usage_accounts: { rows: [accountRow({ user_id: "has-row" })] } });
    const load = await loadUsageAccounts(["has-row", "no-row"], db);
    assert.equal(load.available, true, "zero rows for one user is a successful read");
    assert.equal(load.byUser.has("has-row"), true);
    assert.equal(load.byUser.has("no-row"), false, "must not invent an empty row");
  });

  test("an empty id list short-circuits without querying", async () => {
    const { db, roundTrips } = makeMockDb({ usage_accounts: { rows: [] } });
    const load = await loadUsageAccounts([], db);
    assert.equal(load.available, true);
    assert.equal(load.byUser.size, 0);
    assert.equal(roundTrips(), 0);
  });

  test("duplicate account rows for one user are surfaced as an anomaly", async () => {
    const { db } = makeMockDb({
      usage_accounts: {
        rows: [
          accountRow({ user_id: "dup", ai_images_used: 5 }),
          accountRow({ user_id: "dup", ai_images_used: 900 }),
        ],
      },
    });
    const cohort = await summarizeUsageForUsers([{ id: "dup", app_metadata: null }], db);
    const s = cohort.byUser.get("dup")!;
    assert.ok(s.anomalies.includes("duplicate_account_rows"), "a second row is a data-quality problem, not something to average away");
    assert.ok(cohort.warnings.some(w => /more than one/.test(w)));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 10. QUOTA WATCH SCOPE (PRD §3.2)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 10. quota watch: only metered + finite positive limit ===");

  test("quota watch excludes unmetered, unavailable, and unlimited users", () => {
    const unmeteredHeavyPlan = summarizeUsage({ userId: "q1", row: null, appMetadata: { plan: "free" } });
    const failedRead = summarizeUsage({ userId: "q2", row: null, appMetadata: { plan: "pro" }, unavailable: true });
    const unlimitedNearlyEverything = summarizeUsage({
      userId: "q3",
      row: accountRow({ user_id: "q3", plan_key: "business", scheduled_posts_used: 99999, scheduled_posts_limit: null }) as never,
      appMetadata: { plan: "business" },
    });
    const genuinelyHigh = summarizeUsage({
      userId: "q4",
      row: accountRow({ user_id: "q4", ai_images_used: 790, ai_images_limit: 800 }) as never,
      appMetadata: { plan: "pro" },
    });

    const items = buildQuotaWatch(
      [unmeteredHeavyPlan, failedRead, unlimitedNearlyEverything, genuinelyHigh],
      new Map([["q4", "q4@x.com"]]),
    );
    assert.equal(items.length, 1, "only the metered, finite-limit, ≥80% user qualifies");
    assert.equal(items[0].userId, "q4");
    assert.equal(items[0].email, "q4@x.com");
    // Oracle: 790/800 = 98.75%, remaining 10.
    assert.equal(items[0].metrics[0].ratio, oracleRatio(790, 800));
    assert.equal(items[0].metrics[0].remaining, oracleRemaining(790, 800));
    assert.equal(items[0].metrics[0].remaining, 10);
  });

  test("quota watch reports absolute remaining and time left, not just a percentage", () => {
    const now = Date.parse("2026-08-20T00:00:00Z");
    const s = summarizeUsage({
      userId: "q5",
      row: accountRow({
        user_id: "q5",
        period_start: "2026-08-01T00:00:00Z",
        period_end: "2026-09-01T00:00:00Z",
        scheduled_posts_used: 285,
      }) as never,
      appMetadata: { plan: "pro" },
    });
    const [item] = buildQuotaWatch([s], new Map(), now);
    assert.ok(item, "285/300 = 95% must be watched");
    assert.equal(item.metrics[0].remaining, oracleRemaining(285, 300));
    assert.equal(item.metrics[0].remaining, 15);
    assert.equal(item.msUntilPeriodEnd, Date.parse("2026-09-01T00:00:00Z") - now);
  });

  test("quota watch sorts worst-first and lists every breaching bucket", () => {
    const s = summarizeUsage({
      userId: "q6",
      row: accountRow({
        user_id: "q6",
        ai_images_used: 700, // 87.5%
        ai_text_generations_used: 1980, // 99%
        scheduled_posts_used: 100, // 33% — below threshold
      }) as never,
      appMetadata: { plan: "pro" },
    });
    const [item] = buildQuotaWatch([s], new Map());
    assert.equal(item.metrics.length, 2, "only the two breaching buckets");
    assert.equal(item.metrics[0].key, "aiTextGenerations", "worst bucket first");
    assert.equal(item.metrics[1].key, "aiImages");
    assert.equal(item.topRatio, oracleRatio(1980, 2000));
    assert.ok(!item.metrics.some(m => m.key === "scheduledPosts"));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 11. ANOMALIES ARE SURFACED, NOT LAUNDERED (PRD §7 risk table)
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 11. anomalous values are flagged, never washed to 0 ===");

  test("a negative counter is flagged rather than silently accepted", () => {
    const s = summarizeUsage({
      userId: "neg",
      row: accountRow({ user_id: "neg", ai_images_used: -5 }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.ok(s.anomalies.includes("negative_used:aiImages"));
    assert.equal(s.metrics.aiImages.used, -5, "the real (bad) value is shown, not scrubbed");
  });

  test("a null counter on an existing row reads as a measured 0", () => {
    // Distinct from "no row": the row exists, so nothing consumed really is 0.
    const s = summarizeUsage({
      userId: "nullcol",
      row: accountRow({ user_id: "nullcol", ai_images_used: null }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.equal(s.state, "metered");
    assert.equal(s.metrics.aiImages.used, 0);
  });

  test("bonus image balance is reported when metered and null when not", () => {
    const withBonus = summarizeUsage({
      userId: "bon",
      row: accountRow({ user_id: "bon", bonus_images_balance: 25 }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.equal(withBonus.bonusImages, 25);
    const zeroBonus = summarizeUsage({
      userId: "bon0",
      row: accountRow({ user_id: "bon0", bonus_images_balance: 0 }) as never,
      appMetadata: { plan: "pro" },
    });
    assert.equal(zeroBonus.bonusImages, 0, "a measured zero bonus is 0 (the UI decides to hide the row)");
    assert.equal(unmetered.bonusImages, null);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 12. PRODUCTION-SHAPED REGRESSION
  // ══════════════════════════════════════════════════════════════════════════

  console.log("\n=== 12. the real production row, end to end ===");

  test("the live production account row derives the documented numbers", async () => {
    // Verified production values (2026-08-31): pro, 2/800 images, 1/2000 text,
    // 107/300 scheduled, bonus 0. Every expectation below is arithmetic on those
    // literals, not a call into the implementation.
    const { db } = makeMockDb({
      usage_accounts: {
        rows: [
          accountRow({
            user_id: "e9324dfa",
            plan_key: "pro",
            ai_images_used: 2,
            ai_images_limit: 800,
            ai_text_generations_used: 1,
            ai_text_generations_limit: 2000,
            scheduled_posts_used: 107,
            scheduled_posts_limit: 300,
            bonus_images_balance: 0,
          }),
        ],
      },
    });
    const { summary } = await getUserUsageSummary({ id: "e9324dfa", app_metadata: { plan: "pro" } }, db);

    assert.equal(summary.state, "metered");
    assert.equal(summary.plan, "pro");
    assert.equal(summary.planDrift, false);
    assert.equal(summary.bonusImages, 0);

    assert.equal(summary.metrics.aiImages.used, 2);
    assert.equal(summary.metrics.aiImages.remaining, oracleRemaining(2, 800));
    assert.equal(summary.metrics.aiImages.remaining, 798);

    assert.equal(summary.metrics.aiTextGenerations.used, 1);
    assert.equal(summary.metrics.aiTextGenerations.remaining, oracleRemaining(1, 2000));

    assert.equal(summary.metrics.scheduledPosts.used, 107);
    assert.equal(summary.metrics.scheduledPosts.remaining, oracleRemaining(107, 300));
    assert.equal(summary.metrics.scheduledPosts.remaining, 193);
    assert.equal(summary.metrics.scheduledPosts.ratio, oracleRatio(107, 300));

    // Nobody in production is near 80% today — the card must not invent an alert.
    assert.equal(quotaWatchMetricsFor(summary).length, 0);
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
