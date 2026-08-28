/**
 * Unit tests for the Insights collection layer (v64).
 *
 * Everything here runs against pure functions and a stubbed fetch — no database, no
 * network, no multi-day simulation. That is possible because the collector is split
 * on purpose: `collectorLogic.ts` holds the policy (budget, measurement windows,
 * status mapping, cursor state machine) and `collector.ts` holds only the I/O and
 * the sequencing. Testing the policy directly is what makes these assertions cheap
 * enough to keep, and the properties they pin down — a 60-call day, a t7 that is
 * never recorded on day 20, a missing metric that is never written as 0 — are the
 * ones whose violation would be invisible in production until the data was already
 * wrong.
 *
 * `collector.ts`, `collectorStore.ts` and `vibepinPublishedPins.ts` import
 * "server-only" and cannot be loaded here at all; the invariants that live in them
 * are asserted as source contracts instead, the same technique test-insights-mvp.ts
 * uses for dashboard.ts.
 *
 * Run: npm run test:insights-collector
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLLECTED_METRICS,
  DAILY_BUDGET_FIXED,
  DAILY_BUDGET_RESERVE,
  DAILY_BUDGET_TASKS,
  DAILY_BUDGET_TOTAL,
  MAX_CALLS_PER_RUN,
  REGISTRY_FULL_INTERVAL_DAYS,
  REGISTRY_FULL_PAGES_PER_DAY,
  TASK_WINDOWS,
  advanceRegistryCursor,
  attributePinToConnection,
  clearReconciliation,
  computeCallsBudget,
  dedupeObservationDrafts,
  expiredTasks,
  mapMetricStatus,
  observationsFromSlice,
  ownerConnectionFromRegistry,
  planRegistryRun,
  resolveRegistrySource,
  selectExecutableTasks,
  tasksForPublishedPin,
  type PendingTask,
  type RegistryCursorState,
} from "../src/lib/server/insights/collectorLogic";
import {
  legacyPublishedPinterestPinFromDraft,
  parseDestinationResults,
  publishedPinterestPinsFromDraft,
} from "../src/lib/server/insights/publishProvenance";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const src = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/** Fixed clock. Every window assertion is relative to it, so these tests do not
 *  start failing on a particular day of the month. */
const NOW = new Date("2026-08-27T12:00:00.000Z");
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString();

function pending(overrides: Partial<PendingTask> & { id: number }): PendingTask {
  return {
    connectionId: "conn-a",
    platformContentId: "111",
    kind: "t7",
    dueAt: day(-1),
    windowUntil: day(2),
    priority: 1,
    attempts: 0,
    ...overrides,
  };
}

