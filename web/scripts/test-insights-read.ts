/**
 * Unit tests for the Insights read path (v64 collection layer).
 *
 * The four tables are faked in memory, including the part that is easy to get wrong
 * on paper: `metric_latest_status` and `metric_latest_value` are DERIVED here the
 * way the migration derives them (latest observation per key; latest OK observation
 * per key), so a test that passes because the fake handed the composer a tidy answer
 * would have to first make the fake wrong in the same direction as the code.
 *
 * The assertion this file exists for is the fetch spy. "The page makes no Pinterest
 * calls" is the whole point of moving collection off the request path, and it is a
 * property that reading the code can only ever suggest — one `await client.…` added
 * later in a helper would undo it silently. So the Pinterest client here is a real
 * PinterestClient over a counting fetch, and the collected path must leave the
 * counter at zero.
 *
 * Run: npm run test:insights-read
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_CONTENT_ROW_LIMIT,
  PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT,
  buildMetricLookup,
  buildPinterestInsights,
  combineMetricStates,
  contentMetricsFor,
  daysFromValues,
  type CollectionRunRow,
  type CollectionSources,
  type ContentRegistryRow,
  type LatestStatusRow,
  type LatestValueRow,
  type LiveAnalyticsSlice,
} from "../src/lib/insights/collectionDashboard";
import type { InsightsObservationStatus, InsightsScope } from "../src/lib/insights/types";
import type { VibePinPublishedPinterestPin } from "../src/lib/server/insights/publishProvenance";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const src = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

const CONNECTION_ID = "conn-a";
const START = "2026-07-29";
const END = "2026-08-27";

const connection = {
  id: CONNECTION_ID,
  providerAccountId: "pinterest-1",
  providerAccountName: "Quiet Spaces",
  providerAccountUsername: "quietspaces",
};

// ── In-memory fake of the four tables ────────────────────────────────────────

type ObservationRow = {
  scope: "account" | "content";
  platformContentId: string | null;
  metricName: string;
  period: "day" | "lifetime";
  periodDate: string | null;
  metricValue: number | null;
  status: InsightsObservationStatus;
  observedAt: string;
};

function observationKey(row: ObservationRow): string {
  return [row.scope, row.platformContentId ?? "", row.metricName, row.period, row.periodDate ?? ""].join("|");
}

/**
 * `metric_observation` plus the two views over it, `collection_run` and
 * `content_registry`. Append-only, exactly like the table: nothing here updates a
 * row, because the migration forbids it and the "stale" semantics depend on old
 * observations surviving.
 */
class FakeCollectionDb {
  runs: CollectionRunRow[] = [];
  observations: ObservationRow[] = [];
  registry: ContentRegistryRow[] = [];

  observe(row: Partial<ObservationRow> & { metricName: string; observedAt: string }): void {
    this.observations.push({
      scope: row.scope ?? "content",
      platformContentId: row.platformContentId ?? null,
      metricName: row.metricName,
      period: row.period ?? "lifetime",
      periodDate: row.periodDate ?? null,
      metricValue: row.metricValue ?? null,
      status: row.status ?? (row.metricValue == null ? "not_returned" : "ok"),
      observedAt: row.observedAt,
    });
  }

  /** DISTINCT ON (key) … ORDER BY observed_at DESC — every status, not only ok. */
  private latest(rows: ObservationRow[]): ObservationRow[] {
    const byKey = new Map<string, ObservationRow>();
    for (const row of rows) {
      const key = observationKey(row);
      const current = byKey.get(key);
      if (!current || row.observedAt > current.observedAt) byKey.set(key, row);
    }
    return Array.from(byKey.values());
  }

  latestStatusView(): LatestStatusRow[] {
    return this.latest(this.observations).map(row => ({
      scope: row.scope,
      platformContentId: row.platformContentId,
      metricName: row.metricName,
      period: row.period,
      periodDate: row.periodDate,
      status: row.status,
      observedAt: row.observedAt,
    }));
  }

  latestValueView(): LatestValueRow[] {
    return this.latest(this.observations.filter(row => row.status === "ok"))
      .filter(row => row.metricValue != null)
      .map(row => ({
        scope: row.scope,
        platformContentId: row.platformContentId,
        metricName: row.metricName,
        period: row.period,
        periodDate: row.periodDate,
        metricValue: row.metricValue as number,
        observedAt: row.observedAt,
      }));
  }
}

