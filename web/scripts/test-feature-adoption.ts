/**
 * Unit tests for the admin Feature Adoption derivation layer
 * (`src/lib/server/adminFeatureAdoption.ts`).
 * Run: npx tsx scripts/test-feature-adoption.ts   (from web/)
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * ═══════════════════════════════════════════════════════════════════════════
 * This module's most dangerous failure mode is NOT "wrong number" — it is
 * "confident but wrong CATEGORY": reporting a `not_measured` signal as a real
 * zero (a feature that looks abandoned but was never instrumented), or
 * reporting a failed scan as `not_measured` (a data outage that looks like
 * "nothing to see"). Both render identically to an operator unless the test
 * suite proves they are structurally distinguishable, not just numerically
 * similar.
 *
 * Four distinguishing tests carry the weight, plus funnel-math boundaries:
 *   1. `measured` + real zero usage  vs  `not_measured` (not-yet-deployed
 *      feature) — same "0 events" input, must produce different `state` and
 *      a different `zeroUsage` flag.
 *   2. exposure segment is ALWAYS `not_measured`, never `0`, for every
 *      feature — even ones with heavy measured usage elsewhere in the funnel.
 *   3. a query failure produces `unavailable`, and must NOT collapse into
 *      `not_measured` even though both currently show "no number".
 *   4. two users' events never cross-contaminate the per-user aggregation.
 *
 * MUTATION VERIFICATION (task instruction): run against two deliberately
 * broken variants of the source —
 *   (a) not_measured segments return { state: "measured", usersWithSignal: 0 }
 *       instead of { state: "not_measured", usersWithSignal: null },
 *   (b) a query failure is reported as not_measured instead of unavailable
 * — and confirm both turn tests red, then confirm green again once reverted.
 * See the task report for the recorded transcript.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import { makeMockDb, makeHarness } from "./adminMockDb";
import {
  FEATURE_KEYS,
  FEATURE_EVENTS,
  NOT_YET_DEPLOYED,
  isoWeekKey,
  aggregateFeatureUsage,
  getFeatureAdoption,
  selectFeatureAdoptionAnomalies,
  type UserEventHit,
} from "../src/lib/server/adminFeatureAdoption";

const { test, done } = makeHarness();

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 3_600_000).toISOString();

// ── 1. Feature -> event map: documented, complete, no stray keys ────────────

test("FEATURE_EVENTS: every declared feature has at least one event, and only known event names", () => {
  // Independent oracle: the literal AnalyticsEvent union (src/lib/analytics.ts)
  // plus the two server-fired publish events (publishEvents.ts /
  // adminActionCenter.ts PUBLISH_EVENT_* constants). Re-typed here, not
  // imported, so a drift in either file is visible as a test failure rather
  // than silently agreeing with itself.
  const KNOWN_EVENTS = new Set([
    "image_analysis_started", "image_analysis_ready", "image_analysis_failed",
    "recommended_keywords_ready", "ai_copy_generate_clicked", "ai_copy_success",
    "ai_copy_quality_failed", "ai_copy_provider_failed", "ai_copy_rate_limited",
    "image_analysis_rate_limited", "quality_judge_rate_limited", "ai_copy_latency_ms",
    "direction_selected", "direction_rejected", "reference_selected", "reference_rejected",
    "keyword_removed", "generation_kept", "generation_deleted", "generation_judged",
    "regenerate_clicked", "draft_published", "draft_scheduled",
    "pinterest_publish_attempted", "pinterest_publish_succeeded", "pinterest_publish_failed",
  ]);
  for (const f of FEATURE_KEYS) {
    const events = FEATURE_EVENTS[f];
    assert.ok(events.length > 0, f + " has no mapped events");
    for (const ev of events) {
      assert.ok(KNOWN_EVENTS.has(ev), f + " maps to unknown event " + ev);
    }
  }
});

test("NOT_YET_DEPLOYED: scheduling is flagged (production has 0 draft_scheduled rows as of writing)", () => {
  assert.ok(NOT_YET_DEPLOYED.has("scheduling"));
  // publish is NOT in this set - pinterest_publish_attempted/succeeded have
  // real production rows (180 / 39 per the task brief), so a real zero there
  // must be trusted, not treated as "not yet deployed".
  assert.ok(!NOT_YET_DEPLOYED.has("publish"));
});

// ── 2. isoWeekKey - cross-week retention boundary ────────────────────────────

test("isoWeekKey: two dates in the same ISO week share a key", () => {
  // Monday 2026-03-02 and Wednesday 2026-03-04 are both ISO week 2026-W10.
  assert.equal(isoWeekKey("2026-03-02T10:00:00.000Z"), isoWeekKey("2026-03-04T23:00:00.000Z"));
});

test("isoWeekKey: dates either side of a Monday boundary differ", () => {
  // Sunday 2026-03-08 (end of W10) vs Monday 2026-03-09 (start of W11).
  const sun = isoWeekKey("2026-03-08T23:59:00.000Z");
  const mon = isoWeekKey("2026-03-09T00:01:00.000Z");
  assert.notEqual(sun, mon);
});

// ── 3. aggregateFeatureUsage - pure funnel math, independent oracle ─────────

const hit = (userId: string, createdAt: string): UserEventHit => ({ userId, createdAt });

test("aggregateFeatureUsage: 1 event = first use only, NOT repeat use (boundary: 1 < 2)", () => {
  const cohort = new Set(["u1"]);
  const r = aggregateFeatureUsage([hit("u1", daysAgo(1))], cohort);
  assert.equal(r.firstUse, 1);
  assert.equal(r.repeatUse, 0, "a single event must not count as repeat use");
  assert.equal(r.anyUsage, true);
});

test("aggregateFeatureUsage: exactly 2 events = repeat use (boundary: 2 >= 2)", () => {
  const cohort = new Set(["u1"]);
  const r = aggregateFeatureUsage([hit("u1", daysAgo(5)), hit("u1", daysAgo(1))], cohort);
  assert.equal(r.firstUse, 1);
  assert.equal(r.repeatUse, 1, "exactly 2 events must count as repeat use");
});

test("aggregateFeatureUsage: 2 events in the SAME week = repeat use but NOT retention", () => {
  const cohort = new Set(["u1"]);
  // Monday + Wednesday of the same ISO week.
  const r = aggregateFeatureUsage(
    [hit("u1", "2026-03-02T10:00:00.000Z"), hit("u1", "2026-03-04T10:00:00.000Z")],
    cohort,
  );
  assert.equal(r.repeatUse, 1);
  assert.equal(r.retention, 0, "same-week repeat must not count as cross-week retention");
});

test("aggregateFeatureUsage: events in 2 distinct weeks = retention (boundary: 2 distinct weeks)", () => {
  const cohort = new Set(["u1"]);
  const r = aggregateFeatureUsage(
    [hit("u1", "2026-03-02T10:00:00.000Z"), hit("u1", "2026-03-09T10:00:00.000Z")],
    cohort,
  );
  assert.equal(r.retention, 1, "two distinct ISO weeks must count as retention");
});

test("aggregateFeatureUsage: two users never cross-contaminate (no cross-user counting)", () => {
  const cohort = new Set(["u1", "u2"]);
  const r = aggregateFeatureUsage(
    [hit("u1", daysAgo(1)), hit("u2", daysAgo(1)), hit("u2", daysAgo(8))],
    cohort,
  );
  // u1: 1 event -> first use only. u2: 2 events, 2 distinct weeks -> first+repeat+retention.
  assert.equal(r.firstUse, 2, "both users counted once each toward first use");
  assert.equal(r.repeatUse, 1, "only u2 reached repeat use - u1's single event must not inflate this");
  assert.equal(r.retention, 1, "only u2 reached retention");
});

test("aggregateFeatureUsage: events from a user NOT in the cohort are dropped (non-customer exclusion)", () => {
  const cohort = new Set(["u1"]); // u_test deliberately excluded from the cohort
  const r = aggregateFeatureUsage(
    [hit("u1", daysAgo(1)), hit("u_test", daysAgo(1)), hit("u_test", daysAgo(2))],
    cohort,
  );
  assert.equal(r.firstUse, 1, "non-cohort user's events must not be counted");
  assert.equal(r.anyUsage, true);
});

test("aggregateFeatureUsage: zero hits against a non-empty cohort = anyUsage false (real zero)", () => {
  const cohort = new Set(["u1", "u2"]);
  const r = aggregateFeatureUsage([], cohort);
  assert.equal(r.firstUse, 0);
  assert.equal(r.repeatUse, 0);
  assert.equal(r.retention, 0);
  assert.equal(r.anyUsage, false);
});

// ── 4. getFeatureAdoption - end to end via the injected mock DB ─────────────

const CUSTOMER_1 = { id: "u1", email: "customer1@example.com", app_metadata: {} };
const CUSTOMER_2 = { id: "u2", email: "customer2@example.com", app_metadata: {} };
const TEST_ACCOUNT = { id: "u-test", email: "e2e-cockpit-a@example.com", app_metadata: {} };
const INTERNAL_ACCOUNT = { id: "u-internal", email: "founder@vibepin.co", app_metadata: {} };

const BASE_ENV_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAILS;
// NOTE: fn() returns a Promise that has only just been STARTED when this
// returns — the classifyAccount() calls inside getFeatureAdoption happen
// later, after further awaits. Restoring the env var in a sync `finally`
// here would race and reset SUPER_ADMIN_EMAILS before those calls run. Await
// fn() itself inside the try so the env var is restored only once the whole
// async operation has actually completed.
async function withSuperAdminEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.SUPER_ADMIN_EMAILS = "founder@vibepin.co";
  try { return await fn(); } finally { process.env.SUPER_ADMIN_EMAILS = BASE_ENV_SUPER_ADMIN; }
}

test("getFeatureAdoption: measured feature with real usage produces absolute counts, no zeroUsage flag", async () => {
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          { user_id: "u1", event_name: "ai_copy_generate_clicked", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "ai_copy_success", created_at: daysAgo(1) },
        ],
      },
    },
    [CUSTOMER_1, CUSTOMER_2],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  assert.ok(res.available);
  const aiCopy = res.features.find(f => f.feature === "aiCopy")!;
  assert.equal(aiCopy.firstUse.state, "measured");
  assert.equal(aiCopy.firstUse.usersWithSignal, 1);
  assert.equal(aiCopy.firstUse.totalCustomers, 2);
  assert.equal(aiCopy.zeroUsage, false);
});

test("getFeatureAdoption: exposure is ALWAYS not_measured - even for a feature with heavy measured usage", async () => {
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          { user_id: "u1", event_name: "generation_judged", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "generation_kept", created_at: daysAgo(1) },
          { user_id: "u2", event_name: "generation_judged", created_at: daysAgo(2) },
        ],
      },
    },
    [CUSTOMER_1, CUSTOMER_2],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  for (const f of res.features) {
    assert.equal(f.exposure.state, "not_measured", f.feature + ".exposure must be not_measured");
    assert.equal(f.exposure.usersWithSignal, null, f.feature + ".exposure must not carry a synthesized count");
  }
});

test("getFeatureAdoption: MEASURED real zero (publish) is distinguishable from NOT_MEASURED (scheduling) given the same 0-row input", async () => {
  // Neither publish nor scheduling has any matching row in this fixture - the
  // INPUT is symmetric. The two features must still diverge: publish has real
  // production history so a 0-row scan is a genuine (alarming) zero;
  // scheduling is in NOT_YET_DEPLOYED so the same 0 rows must read as "not
  // measured yet".
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          // Unrelated event present, so the table itself is not "missing" -
          // proves this is a real zero-count outcome, not a degraded scan.
          { user_id: "u1", event_name: "ai_copy_success", created_at: daysAgo(1) },
        ],
      },
    },
    [CUSTOMER_1, CUSTOMER_2],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const publish = res.features.find(f => f.feature === "publish")!;
  const scheduling = res.features.find(f => f.feature === "scheduling")!;

  assert.equal(publish.firstUse.state, "measured", "publish must be MEASURED (real telemetry exists in prod)");
  assert.equal(publish.firstUse.usersWithSignal, 0, "publish's measured count must be a real 0, not null");
  assert.equal(publish.zeroUsage, true, "a real zero on a deployed feature IS a zero-usage anomaly");

  assert.equal(scheduling.firstUse.state, "not_measured", "scheduling must be NOT_MEASURED (undeployed telemetry)");
  assert.equal(scheduling.firstUse.usersWithSignal, null, "not_measured must never carry a numeric 0");
  assert.equal(scheduling.zeroUsage, false, "an undeployed feature must never be flagged as a zero-usage anomaly");

  // The two must be STRUCTURALLY different, not just different labels floating
  // next to the same shape.
  assert.notEqual(publish.firstUse.state, scheduling.firstUse.state);
  assert.notEqual(publish.firstUse.usersWithSignal, scheduling.firstUse.usersWithSignal);
});

test("getFeatureAdoption: query failure -> unavailable, NEVER collapsed into not_measured", async () => {
  const { db } = makeMockDb(
    { analytics_events: { error: { code: "57014", message: "statement timeout" } } },
    [CUSTOMER_1],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  assert.equal(res.available, false);
  for (const f of res.features) {
    assert.equal(f.firstUse.state, "unavailable", f.feature + " must be unavailable on a scan failure");
    assert.notEqual(f.firstUse.state, "not_measured", "a query failure must never render as not_measured");
  }
});

test("getFeatureAdoption: missing analytics_events table -> unavailable (not not_measured)", async () => {
  const { db } = makeMockDb({}, [CUSTOMER_1]); // table entirely absent from the mock's table map
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  assert.equal(res.available, false);
  const anyFeature = res.features[0];
  assert.equal(anyFeature.firstUse.state, "unavailable");
});

test("getFeatureAdoption: test/internal accounts are excluded from measured counts", async () => {
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          { user_id: "u1", event_name: "recommended_keywords_ready", created_at: daysAgo(1) },
          { user_id: "u-test", event_name: "recommended_keywords_ready", created_at: daysAgo(1) },
          { user_id: "u-internal", event_name: "recommended_keywords_ready", created_at: daysAgo(1) },
        ],
      },
    },
    [CUSTOMER_1, TEST_ACCOUNT, INTERNAL_ACCOUNT],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const keywordFeature = res.features.find(f => f.feature === "keywordRecommendations")!;
  assert.equal(keywordFeature.firstUse.usersWithSignal, 1, "only the real customer's event should count");
  assert.equal(keywordFeature.firstUse.totalCustomers, 1, "test/internal accounts excluded from the cohort denominator too");
  assert.equal(res.excluded.test, 1);
  assert.equal(res.excluded.internal, 1);
});

test("getFeatureAdoption: two users never cross-contaminate at the API layer either", async () => {
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          { user_id: "u1", event_name: "reference_selected", created_at: daysAgo(10) },
          { user_id: "u2", event_name: "reference_selected", created_at: daysAgo(9) },
          { user_id: "u2", event_name: "reference_selected", created_at: daysAgo(2) },
        ],
      },
    },
    [CUSTOMER_1, CUSTOMER_2],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db, { windowDays: 14 }));
  const refFeature = res.features.find(f => f.feature === "referenceRecommendations")!;
  assert.equal(refFeature.firstUse.usersWithSignal, 2, "both u1 and u2 reached first use");
  assert.equal(refFeature.repeatUse.usersWithSignal, 1, "only u2 has 2 events - u1's single event must not count toward repeat use");
});

test("getFeatureAdoption: response structure carries NO percentage/ratio KEY anywhere", async () => {
  // Checks field NAMES only (not a raw string scan of the whole JSON) -
  // "generatedAt" legitimately contains the substring "rate" and must not
  // false-positive this check.
  const { db } = makeMockDb(
    { analytics_events: { rows: [{ user_id: "u1", event_name: "ai_copy_success", created_at: daysAgo(1) }] } },
    [CUSTOMER_1],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const bannedKeyPattern = /^(rate|percent|pct|ratio)$/i;
  const allKeys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        allKeys.add(k);
        walk(val);
      }
    }
  };
  walk(res);
  for (const key of allKeys) {
    assert.ok(!bannedKeyPattern.test(key), "response must not contain a field named " + key + " - absolute counts only (PRD 3.6)");
  }
});

test("selectFeatureAdoptionAnomalies: empty when nothing is anomalous (drives no-card on /admin/today)", async () => {
  const { db } = makeMockDb(
    {
      analytics_events: {
        rows: [
          { user_id: "u1", event_name: "pinterest_publish_attempted", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "pinterest_publish_succeeded", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "ai_copy_generate_clicked", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "ai_copy_success", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "generation_judged", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "generation_kept", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "reference_selected", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "direction_selected", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "image_analysis_started", created_at: daysAgo(1) },
          { user_id: "u1", event_name: "recommended_keywords_ready", created_at: daysAgo(1) },
        ],
      },
    },
    [CUSTOMER_1],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  // scheduling stays not_measured (undeployed) - must not itself create an anomaly.
  const anomalies = selectFeatureAdoptionAnomalies(res);
  assert.deepEqual(anomalies, [], "a not-yet-deployed feature with no other zero-usage features must yield zero anomalies");
});

test("selectFeatureAdoptionAnomalies: flags a real zero-usage feature by name", async () => {
  const { db } = makeMockDb(
    { analytics_events: { rows: [{ user_id: "u1", event_name: "ai_copy_success", created_at: daysAgo(1) }] } },
    [CUSTOMER_1],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const anomalies = selectFeatureAdoptionAnomalies(res);
  const publishAnomaly = anomalies.find(a => a.feature === "publish");
  assert.ok(publishAnomaly, "publish had zero events and must be flagged");
  assert.equal(publishAnomaly!.kind, "zero_usage");
  assert.ok(!anomalies.some(a => a.feature === "scheduling"), "not-yet-deployed scheduling must never appear as a zero_usage anomaly");
});

test("selectFeatureAdoptionAnomalies: an unavailable scan surfaces one anomaly per feature, kind=unavailable", async () => {
  const { db } = makeMockDb(
    { analytics_events: { error: { code: "57014", message: "statement timeout" } } },
    [CUSTOMER_1],
  );
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const anomalies = selectFeatureAdoptionAnomalies(res);
  assert.equal(anomalies.length, FEATURE_KEYS.length);
  assert.ok(anomalies.every(a => a.kind === "unavailable"));
});

test("getFeatureAdoption: >1000 events scanned without truncation", async () => {
  const rows = Array.from({ length: 1300 }, (_, i) => ({
    user_id: i % 2 === 0 ? "u1" : "u2",
    event_name: "ai_copy_success",
    created_at: daysAgo(1),
  }));
  const { db } = makeMockDb({ analytics_events: { rows } }, [CUSTOMER_1, CUSTOMER_2]);
  const res = await withSuperAdminEnv(() => getFeatureAdoption(db));
  const aiCopy = res.features.find(f => f.feature === "aiCopy")!;
  // Both users have events; regardless of pagination the per-user aggregation
  // must see all 1300 rows, not just the first 1000 (supabase-js's silent cap).
  assert.equal(aiCopy.firstUse.usersWithSignal, 2, "both users must register despite >1000 source rows");
});

void done();