async function main() {
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";
const { PinterestApiError, PinterestClient } = await import("../src/lib/server/pinterest/service");

// ── Budget ─────────────────────────────────────────────────────────────────

await test("the daily budget is 7 fixed + 12 reserve + 41 tasks = 60", () => {
  assert.equal(DAILY_BUDGET_FIXED + DAILY_BUDGET_RESERVE + DAILY_BUDGET_TASKS, 60);
  assert.equal(DAILY_BUDGET_TOTAL, 60);
  // The fixed half has to cover what actually runs unconditionally every day:
  // 2 account calls (analytics + top pins) + 1 incremental page + 4 full-scan pages.
  assert.ok(2 + 1 + REGISTRY_FULL_PAGES_PER_DAY <= DAILY_BUDGET_FIXED);
});

await test("a run gets the smaller of the per-run cap and what the day has left", () => {
  // Per-run cap bounds one invocation's wall time; the daily budget bounds the
  // connection's spend across every invocation. They are different guarantees.
  assert.equal(computeCallsBudget(30, 0), 30);
  assert.equal(computeCallsBudget(100, 0), MAX_CALLS_PER_RUN);
  assert.equal(computeCallsBudget(30, 45), 15);
  assert.equal(computeCallsBudget(30, 60), 0);
  // A day already over budget yields 0, never a negative number that a caller
  // might read as "unlimited".
  assert.equal(computeCallsBudget(30, 75), 0);
  assert.equal(computeCallsBudget(7.9, 0), 7);
});

// ── Measurement points ─────────────────────────────────────────────────────

await test("t1/t7/t30 windows and priority order are [due, expiry) with t7 first", () => {
  assert.deepEqual(TASK_WINDOWS.t1, { dueDays: 1, untilDays: 3, priority: 3 });
  assert.deepEqual(TASK_WINDOWS.t7, { dueDays: 7, untilDays: 10, priority: 1 });
  assert.deepEqual(TASK_WINDOWS.t30, { dueDays: 30, untilDays: 37, priority: 2 });
});

await test("a freshly published Pin gets all three measurement points", () => {
  const drafts = tasksForPublishedPin("conn-a", "111", day(0), NOW);
  assert.equal(drafts.length, 3);
  const t7 = drafts.find(draft => draft.kind === "t7")!;
  assert.equal(t7.dueAt, day(7));
  assert.equal(t7.windowUntil, day(10));
  assert.equal(t7.priority, 1);
});

await test("windows that already closed at creation time are never created", () => {
  // Published 12 days ago: t1 (closes day 3) and t7 (closes day 10) are gone, t30
  // is still ahead. Creating a task only to cancel it on the next pass would record
  // a failure that never had a chance of succeeding.
  const drafts = tasksForPublishedPin("conn-a", "111", day(-12), NOW);
  assert.deepEqual(drafts.map(draft => draft.kind), ["t30"]);
});

await test("Pins older than the eligibility horizon get no tasks at all", () => {
  assert.deepEqual(tasksForPublishedPin("conn-a", "111", day(-40), NOW), []);
  // An unparseable date is not an old Pin; it is no evidence, and no evidence
  // must not become a measurement point.
  assert.deepEqual(tasksForPublishedPin("conn-a", "111", "not-a-date", NOW), []);
});

await test("expired pending tasks are identified before any call is spent", () => {
  const tasks = [
    pending({ id: 1, windowUntil: day(-1) }),
    pending({ id: 2, windowUntil: day(1) }),
    pending({ id: 3, kind: "t1", windowUntil: day(-5) }),
  ];
  assert.deepEqual(expiredTasks(tasks, NOW).map(task => task.id), [1, 3]);
});

await test("execution order is priority then oldest due, skipping not-yet-due and expired", () => {
  const tasks = [
    pending({ id: 1, kind: "t1", priority: 3, dueAt: day(-3), windowUntil: day(1) }),
    pending({ id: 2, kind: "t30", priority: 2, dueAt: day(-2), windowUntil: day(3) }),
    pending({ id: 3, kind: "t7", priority: 1, dueAt: day(-1), windowUntil: day(2) }),
    pending({ id: 4, kind: "t7", priority: 1, dueAt: day(-4), windowUntil: day(1) }),
    pending({ id: 5, kind: "t7", priority: 1, dueAt: day(2), windowUntil: day(5) }),   // not due
    pending({ id: 6, kind: "t7", priority: 1, dueAt: day(-9), windowUntil: day(-1) }), // expired
  ];
  assert.deepEqual(selectExecutableTasks(tasks, 10, NOW).map(task => task.id), [4, 3, 2, 1]);
  // Under budget pressure the mid-life points survive, because those are the ones
  // the diagnosis actually compares against.
  assert.deepEqual(selectExecutableTasks(tasks, 2, NOW).map(task => task.id), [4, 3]);
  assert.deepEqual(selectExecutableTasks(tasks, 0, NOW), []);
});

// ── Observation status mapping ─────────────────────────────────────────────

await test("a missing metric is not_returned, never 0", () => {
  assert.deepEqual(mapMetricStatus({ IMPRESSION: 10 }, "SAVE"), { status: "not_returned", value: null });
  assert.deepEqual(mapMetricStatus(undefined, "SAVE"), { status: "not_returned", value: null });
});

await test("a genuine zero is an ok observation", () => {
  assert.deepEqual(mapMetricStatus({ OUTBOUND_CLICK: 0 }, "OUTBOUND_CLICK"), { status: "ok", value: 0 });
});

await test("a scope failure is no_permission and never carries a value", () => {
  const denied = mapMetricStatus({ IMPRESSION: 10 }, "IMPRESSION", { permissionDenied: true });
  assert.deepEqual(denied, { status: "no_permission", value: null });
  // not_collected outranks everything: we never asked, so nothing else is known.
  assert.deepEqual(
    mapMetricStatus({ IMPRESSION: 10 }, "IMPRESSION", { collected: false, permissionDenied: true }),
    { status: "not_collected", value: null },
  );
});

await test("status='ok' and a non-null value are the same fact, in both directions", () => {
  // The database enforces this with a CHECK; the mapper must never produce a row
  // the CHECK would reject, because that would fail the whole batch insert.
  const slice = {
    daily_metrics: [{ date: "2026-08-26", metrics: { IMPRESSION: 5, SAVE: 0 } }],
    summary_metrics: { IMPRESSION: 5 },
  };
  const drafts = observationsFromSlice(slice, {
    scope: "account", platformContentId: null, metrics: ["IMPRESSION", "SAVE", "OUTBOUND_CLICK"],
  });
  for (const draft of drafts) {
    assert.equal(draft.status === "ok", draft.metricValue !== null, JSON.stringify(draft));
    assert.equal(draft.period === "day", draft.periodDate !== null);
    assert.equal(draft.scope === "content", draft.platformContentId !== null);
  }
  // 3 daily + 3 lifetime, and the absent metrics are present AS absences.
  assert.equal(drafts.length, 6);
  assert.equal(drafts.filter(draft => draft.status === "not_returned").length, 3);
});

await test("a denied slice produces one no_permission row per metric, no daily rows", () => {
  const drafts = observationsFromSlice(null, {
    scope: "content", platformContentId: "111", metrics: ["IMPRESSION", "SAVE"], permissionDenied: true,
  });
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every(draft => draft.status === "no_permission" && draft.metricValue === null));
  assert.ok(drafts.every(draft => draft.period === "lifetime" && draft.periodDate === null));
});