function registryRow(overrides: Partial<ContentRegistryRow> & { platformContentId: string }): ContentRegistryRow {
  return {
    vibepinDraftId: null,
    publishedAt: null,
    format: "IMAGE",
    title: null,
    linkUrl: null,
    sourceEndpoint: "pins_list",
    lastSeenAt: "2026-08-27T03:00:00.000Z",
    ...overrides,
  };
}

function publishedPin(overrides: Partial<VibePinPublishedPinterestPin> & { pinId: string }): VibePinPublishedPinterestPin {
  return {
    draftId: `draft-${overrides.pinId}`,
    title: null,
    imageUrl: null,
    postUrl: `https://www.pinterest.com/pin/${overrides.pinId}/`,
    publishedAt: "2026-08-20T00:00:00.000Z",
    mediaType: "IMAGE",
    targetConnectionId: CONNECTION_ID,
    ...overrides,
  };
}

/** A real PinterestClient over a counting fetch. The counter is the assertion. */
async function pinterestSpy() {
  const { PinterestClient } = await import("../src/lib/server/pinterest/service");
  const requested: string[] = [];
  const client = PinterestClient.forTest({
    accessToken: "token",
    hooks: {
      fetchImpl: async input => {
        requested.push(String(input));
        return new Response(JSON.stringify({
          ALL: {
            daily_metrics: [{ date: END, metrics: { IMPRESSION: 10, OUTBOUND_CLICK: 2, SAVE: 1 } }],
            summary_metrics: { IMPRESSION: 10, OUTBOUND_CLICK: 2, SAVE: 1 },
          },
        }), { status: 200 });
      },
    },
  });
  return { client, requested };
}

type SourcesOptions = {
  provenance?: VibePinPublishedPinterestPin[];
  storageAvailable?: boolean;
  registryOwners?: Map<string, string>;
  client: Awaited<ReturnType<typeof pinterestSpy>>["client"];
  /** Pin id batches handed to the live reader, in order. */
  liveBatches: string[][];
};

/**
 * The production wiring, minus Supabase. `loadLiveAnalytics` calls the same client
 * method `dashboard.ts` calls, so a run that touches it is visible both as a batch
 * here and as an HTTP request on the spy.
 */
function sourcesFor(db: FakeCollectionDb, options: SourcesOptions): CollectionSources {
  return {
    loadLatestFinishedRun: async () => db.runs
      .filter(run => run.finishedAt !== null)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0] ?? null,
    loadLatestRun: async () => [...db.runs]
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null,
    loadAccountMetrics: async (startDate, endDate) => ({
      values: db.latestValueView().filter(row => row.scope === "account"
        && row.period === "day"
        && row.periodDate !== null
        && row.periodDate >= startDate
        && row.periodDate <= endDate),
      statuses: db.latestStatusView().filter(row => row.scope === "account"
        && row.period === "day"
        && row.periodDate !== null
        && row.periodDate >= startDate
        && row.periodDate <= endDate),
    }),
    loadRegistry: async limit => db.registry.slice(0, limit),
    loadContentMetrics: async (pinIds, opts) => {
      const wanted = new Set(pinIds);
      const keep = (row: { scope: string; platformContentId: string | null; period: string; periodDate: string | null }) => {
        if (row.scope !== "content" || !row.platformContentId || !wanted.has(row.platformContentId)) return false;
        if (row.period === "lifetime") return true;
        if (!opts.includeDaily || !row.periodDate) return false;
        return row.periodDate >= opts.startDate && row.periodDate <= opts.endDate;
      };
      return {
        values: db.latestValueView().filter(keep),
        statuses: db.latestStatusView().filter(keep),
      };
    },
    loadProvenance: async () => ({
      pins: options.provenance ?? [],
      storageAvailable: options.storageAvailable ?? true,
    }),
    loadRegistryOwners: async () => options.registryOwners ?? new Map<string, string>(),
    loadLiveAnalytics: async pinIds => {
      options.liveBatches.push([...pinIds]);
      const slices = new Map<string, LiveAnalyticsSlice | null>();
      for (const pinId of pinIds) {
        const response = await options.client.getOrganicPinAnalytics(
          pinId,
          START,
          END,
          ["IMPRESSION", "SAVE", "OUTBOUND_CLICK"],
        );
        slices.set(pinId, response.ALL ?? null);
      }
      return slices;
    },
  };
}

function finishedRun(finishedAt: string, skippedReason: string | null = null): CollectionRunRow {
  return {
    id: `run-${finishedAt}`,
    kind: "account_daily",
    startedAt: finishedAt,
    finishedAt,
    callsMade: 7,
    callsBudget: 30,
    skippedReason,
    error: null,
  };
}

async function build(db: FakeCollectionDb, scope: InsightsScope, options: SourcesOptions) {
  return buildPinterestInsights(
    { scope, connection, startDate: START, endDate: END },
    sourcesFor(db, options),
  );
}

async function main() {
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";

// ── (a) account scope: summary and heatmap from account daily rows ──────────

await test("account scope builds the heatmap and summary from account daily observations", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  for (const [date, impressions, clicks] of [["2026-08-25", 100, 4], ["2026-08-26", 300, 11]] as const) {
    db.observe({ scope: "account", metricName: "IMPRESSION", period: "day", periodDate: date, metricValue: impressions, observedAt: "2026-08-27T03:00:00.000Z" });
    db.observe({ scope: "account", metricName: "OUTBOUND_CLICK", period: "day", periodDate: date, metricValue: clicks, observedAt: "2026-08-27T03:00:00.000Z" });
    db.observe({ scope: "account", metricName: "SAVE", period: "day", periodDate: date, metricValue: 2, observedAt: "2026-08-27T03:00:00.000Z" });
  }
  // Outside the window: must not reach the summary.
  db.observe({ scope: "account", metricName: "IMPRESSION", period: "day", periodDate: "2026-06-01", metricValue: 9_999, observedAt: "2026-08-27T03:00:00.000Z" });

  const { client } = await pinterestSpy();
  const dashboard = await build(db, "account", { client, liveBatches: [] });

  assert.equal(dashboard.scope, "account");
  assert.equal(dashboard.daily.length, 30, "the range is always filled to 30 days");
  assert.equal(dashboard.summary.views, 400);
  assert.equal(dashboard.summary.websiteClicks, 15);
  assert.equal(dashboard.summary.saves, 4);
  // Interactions are the component sum, so saves and clicks are both counted once.
  assert.equal(dashboard.daily.find(day => day.date === "2026-08-26")?.interactions, 13);
  assert.equal(dashboard.collection?.mode, "collected");
  assert.equal(dashboard.collection?.dataUpdatedAt, "2026-08-27T03:05:00.000Z");
  // The account header comes from the stored connection row, never from an API call.
  assert.equal(dashboard.account?.name, "@quietspaces");
});

// ── (b) content rows from the registry, with an em dash for what is missing ──

await test("account scope lists registry rows and marks unmeasured Pins unavailable", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  db.registry.push(
    registryRow({ platformContentId: "111", title: "Measured Pin", vibepinDraftId: "draft-1", sourceEndpoint: "vibepin_publish", publishedAt: "2026-08-20T00:00:00.000Z" }),
    registryRow({ platformContentId: "222", title: "Never measured", publishedAt: "2026-08-19T00:00:00.000Z" }),
  );
  db.observe({ platformContentId: "111", metricName: "IMPRESSION", metricValue: 240, observedAt: "2026-08-27T03:00:00.000Z" });
  db.observe({ platformContentId: "111", metricName: "OUTBOUND_CLICK", metricValue: 12, observedAt: "2026-08-27T03:00:00.000Z" });

  const { client } = await pinterestSpy();
  const dashboard = await build(db, "account", { client, liveBatches: [] });

  const measured = dashboard.content.find(item => item.id === "111");
  const missing = dashboard.content.find(item => item.id === "222");
  assert.ok(measured && missing, "both registry rows are listed");
  assert.equal(measured.metricsAvailable, true);
  assert.equal(measured.metrics.views, 240);
  assert.equal(measured.metrics.websiteClicks, 12);
  // Origin is evidence, not inference: only a vibepin_publish row carries a draft id.
  assert.equal(measured.origin, "vibepin");
  assert.equal(missing.origin, "pinterest");
  // Nothing was ever observed for 222, so the row says so rather than showing zeros.
  assert.equal(missing.metricsAvailable, false);
  assert.equal(missing.metricsState, "not_collected");
  assert.equal(missing.metrics.websiteClicks, null);
  assert.equal(missing.diagnosis, "insights.diagnosis.notCollected");
});