await test("drafts colliding on the run-scoped unique key collapse to the first", () => {
  // The unique index is on COALESCE expressions, so PostgREST cannot use it as an
  // upsert target; the insert is plain and a duplicate inside one batch would take
  // the whole batch down with a 23505.
  const base = { scope: "content" as const, platformContentId: "111", metricName: "IMPRESSION",
    period: "lifetime" as const, periodDate: null };
  const deduped = dedupeObservationDrafts([
    { ...base, metricValue: 10, status: "ok" },
    { ...base, metricValue: 99, status: "ok" },
    { ...base, metricName: "SAVE", metricValue: 1, status: "ok" },
    { ...base, period: "day", periodDate: "2026-08-26", metricValue: 3, status: "ok" },
  ]);
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].metricValue, 10);
});

// ── Registry cursor state machine ──────────────────────────────────────────

await test("a connection with no cursor starts a full scan and still reads page 1", () => {
  const plan = planRegistryRun(null, NOW);
  assert.equal(plan.startFull, true);
  assert.equal(plan.fullPages, REGISTRY_FULL_PAGES_PER_DAY);
  assert.equal(plan.incremental, true);
});

await test("a full scan in progress resumes from its bookmark, bounded per day", () => {
  const cursor: RegistryCursorState = {
    bookmark: "page-3", fullStartedAt: day(-2), fullCompletedAt: null,
    pagesFetched: 8, reconciliationPending: false,
  };
  const plan = planRegistryRun(cursor, NOW);
  assert.equal(plan.resumeBookmark, "page-3");
  assert.equal(plan.fullPages, REGISTRY_FULL_PAGES_PER_DAY);
  // The incremental first page runs even mid-scan: skipping it would blind the
  // account to its newest content for as long as the scan lasts.
  assert.equal(plan.incremental, true);
});