await test("a Pin whose OUTBOUND_CLICK was not returned never reports zero clicks", () => {
  const db = new FakeCollectionDb();
  db.observe({ platformContentId: "333", metricName: "IMPRESSION", metricValue: 500, observedAt: "2026-08-27T03:00:00.000Z" });
  db.observe({ platformContentId: "333", metricName: "OUTBOUND_CLICK", metricValue: null, status: "not_returned", observedAt: "2026-08-27T03:00:00.000Z" });
  const lookup = buildMetricLookup(db.latestValueView(), db.latestStatusView());
  const read = contentMetricsFor(lookup, "333");
  assert.equal(read.available, true);
  assert.equal(read.metrics.views, 500);
  assert.equal(read.metrics.websiteClicks, null, "absent is not zero on the metric the page is about");
  assert.equal(read.metrics.trafficRate, null);
});

// ── (c) status precedence and the stale flag ────────────────────────────────

await test("a value survives a later empty attempt and is flagged stale", () => {
  const db = new FakeCollectionDb();
  db.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: 120, observedAt: "2026-08-25T03:00:00.000Z" });
  db.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: null, status: "not_returned", observedAt: "2026-08-27T03:00:00.000Z" });
  const lookup = buildMetricLookup(db.latestValueView(), db.latestStatusView());
  assert.equal(lookup.value("content", "444", "IMPRESSION", "lifetime"), 120, "the measurement is still real");
  assert.equal(lookup.state("content", "444", "IMPRESSION", "lifetime"), "stale", "but it is not current");

  // The opposite order is not stale: the newest word on the metric is the value.
  const fresh = new FakeCollectionDb();
  fresh.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: null, status: "not_returned", observedAt: "2026-08-25T03:00:00.000Z" });
  fresh.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: 120, observedAt: "2026-08-27T03:00:00.000Z" });
  const freshLookup = buildMetricLookup(fresh.latestValueView(), fresh.latestStatusView());
  assert.equal(freshLookup.state("content", "444", "IMPRESSION", "lifetime"), "ok");
});

await test("no value at all reports the most specific reason, never a bare blank", () => {
  const db = new FakeCollectionDb();
  db.observe({ platformContentId: "555", metricName: "IMPRESSION", metricValue: null, status: "no_permission", observedAt: "2026-08-27T03:00:00.000Z" });
  const lookup = buildMetricLookup(db.latestValueView(), db.latestStatusView());
  assert.equal(lookup.state("content", "555", "IMPRESSION", "lifetime"), "no_permission");
  // Never asked at all is a different fact from asked-and-refused.
  assert.equal(lookup.state("content", "556", "IMPRESSION", "lifetime"), "not_collected");

  assert.equal(combineMetricStates(["ok", "stale"], true), "stale", "one unconfirmed metric taints the row");
  assert.equal(combineMetricStates(["not_returned", "not_collected"], false), "not_returned");
  assert.equal(combineMetricStates(["no_permission", "not_returned"], false), "no_permission");
  assert.equal(combineMetricStates(["not_collected"], false), "not_collected");
});

await test("a row that kept a value is diagnosed on its numbers, not on the failed attempt", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  db.registry.push(registryRow({ platformContentId: "444", title: "Stale but real" }));
  db.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: 120, observedAt: "2026-08-25T03:00:00.000Z" });
  db.observe({ platformContentId: "444", metricName: "OUTBOUND_CLICK", metricValue: 6, observedAt: "2026-08-25T03:00:00.000Z" });
  db.observe({ platformContentId: "444", metricName: "IMPRESSION", metricValue: null, status: "not_returned", observedAt: "2026-08-27T03:00:00.000Z" });

  const { client } = await pinterestSpy();
  const dashboard = await build(db, "account", { client, liveBatches: [] });
  const row = dashboard.content[0];
  assert.equal(row.metricsAvailable, true);
  assert.equal(row.metrics.views, 120);
  assert.equal(row.metricsState, "stale");
  assert.notEqual(row.diagnosis, "insights.diagnosis.notCollected");
});

// ── (d) the fetch spy: a collected connection makes no Pinterest calls ──────

await test("a connection with a finished run performs ZERO Pinterest calls", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  db.registry.push(registryRow({ platformContentId: "111", vibepinDraftId: "draft-1", sourceEndpoint: "vibepin_publish" }));
  db.observe({ scope: "account", metricName: "IMPRESSION", period: "day", periodDate: "2026-08-26", metricValue: 40, observedAt: "2026-08-27T03:00:00.000Z" });
  db.observe({ platformContentId: "111", metricName: "IMPRESSION", metricValue: 40, observedAt: "2026-08-27T03:00:00.000Z" });
  db.observe({ platformContentId: "111", metricName: "IMPRESSION", period: "day", periodDate: "2026-08-26", metricValue: 40, observedAt: "2026-08-27T03:00:00.000Z" });

  const { client, requested } = await pinterestSpy();
  const liveBatches: string[][] = [];
  const provenance = [publishedPin({ pinId: "111", title: "Published by VibePin" })];

  const vibepin = await build(db, "vibepin", { client, liveBatches, provenance });
  const account = await build(db, "account", { client, liveBatches, provenance });

  assert.equal(requested.length, 0, `expected no Pinterest requests, got ${requested.join(", ")}`);
  assert.equal(liveBatches.length, 0, "the live reader is never even entered");
  assert.equal(vibepin.collection?.mode, "collected");
  assert.equal(account.collection?.mode, "collected");
  assert.equal(vibepin.content[0]?.metrics.views, 40);
  // The per-Pin daily rows drive the VibePin heatmap.
  assert.equal(vibepin.daily.find(day => day.date === "2026-08-26")?.views, 40);
});

await test("a finished run with no observations shows an empty collected state, never a live one", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  const { client, requested } = await pinterestSpy();
  const liveBatches: string[][] = [];
  const dashboard = await build(db, "vibepin", {
    client,
    liveBatches,
    provenance: [publishedPin({ pinId: "111" })],
  });
  assert.equal(requested.length, 0);
  assert.equal(liveBatches.length, 0);
  assert.equal(dashboard.collection?.mode, "collected");
  assert.equal(dashboard.content[0].metricsAvailable, false);
  assert.equal(dashboard.summary.views, 0);
});

await test("an unfinished run does not count as collection having happened", async () => {
  const db = new FakeCollectionDb();
  db.runs.push({
    id: "crashed",
    kind: "account_daily",
    startedAt: "2026-08-27T03:00:00.000Z",
    finishedAt: null,
    callsMade: 2,
    callsBudget: 30,
    skippedReason: null,
    error: "boom",
  });
  const { client } = await pinterestSpy();
  const liveBatches: string[][] = [];
  const dashboard = await build(db, "vibepin", {
    client,
    liveBatches,
    provenance: [publishedPin({ pinId: "111" })],
  });
  assert.equal(dashboard.collection?.mode, "live_sample");
});

// ── (e) the fallback: only without a finished run, and capped at 20 ─────────

await test("without a finished run the VibePin scope reads a live sample capped at 20", async () => {
  assert.equal(PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT, 20, "the cap is the promise, not a suggestion");
  const db = new FakeCollectionDb();
  const provenance = Array.from({ length: 45 }, (_, index) => publishedPin({ pinId: String(100_000 + index) }));
  const { client, requested } = await pinterestSpy();
  const liveBatches: string[][] = [];

  const dashboard = await build(db, "vibepin", { client, liveBatches, provenance });

  assert.equal(liveBatches.length, 1);
  assert.equal(liveBatches[0].length, 20, "sliced before the reader is called");
  assert.equal(requested.length, 20, "one Pinterest request per sampled Pin, and no more");
  assert.equal(dashboard.content.length, 20);
  assert.equal(dashboard.collection?.mode, "live_sample");
  assert.equal(dashboard.collection?.sampleLimit, 20);
  assert.equal(dashboard.collection?.dataUpdatedAt, null);
  assert.equal(dashboard.content[0].metricsAvailable, true);
});