await test("full → reconciliation → incremental is the full progression", () => {
  // 1. Scan runs and Pinterest returns no further bookmark.
  const midScan: RegistryCursorState = {
    bookmark: "page-3", fullStartedAt: day(-2), fullCompletedAt: null,
    pagesFetched: 8, reconciliationPending: false,
  };
  const finished = advanceRegistryCursor(midScan, null, 3, NOW);
  assert.equal(finished.bookmark, null);
  assert.equal(finished.pagesFetched, 11);
  assert.equal(finished.fullStartedAt, midScan.fullStartedAt); // resumed, not restarted
  assert.equal(finished.fullCompletedAt, NOW.toISOString());
  // A scan spanning days cannot have seen Pins created after it passed page 1, so
  // it does not get to declare itself complete on its own.
  assert.equal(finished.reconciliationPending, true);

  // 2. The next day spends its first page on reconciliation and no full pages.
  const reconcilePlan = planRegistryRun(finished, new Date(NOW.getTime() + 86_400_000));
  assert.equal(reconcilePlan.reconciling, true);
  assert.equal(reconcilePlan.fullPages, 0);
  assert.equal(reconcilePlan.incremental, true);

  // 3. With the flag cleared, ordinary days are incremental only.
  const settled = clearReconciliation(finished);
  assert.equal(settled.reconciliationPending, false);
  const quietPlan = planRegistryRun(settled, new Date(NOW.getTime() + 5 * 86_400_000));
  assert.equal(quietPlan.fullPages, 0);
  assert.equal(quietPlan.startFull, false);
  assert.equal(quietPlan.incremental, true);

  // 4. Thirty days later a new full scan starts, and its page count restarts.
  const due = planRegistryRun(settled, new Date(NOW.getTime() + REGISTRY_FULL_INTERVAL_DAYS * 86_400_000));
  assert.equal(due.startFull, true);
  assert.equal(due.fullPages, REGISTRY_FULL_PAGES_PER_DAY);
  const restarted = advanceRegistryCursor(settled, "page-1", 4, NOW);
  assert.equal(restarted.pagesFetched, 4);
  assert.equal(restarted.fullStartedAt, NOW.toISOString());
});

await test("vibepin_publish provenance is never downgraded by a later discovery pass", () => {
  assert.equal(resolveRegistrySource("vibepin_publish", "pins_list"), "vibepin_publish");
  assert.equal(resolveRegistrySource("vibepin_publish", "top_pins"), "vibepin_publish");
  assert.equal(resolveRegistrySource("pins_list", "top_pins"), "top_pins");
  assert.equal(resolveRegistrySource(null, "pins_list"), "pins_list");
});

// ── Ownership attribution ──────────────────────────────────────────────────

await test("ownerConnectionForPin answers from the registry, with publish outranking discovery", () => {
  const rows = [
    { connectionId: "conn-b", platformContentId: "111", sourceEndpoint: "pins_list" as const },
    { connectionId: "conn-a", platformContentId: "111", sourceEndpoint: "vibepin_publish" as const },
    { connectionId: "conn-b", platformContentId: "222", sourceEndpoint: "pins_list" as const },
  ];
  assert.equal(ownerConnectionFromRegistry(rows, "111"), "conn-a");
  assert.equal(ownerConnectionFromRegistry(rows, "222"), "conn-b");
  // No row yet — collection has not run, or v64 is not applied here. The honest
  // answer is "unknown", not a guess.
  assert.equal(ownerConnectionFromRegistry(rows, "333"), null);
});

await test("attribution precedence: draft target, then registry, then visible everywhere", () => {
  assert.equal(attributePinToConnection("conn-a", "conn-b", "conn-a"), true);
  assert.equal(attributePinToConnection("conn-a", "conn-b", "conn-b"), false);
  assert.equal(attributePinToConnection(null, "conn-a", "conn-a"), true);
  assert.equal(attributePinToConnection(null, "conn-a", "conn-b"), false);
  // Neither source knows: a legacy Pin stays visible on every card rather than
  // disappearing from the account that really owns it.
  assert.equal(attributePinToConnection(null, null, "conn-a"), true);
  assert.equal(attributePinToConnection(null, null, "conn-b"), true);
});

// ── Publish provenance: fan-out vs legacy ──────────────────────────────────