await test("without a finished run the account scope shows nothing and calls nothing", async () => {
  const db = new FakeCollectionDb();
  const { client, requested } = await pinterestSpy();
  const liveBatches: string[][] = [];
  const dashboard = await build(db, "account", {
    client,
    liveBatches,
    provenance: Array.from({ length: 30 }, (_, index) => publishedPin({ pinId: String(200_000 + index) })),
  });
  assert.equal(requested.length, 0, "there is no honest live equivalent of the account scope");
  assert.equal(liveBatches.length, 0);
  assert.equal(dashboard.collection?.mode, "awaiting_first_run");
  assert.equal(dashboard.content.length, 0);
  assert.equal(dashboard.daily.length, 30);
});

await test("one finished run retires the live path even when a later run crashed", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-26T03:05:00.000Z"));
  db.runs.push({
    id: "crashed",
    kind: "pin_task",
    startedAt: "2026-08-27T03:00:00.000Z",
    finishedAt: null,
    callsMade: 1,
    callsBudget: 30,
    skippedReason: "rate_limited",
    error: null,
  });
  const { client, requested } = await pinterestSpy();
  const liveBatches: string[][] = [];
  const dashboard = await build(db, "vibepin", {
    client,
    liveBatches,
    provenance: [publishedPin({ pinId: "111" })],
  });
  assert.equal(requested.length, 0, "a crashed run must not send the page back to live calls");
  assert.equal(dashboard.collection?.mode, "collected");
  assert.equal(dashboard.collection?.dataUpdatedAt, "2026-08-26T03:05:00.000Z");
  // skipped_reason belongs to the most recent ATTEMPT, finished or not.
  assert.equal(dashboard.collection?.skippedReason, "rate_limited");
});

// ── Attribution and scoping ────────────────────────────────────────────────

await test("the VibePin scope shows only Pins this connection published", async () => {
  const db = new FakeCollectionDb();
  db.runs.push(finishedRun("2026-08-27T03:05:00.000Z"));
  const { client } = await pinterestSpy();
  const dashboard = await build(db, "vibepin", {
    client,
    liveBatches: [],
    provenance: [
      publishedPin({ pinId: "111" }),
      publishedPin({ pinId: "222", targetConnectionId: "conn-b" }),
      // No recorded target: the registry says conn-b owns it.
      publishedPin({ pinId: "333", targetConnectionId: null }),
      // No recorded target and no registry row: visible everywhere, because the
      // owning account is still the only one that returns numbers for it.
      publishedPin({ pinId: "444", targetConnectionId: null }),
    ],
    registryOwners: new Map([["333", "conn-b"]]),
  });
  const ids = dashboard.content.map(item => item.id).sort();
  assert.deepEqual(ids, ["111", "444"]);
});

await test("content daily rows outside the visible window never reach the heatmap", () => {
  const values: LatestValueRow[] = [
    { scope: "content", platformContentId: "111", metricName: "IMPRESSION", period: "day", periodDate: "2026-08-26", metricValue: 12, observedAt: "2026-08-27T03:00:00.000Z" },
    { scope: "content", platformContentId: "111", metricName: "IMPRESSION", period: "day", periodDate: "2026-05-01", metricValue: 900, observedAt: "2026-08-27T03:00:00.000Z" },
    { scope: "content", platformContentId: "999", metricName: "IMPRESSION", period: "day", periodDate: "2026-08-26", metricValue: 77, observedAt: "2026-08-27T03:00:00.000Z" },
  ];
  const days = daysFromValues(values, { scope: "content", pinIds: new Set(["111"]), startDate: START, endDate: END });
  assert.equal(days.length, 30);
  assert.equal(days.find(day => day.date === "2026-08-26")?.views, 12, "another Pin's day is not added in");
  assert.equal(days.reduce((total, day) => total + day.views, 0), 12);
});

// ── Source contracts: properties that must outlive these fakes ─────────────

await test("the dashboard reaches Pinterest only from the live fallback reader", () => {
  const dashboard = src("src/lib/server/insights/dashboard.ts");
  const collection = src("src/lib/insights/collectionDashboard.ts");
  // Building the client can refresh a token, so an eager construction would be a
  // Pinterest round trip on the collected path too. It lives inside loadLiveAnalytics.
  const liveReader = dashboard.slice(dashboard.indexOf("loadLiveAnalytics:"));
  assert.match(liveReader, /PinterestClient\.forConnection\(uid, connection\.id\)/);
  assert.equal(
    dashboard.split("PinterestClient.forConnection(").length - 1,
    1,
    "exactly one client construction, and it is inside the fallback reader",
  );
  // The @handle used to cost one API call per page load; it comes from the row now.
  // Matched as a CALL (leading dot) so the comment explaining the removal survives.
  assert.doesNotMatch(dashboard, /\.getCurrentPinterestUser/);
  assert.doesNotMatch(dashboard, /forUser\(/);
  // The composer must not be able to call Pinterest at all, and must stay loadable
  // outside a Next server runtime — which is what lets this file test it directly.
  assert.doesNotMatch(collection, /PinterestClient/);
  assert.doesNotMatch(collection, /^import "server-only"/m);
  assert.doesNotMatch(collection, /^import \{[^}]*\} from "@\/lib\/server\//m);
});

await test("the read store degrades a missing v64 schema to empty instead of throwing", () => {
  const store = src("src/lib/server/insights/insightsReadStore.ts");
  // This ships before the migration is applied in production; a reader that threw
  // would blank the live page on deploy day instead of falling back.
  for (const reader of ["loadLatestFinishedRun", "loadLatestRun", "loadAccountMetrics", "loadRegistry", "loadContentMetrics"]) {
    assert.match(store, new RegExp(`export async function ${reader}`), reader);
  }
  assert.equal(store.split("isMissingSchema(").length - 1, 6, "every query checks for a missing relation");
  // The finished-run gate must ask the database for a finished run, not filter a
  // window of recent runs in memory.
  assert.match(store, /\.not\("finished_at", "is", null\)/);
  assert.match(store, /\.order\("finished_at", \{ ascending: false \}\)/);
});

await test("the page carries the scope into every request and bounds thumbnail hydration", () => {
  const page = src("src/app/app/insights/page.tsx");
  const route = src("src/app/api/insights/route.ts");
  assert.match(route, /readScope\(url\.searchParams\.get\("scope"\)\)/);
  assert.match(route, /value === "account" \? "account" : "vibepin"/);
  // Both the single-account query and the per-account cards, or one view would
  // answer with the other view's numbers.
  assert.equal(page.split("scope=${").length - 1, 2);
  assert.match(page, /ScopeToggle scope=\{scope\}/);
  assert.match(page, /const HYDRATION_LIMIT = 20/);
  assert.equal(page.split("slice(0, HYDRATION_LIMIT)").length - 1, 2);
  assert.match(page, /insights\.content\.originVibePin/);
  assert.match(page, /insights\.collection\.dataUpdated/);
});

await test("the account table is bounded and every new string has an English key", () => {
  assert.equal(ACCOUNT_CONTENT_ROW_LIMIT, 200);
  const catalog = src("src/lib/i18n/messages/en/insights.ts");
  for (const key of [
    "insights.scope.vibepin",
    "insights.scope.account",
    "insights.collection.dataUpdated",
    "insights.collection.liveSample",
    "insights.collection.awaitingFirstRun",
    "insights.collection.skipped",
    "insights.collection.reason.rateLimited",
    "insights.collection.reason.budgetExhausted",
    "insights.collection.reason.deadline",
    "insights.collection.reason.noPermission",
    "insights.collection.reason.other",
    "insights.content.helpAccount",
    "insights.content.emptyAccountTitle",
    "insights.content.emptyAccountBody",
    "insights.content.notCollected",
    "insights.content.noPermission",
    "insights.content.stale",
    "insights.content.originVibePin",
    "insights.content.originPinterest",
    "insights.diagnosis.awaitingPlatform",
    "insights.diagnosis.notCollected",
    "insights.diagnosis.noPermission",
  ]) {
    assert.match(catalog, new RegExp(`"${key.replace(/\./g, "\\.")}":`), `catalog key ${key}`);
  }
});

console.log(`\n${passed} Insights read-layer tests passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