await test("destinationResults yields one record per published Pinterest destination", () => {
  const pins = publishedPinterestPinsFromDraft("draft-1", {
    title: "Linen throw",
    imageUrl: "https://cdn.example/a.jpg",
    postedAt: "2026-08-20T10:00:00.000Z",
    remotePinId: "111",
    targetConnectionId: "conn-a",
    destinationResults: [
      { destinationId: "d1", provider: "pinterest", socialConnectionId: "conn-a", status: "published",
        remoteId: "111", postUrl: "https://www.pinterest.com/pin/111/", publishedAt: "2026-08-20T10:00:00.000Z" },
      { destinationId: "d2", provider: "pinterest", socialConnectionId: "conn-b", status: "published",
        remoteId: "222", publishedAt: "2026-08-20T10:05:00.000Z" },
    ],
  });
  assert.deepEqual(pins.map(pin => [pin.pinId, pin.targetConnectionId]), [["111", "conn-a"], ["222", "conn-b"]]);
  // Each destination keeps its own timestamp; the payload root records only one.
  assert.equal(pins[1].publishedAt, "2026-08-20T10:05:00.000Z");
  assert.equal(pins[1].postUrl, "https://www.pinterest.com/pin/222/");
  assert.equal(pins[0].title, "Linen throw");
});

await test("only published Pinterest destinations with a usable Pin id become provenance", () => {
  const pins = publishedPinterestPinsFromDraft("draft-2", {
    remotePinId: "999",
    targetConnectionId: "conn-a",
    destinationResults: [
      { provider: "instagram", socialConnectionId: "conn-ig", status: "published", remoteId: "17900" },
      { provider: "pinterest", socialConnectionId: "conn-a", status: "failed", remoteId: null },
      { provider: "pinterest", socialConnectionId: "conn-b", status: "published", remoteId: null },
      { provider: "pinterest", socialConnectionId: null, status: "published", remoteId: "333" },
      { provider: "pinterest", socialConnectionId: "conn-c", status: "published", remoteId: "not-a-pin-id" },
      { provider: "PINTEREST", socialConnectionId: "conn-d", status: "published", remoteId: "444" },
    ],
  });
  assert.deepEqual(pins.map(pin => pin.pinId), ["444"]);
  // The root remotePinId is NOT re-admitted: results exist, so they are the record,
  // and merging would attach Pin 999 to whichever connection the root field names.
  assert.ok(!pins.some(pin => pin.pinId === "999"));
});

await test("a draft whose every destination failed publishes nothing, root field notwithstanding", () => {
  const pins = publishedPinterestPinsFromDraft("draft-3", {
    remotePinId: "111",
    targetConnectionId: "conn-a",
    destinationResults: [
      { provider: "pinterest", socialConnectionId: "conn-a", status: "failed", error: "board_missing" },
    ],
  });
  assert.deepEqual(pins, []);
});

await test("the legacy pair is read only when destinationResults is absent or unusable", () => {
  const legacy = publishedPinterestPinsFromDraft("draft-4", {
    remotePinId: "111",
    remotePinUrl: "https://www.pinterest.com/pin/111/",
    targetConnectionId: "conn-a",
    postedAt: "2026-08-20T10:00:00.000Z",
    imageUrl: "https://cdn.example/a.jpg",
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].pinId, "111");
  assert.equal(legacy[0].targetConnectionId, "conn-a");
  assert.equal(legacy[0].mediaType, "IMAGE");

  // Empty array, wrong type, and entries with no provider are all "no records".
  for (const destinationResults of [[], "nope", {}, [null, { status: "published" }]]) {
    const pins = publishedPinterestPinsFromDraft("draft-5", { remotePinId: "111", destinationResults });
    assert.deepEqual(pins.map(pin => pin.pinId), ["111"], JSON.stringify(destinationResults));
  }

  // A draft that was never published is not provenance at all.
  assert.deepEqual(publishedPinterestPinsFromDraft("draft-6", { title: "unpublished" }), []);
  assert.equal(legacyPublishedPinterestPinFromDraft("draft-6", { remotePinId: "abc" }), null);
  assert.deepEqual(parseDestinationResults(undefined), []);
});

// ── Pinterest client, stubbed transport ────────────────────────────────────

await test("the collector shapes real response bodies into observations without a network", async () => {
  const requested: string[] = [];
  const client = PinterestClient.forTest({
    accessToken: "token",
    connectionId: "conn-a",
    hooks: {
      fetchImpl: async input => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/user_account/analytics?")) {
          return new Response(JSON.stringify({
            ALL: {
              daily_metrics: [
                { date: "2026-08-25", metrics: { IMPRESSION: 120, SAVE: 4, OUTBOUND_CLICK: 0 } },
                { date: "2026-08-26", metrics: { IMPRESSION: 90 } },
              ],
              summary_metrics: { IMPRESSION: 210, SAVE: 4 },
            },
          }), { status: 200 });
        }
        if (url.includes("/analytics/top_pins")) {
          return new Response(JSON.stringify({
            pins: [{ pin_id: "111", metrics: { IMPRESSION: 60, SAVE: 2 } }],
          }), { status: 200 });
        }
        if (url.includes("/pins/111/analytics")) {
          return new Response(JSON.stringify({
            ALL: { daily_metrics: [], summary_metrics: { IMPRESSION: 60, OUTBOUND_CLICK: 3 } },
          }), { status: 200 });
        }
        if (url.includes("/pins/222/analytics")) {
          // Phrased so the client's missing-scope heuristic does NOT fire: a plain
          // 403 must stay a plain 403 (see the scope-worded case in the next test).
          return new Response(JSON.stringify({ message: "Analytics are only available for business accounts" }), { status: 403 });
        }
        const bookmarked = url.includes("bookmark=page-2");
        return new Response(JSON.stringify({
          items: [{
            id: bookmarked ? "222" : "111",
            title: bookmarked ? "Second page Pin" : "First page Pin",
            created_at: "2026-08-20T10:00:00Z",
            media: { media_type: "image", images: { "600x": { url: "https://i.pinimg.com/a.jpg" } } },
          }],
          bookmark: bookmarked ? null : "page-2",
        }), { status: 200 });
      },
    },
  });

  const metrics = [...COLLECTED_METRICS];
  const account = await client.getOrganicAccountAnalytics("2026-05-30", "2026-08-27", metrics);
  const accountDrafts = observationsFromSlice(account.ALL ?? null, {
    scope: "account", platformContentId: null, metrics: COLLECTED_METRICS,
  });
  // 2 daily rows × 7 metrics + 7 lifetime rows.
  assert.equal(accountDrafts.length, 2 * COLLECTED_METRICS.length + COLLECTED_METRICS.length);
  const impressionOn25 = accountDrafts.find(d => d.period === "day" && d.periodDate === "2026-08-25" && d.metricName === "IMPRESSION")!;
  assert.deepEqual([impressionOn25.status, impressionOn25.metricValue], ["ok", 120]);
  const clicksOn25 = accountDrafts.find(d => d.periodDate === "2026-08-25" && d.metricName === "OUTBOUND_CLICK")!;
  assert.deepEqual([clicksOn25.status, clicksOn25.metricValue], ["ok", 0]);
  const savesOn26 = accountDrafts.find(d => d.periodDate === "2026-08-26" && d.metricName === "SAVE")!;
  assert.deepEqual([savesOn26.status, savesOn26.metricValue], ["not_returned", null]);

  const topPins = await client.getOrganicTopPins("2026-05-30", "2026-08-27", metrics);
  const topDrafts = observationsFromSlice({ summary_metrics: topPins.pins?.[0]?.metrics ?? {} }, {
    scope: "content", platformContentId: "111", metrics: COLLECTED_METRICS,
  });
  assert.ok(topDrafts.every(draft => draft.scope === "content" && draft.platformContentId === "111"));
  assert.ok(topDrafts.every(draft => draft.period === "lifetime"));

  // Registry paging: page 1, then the bookmark, then exhaustion (bookmark null).
  const page1 = await client.listPinMetadata();
  assert.equal(page1.bookmark, "page-2");
  const page2 = await client.listPinMetadata(page1.bookmark!);
  assert.equal(page2.bookmark, null);
  assert.deepEqual(
    advanceRegistryCursor(null, page1.bookmark, 1, NOW).bookmark,
    "page-2",
  );
  assert.equal(advanceRegistryCursor(
    { bookmark: "page-2", fullStartedAt: day(-1), fullCompletedAt: null, pagesFetched: 1, reconciliationPending: false },
    page2.bookmark, 1, NOW,
  ).reconciliationPending, true);

  const pinAnalytics = await client.getOrganicPinAnalytics("111", "2026-05-30", "2026-08-27", metrics);
  const pinDrafts = observationsFromSlice(pinAnalytics.ALL ?? null, {
    scope: "content", platformContentId: "111", metrics: COLLECTED_METRICS,
  });
  const clicks = pinDrafts.find(draft => draft.metricName === "OUTBOUND_CLICK")!;
  assert.deepEqual([clicks.status, clicks.metricValue], ["ok", 3]);

  // A 403 is a permission fact, not a missing metric.
  await assert.rejects(
    () => client.getOrganicPinAnalytics("222", "2026-05-30", "2026-08-27", metrics),
    (error: unknown) => error instanceof PinterestApiError && error.status === 403,
  );
  const deniedDrafts = observationsFromSlice(null, {
    scope: "content", platformContentId: "222", metrics: COLLECTED_METRICS, permissionDenied: true,
  });
  assert.ok(deniedDrafts.every(draft => draft.status === "no_permission" && draft.metricValue === null));

  assert.ok(requested.some(url => url.includes("split_field=NO_SPLIT")));
  assert.ok(requested.some(url => url.includes("bookmark=page-2")));
  // account analytics, top pins, and one per-Pin call each for 111 and 222.
  assert.equal(requested.filter(url => url.includes("/analytics")).length, 4);
  assert.equal(requested.filter(url => url.startsWith("https://api.pinterest.com/v5/pins?")).length, 2);
});

await test("a scope-worded 403 still reads as permission denied, not as a missing metric", async () => {
  // The client re-labels a 403 that names a scope as MissingPinterestScopesError,
  // which carries status 401 — NOT 403. The collector's permission check has to
  // cover both, or a scope failure would be recorded as a generic run error and the
  // metrics would show up as "not returned" instead of "we are not allowed to read
  // this". markReconnect is stubbed so the re-label cannot reach a database.
  const marked: string[] = [];
  const client = PinterestClient.forTest({
    accessToken: "token",
    connectionId: "conn-a",
    hooks: {
      markReconnect: async id => { marked.push(id); },
      fetchImpl: async () => new Response(
        JSON.stringify({ message: "Your token does not have sufficient permissions (scope)" }),
        { status: 403 },
      ),
    },
  });
  await assert.rejects(
    () => client.getOrganicPinAnalytics("111", "2026-05-30", "2026-08-27", [...COLLECTED_METRICS]),
    (error: unknown) => error instanceof PinterestApiError
      && (error.status === 403 || error.status === 401),
  );
  assert.deepEqual(marked, ["conn-a"]);
  // collector.ts must therefore test for both statuses.
  assert.match(
    src("src/lib/server/insights/collector.ts"),
    /error\.status === 403 \|\| error\.status === 401/,
  );
});

await test("a 429 surfaces as a rate-limit error the collector can recognise", async () => {
  const client = PinterestClient.forTest({
    accessToken: "token",
    connectionId: "conn-a",
    hooks: {
      fetchImpl: async () => new Response(JSON.stringify({ message: "rate limit" }), { status: 429 }),
    },
  });
  await assert.rejects(
    () => client.getOrganicPinAnalytics("111", "2026-05-30", "2026-08-27", [...COLLECTED_METRICS]),
    (error: unknown) => error instanceof PinterestApiError && error.status === 429,
  );
});

// ── Source contracts for the modules that cannot be imported here ──────────

await test("the collector reads through the named connection, never the active one", () => {
  const collector = src("src/lib/server/insights/collector.ts");
  // forUser() resolves whichever connection is currently "active"; for a two-account
  // user that silently collects one account's data under the other's id.
  assert.match(collector, /PinterestClient\.forConnection\(userId, connectionId\)/);
  assert.doesNotMatch(collector, /forUser\(/);
  // Once rate-limited, the remaining steps are skipped rather than attempted.
  assert.match(collector, /if \(!wasRateLimited\(\)\) runs\.push\(await runRegistry/);
  assert.match(collector, /if \(!wasRateLimited\(\)\) runs\.push\(await runPinTasks/);
  // Expired tasks are cancelled before any call is spent.
  assert.match(collector, /cancelTasks\(expired\.map\(task => task\.id\), "window_expired"\)/);
});

await test("observations are inserted plainly, because the unique index is on expressions", () => {
  const store = src("src/lib/server/insights/collectorStore.ts");
  const migration = readFileSync(
    join(process.cwd(), "..", "backend/db/migrate_v64_insights_collection.sql"), "utf8",
  );
  // PostgREST's on_conflict can only name plain columns, and Postgres cannot infer
  // an arbiter index from them when the index is on COALESCE(...). An upsert here
  // would fail 42P10 on every call — the collector would report healthy runs while
  // writing nothing at all.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS metric_observation_run_key[\s\S]*COALESCE\(platform_content_id, ''\)/);
  assert.match(store, /\.from\("metric_observation"\)\.insert\(rows\)/);
  assert.doesNotMatch(store, /from\("metric_observation"\)[\s\S]{0,200}\.upsert\(/);
  assert.match(store, /error\.code === "23505"/);
  assert.match(store, /dedupeObservationDrafts\(drafts\)/);
});

await test("the v64 schema keeps the constraints that make status and sentinels honest", () => {
  const migration = readFileSync(
    join(process.cwd(), "..", "backend/db/migrate_v64_insights_collection.sql"), "utf8",
  );
  // A non-ok row can never smuggle in a number, and an ok row can never be empty.
  assert.match(migration, /CHECK \(\(status = 'ok'\) = \(metric_value IS NOT NULL\)\)/);
  // The coalesce sentinels are collision-proof only because these two make the
  // sentinel values impossible as real data.
  assert.match(migration, /platform_content_id IS NULL OR platform_content_id <> ''/);
  assert.match(migration, /period_date IS NULL OR period_date > DATE '1900-01-01'/);
  // Every table is keyed to the connection, not the user: a Pin belongs to the
  // account it was published through.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS collection_run/);
  for (const table of ["metric_observation", "content_registry", "registry_cursor", "pin_task"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  // collection_run must be created before metric_observation references it.
  assert.ok(
    migration.indexOf("CREATE TABLE IF NOT EXISTS collection_run")
    < migration.indexOf("CREATE TABLE IF NOT EXISTS metric_observation"),
  );
  assert.equal(
    (migration.match(/REFERENCES social_connections\(id\) ON DELETE CASCADE/g) ?? []).length, 5,
  );
  // Later steps' tables must not ride along in this migration.
  assert.doesNotMatch(migration, /account_keyword_set|insight_report|insight_email_send/);
});

await test("the cron endpoints resolve the owner server-side and cap what a caller may ask for", () => {
  const collect = src("src/app/api/cron/insights-collect/route.ts");
  const connections = src("src/app/api/cron/insights-connections/route.ts");
  for (const route of [collect, connections]) {
    assert.match(route, /auth !== `Bearer \$\{secret\}`/);
    assert.match(route, /cron_not_configured/);
  }
  // The user id comes from the connection row, never from the request body, and
  // forConnection re-asserts the pair when the run actually starts.
  assert.doesNotMatch(collect, /body\.userId|body\.uid/);
  assert.match(collect, /Math\.min\(Math\.floor\(requested\), MAX_CALLS_PER_RUN\)/);
  // A real collection failure is a 503, never a green 200.
  assert.match(collect, /"collection_failed"/);
  assert.match(connections, /\.is\("disconnected_at", null\)/);
});

console.log(`\n${passed} Insights collector tests passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
