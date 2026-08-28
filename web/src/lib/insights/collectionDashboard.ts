/**
 * The Insights read path: turn v64 collection rows into a dashboard.
 *
 * Pure by construction — no Supabase client, no Pinterest client, no `server-only`
 * import. Everything it needs arrives through `CollectionSources`, a set of small
 * async readers supplied by `server/insights/dashboard.ts` in production and by an
 * in-memory fake in `scripts/test-insights-read.ts`.
 *
 * That split is what makes the central promise testable rather than asserted. The
 * promise is: **a page request makes no Pinterest API call**. Before this module the
 * dashboard called `getOrganicPinAnalytics` once per Pin while the user waited, so
 * every page view spent the account's rate-limit allowance on data we already had a
 * ledger for. Here the Pinterest reader (`loadLiveAnalytics`) is one injectable
 * function among ten, so a test can hand in a spy and assert it was never called —
 * a property no amount of reading the code can guarantee once someone edits it.
 *
 * ── The one exception ────────────────────────────────────────────────────────
 * A connection whose collector has never finished a run has nothing to read. Showing
 * an empty dashboard there would be indistinguishable from "you have no Pins", which
 * is the failure this whole layer exists to prevent. So that state, and only that
 * state, reads a bounded live sample (20 Pins) for the VibePin scope and says so.
 * The gate is a FINISHED run, not a run: a connection whose runs all crashed is
 * exactly when live calls are most expensive and least likely to help, so it keeps
 * the sample rather than pretending collection works.
 */

import {
  emptyMetrics,
  fillDailyRange,
  finiteMetric,
  missingMetricsDiagnosis,
  summarizeDays,
  trafficRate,
} from "./businessRules";
import {
  buildEvidence,
  type Evidence,
  type EvidenceContentRow,
  type EvidenceKeywordSet,
  type EvidenceMetricName,
  type EvidenceObservation,
  type EvidenceSet,
} from "./evidence";
import { buildDiagnosis, describeContentRow, type InsightsDiagnosis } from "./recommendations";
import type {
  InsightsCollectionState,
  InsightsContent,
  InsightsContentOrigin,
  InsightsDashboard,
  InsightsDay,
  InsightsMetricState,
  InsightsMetrics,
  InsightsObservationStatus,
  InsightsScope,
} from "./types";
import type { VibePinPublishedPinterestPin } from "@/lib/server/insights/publishProvenance";

/**
 * Pins read live when collection has never finished. Was 60 on the live-only path;
 * 20 here because this is a stopgap shown for at most one night, and 60 sequential
 * analytics calls is most of a connection's minute allowance spent on a page view.
 */
export const PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT = 20;

/** Registry rows offered in the "Your account" table. An account can hold thousands
 *  of Pins; the table is a working list, not an export, and every row costs a metric
 *  lookup. Newest first, so the bound cuts the least useful end. */
export const ACCOUNT_CONTENT_ROW_LIMIT = 200;

/** Metrics the collector records and the dashboard reads back. Kept as strings (not
 *  the Pinterest client union) so this module stays free of server imports. */
export const READ_METRICS = [
  "IMPRESSION",
  "SAVE",
  "PIN_CLICK",
  "OUTBOUND_CLICK",
  "TOTAL_COMMENTS",
  "TOTAL_REACTIONS",
] as const;

type MetricScope = "account" | "content";
type MetricPeriod = "day" | "lifetime";

export type LatestValueRow = {
  scope: MetricScope;
  platformContentId: string | null;
  metricName: string;
  period: MetricPeriod;
  periodDate: string | null;
  metricValue: number;
  observedAt: string;
};

export type LatestStatusRow = {
  scope: MetricScope;
  platformContentId: string | null;
  metricName: string;
  period: MetricPeriod;
  periodDate: string | null;
  status: InsightsObservationStatus;
  observedAt: string;
};

export type MetricRows = {
  values: LatestValueRow[];
  statuses: LatestStatusRow[];
};

export const EMPTY_METRIC_ROWS: MetricRows = { values: [], statuses: [] };

export type ContentRegistryRow = {
  platformContentId: string;
  vibepinDraftId: string | null;
  publishedAt: string | null;
  format: string | null;
  title: string | null;
  /** Read by A1: a phrase in the description counts as much as one in the title. */
  description: string | null;
  linkUrl: string | null;
  /** Read by category inference only — board names say what an account is about
   *  without any of the account's words reaching the phrase set. */
  boardName: string | null;
  sourceEndpoint: "pins_list" | "top_pins" | "vibepin_publish";
  lastSeenAt: string | null;
};

/** One raw lifetime observation. Ordered history, not a latest-value view: the
 *  difference is the whole reason C5 can exist. */
export type ObservationHistoryRow = {
  pinId: string;
  metricName: string;
  metricValue: number;
  observedAt: string;
};

export type CollectionRunRow = {
  id: string | null;
  kind: string;
  startedAt: string | null;
  finishedAt: string | null;
  callsMade: number;
  callsBudget: number;
  skippedReason: string | null;
  error: string | null;
};

/** Structurally compatible with PinterestOrganicAnalyticsSlice, without importing it. */
export type LiveAnalyticsSlice = {
  daily_metrics?: Array<{ date?: string; metrics?: Record<string, unknown> }> | null;
  summary_metrics?: Record<string, unknown> | null;
};

export type InsightsConnectionRef = {
  id: string;
  providerAccountId: string | null;
  providerAccountName: string | null;
  providerAccountUsername: string | null;
};

/**
 * Everything the read path may ask for. Each reader is separately fakeable, which is
 * the point: the fetch-spy test replaces exactly one of them.
 */
export type CollectionSources = {
  /** Newest run WITH a finish time. The gate for the live fallback. */
  loadLatestFinishedRun(): Promise<CollectionRunRow | null>;
  /** Newest run of any kind, finished or not — where `skipped_reason` comes from. */
  loadLatestRun(): Promise<CollectionRunRow | null>;
  loadAccountMetrics(startDate: string, endDate: string): Promise<MetricRows>;
  loadRegistry(limit: number): Promise<ContentRegistryRow[]>;
  loadContentMetrics(
    pinIds: string[],
    options: { startDate: string; endDate: string; includeDaily: boolean },
  ): Promise<MetricRows>;
  loadProvenance(): Promise<{ pins: VibePinPublishedPinterestPin[]; storageAvailable: boolean }>;
  /** Registry ownership across the other Pinterest connections of the same user — a
   *  Pin listed by account A is not account B, and only a cross-account lookup knows. */
  loadRegistryOwners(pinIds: string[]): Promise<Map<string, string>>;
  /** Append-only observation history for the age-pinned comparisons (C5). Empty is a
   *  normal answer: it means nothing was collected at a fixed age yet. */
  loadObservationHistory(pinIds: string[]): Promise<ObservationHistoryRow[]>;
  /** The phrase set this account's Pin text is checked against. `inferenceTexts` are
   *  board names and Pin titles, used ONLY to pick a category. */
  loadKeywordSet(inferenceTexts: string[]): Promise<EvidenceKeywordSet>;
  /** The ONLY reader that talks to Pinterest. Called on the fallback path alone. */
  loadLiveAnalytics(pinIds: string[]): Promise<Map<string, LiveAnalyticsSlice | null>>;
};

export const EMPTY_KEYWORD_SET_INPUT: EvidenceKeywordSet = {
  phrases: [],
  category: null,
  version: null,
  hash: "0",
};

// ── Metric lookup ────────────────────────────────────────────────────────────

/** The five fields that identify one measurement, in a fixed order. "|" is a safe
 *  separator because every part is drawn from a constrained alphabet: two scopes,
 *  a numeric Pin id, an upper-case metric name, two periods and an ISO date. */
function metricKey(
  scope: MetricScope,
  platformContentId: string | null,
  metricName: string,
  period: MetricPeriod,
  periodDate: string | null,
): string {
  return [scope, platformContentId ?? "", metricName, period, periodDate ?? ""].join("|");
}

export type MetricLookup = {
  value(
    scope: MetricScope,
    platformContentId: string | null,
    metricName: string,
    period: MetricPeriod,
    periodDate?: string | null,
  ): number | null;
  state(
    scope: MetricScope,
    platformContentId: string | null,
    metricName: string,
    period: MetricPeriod,
    periodDate?: string | null,
  ): InsightsMetricState;
};

/**
 * Index the two views by measurement key.
 *
 * They are read separately because they answer different questions:
 * `metric_latest_value` is the newest observation that CARRIES a number,
 * `metric_latest_status` is the newest observation full stop. Joining them is what
 * distinguishes "42, measured last night" from "42, and last night attempt came back
 * empty" — the second is still worth showing, but not as today number.
 *
 * Both maps keep the newest row per key defensively: the views already guarantee one
 * row each, but a caller assembling rows by hand (a test fake, a future batched read)
 * must not be able to make the answer depend on array order.
 */
export function buildMetricLookup(values: LatestValueRow[], statuses: LatestStatusRow[]): MetricLookup {
  const valueByKey = new Map<string, LatestValueRow>();
  for (const row of values) {
    const key = metricKey(row.scope, row.platformContentId, row.metricName, row.period, row.periodDate);
    const existing = valueByKey.get(key);
    if (!existing || row.observedAt > existing.observedAt) valueByKey.set(key, row);
  }
  const statusByKey = new Map<string, LatestStatusRow>();
  for (const row of statuses) {
    const key = metricKey(row.scope, row.platformContentId, row.metricName, row.period, row.periodDate);
    const existing = statusByKey.get(key);
    if (!existing || row.observedAt > existing.observedAt) statusByKey.set(key, row);
  }

  return {
    value(scope, platformContentId, metricName, period, periodDate = null) {
      const row = valueByKey.get(metricKey(scope, platformContentId, metricName, period, periodDate));
      if (!row) return null;
      const value = Number(row.metricValue);
      return Number.isFinite(value) ? value : null;
    },
    state(scope, platformContentId, metricName, period, periodDate = null) {
      const key = metricKey(scope, platformContentId, metricName, period, periodDate);
      const value = valueByKey.get(key) ?? null;
      const status = statusByKey.get(key) ?? null;
      // Nothing at all: nobody ever spent a call on this measurement.
      if (!value) return status ? (status.status === "ok" ? "ok" : status.status) : "not_collected";
      if (!status || status.status === "ok") return "ok";
      // A value AND a newer failed attempt: the number is real but not current.
      return status.observedAt > value.observedAt ? "stale" : "ok";
    },
  };
}

/**
 * One state for a row from the states of its metrics.
 *
 * A row with any number is reportable; the only question is whether the newest
 * attempt confirmed it. A row with none takes the most specific explanation
 * available, because that is what the user needs to act on: `no_permission` is
 * fixable by reconnecting, `not_returned` is the platform answer and needs patience,
 * `not_collected` means we have not asked yet.
 */
export function combineMetricStates(states: InsightsMetricState[], hasValue: boolean): InsightsMetricState {
  if (hasValue) return states.includes("stale") ? "stale" : "ok";
  if (states.includes("no_permission")) return "no_permission";
  if (states.includes("not_returned")) return "not_returned";
  return "not_collected";
}

export type ContentMetricsRead = {
  metrics: InsightsMetrics;
  state: InsightsMetricState;
  available: boolean;
};

/**
 * The lifetime numbers of one Pin.
 *
 * `websiteClicks` stays null when OUTBOUND_CLICK was not returned even though other
 * metrics were: writing 0 there would turn "Pinterest did not say" into "nobody
 * clicked", which is the single most damaging rounding this product could make — it
 * is the metric the whole page is about.
 */
export function contentMetricsFor(lookup: MetricLookup, pinId: string): ContentMetricsRead {
  const read = (name: string) => lookup.value("content", pinId, name, "lifetime", null);
  const views = read("IMPRESSION");
  const saves = read("SAVE");
  const clicks = read("OUTBOUND_CLICK");
  const pinClicks = read("PIN_CLICK");
  const comments = read("TOTAL_COMMENTS");
  const reactions = read("TOTAL_REACTIONS");
  const states = READ_METRICS.map(name => lookup.state("content", pinId, name, "lifetime", null));
  const hasValue = [views, saves, clicks, pinClicks, comments, reactions].some(value => value !== null);
  const state = combineMetricStates(states, hasValue);

  if (!hasValue) return { metrics: emptyMetrics(null), state, available: false };

  const seen = finiteMetric(views);
  const kept = finiteMetric(saves);
  const outbound = clicks === null ? null : finiteMetric(clicks);
  return {
    metrics: {
      views: seen,
      interactions: kept + finiteMetric(clicks) + finiteMetric(pinClicks)
        + finiteMetric(comments) + finiteMetric(reactions),
      saves: kept,
      shares: 0,
      websiteClicks: outbound,
      trafficRate: trafficRate(outbound, seen),
    },
    state,
    available: true,
  };
}

/**
 * The 30-day series from daily observations.
 *
 * `pinIds` scopes content-level rows to one set of Pins; without it a VibePin-scope
 * heatmap would silently include Pins the user never published through VibePin.
 */
export function daysFromValues(
  values: LatestValueRow[],
  options: { scope: MetricScope; pinIds?: Set<string> | null; startDate: string; endDate: string },
): InsightsDay[] {
  const byDate = new Map<string, InsightsDay>();
  for (const row of values) {
    if (row.scope !== options.scope) continue;
    if (row.period !== "day" || !row.periodDate) continue;
    if (row.periodDate < options.startDate || row.periodDate > options.endDate) continue;
    if (options.pinIds && !(row.platformContentId && options.pinIds.has(row.platformContentId))) continue;
    const current = byDate.get(row.periodDate) ?? {
      date: row.periodDate,
      views: 0,
      interactions: 0,
      saves: 0,
      shares: 0,
      websiteClicks: 0,
      trafficRate: null,
    };
    const value = finiteMetric(row.metricValue);
    if (row.metricName === "IMPRESSION") current.views += value;
    if (row.metricName === "SAVE") current.saves += value;
    if (row.metricName === "OUTBOUND_CLICK") current.websiteClicks = (current.websiteClicks ?? 0) + value;
    if (row.metricName === "SAVE" || row.metricName === "OUTBOUND_CLICK" || row.metricName === "PIN_CLICK"
      || row.metricName === "TOTAL_COMMENTS" || row.metricName === "TOTAL_REACTIONS") {
      current.interactions += value;
    }
    current.trafficRate = trafficRate(current.websiteClicks, current.views);
    byDate.set(row.periodDate, current);
  }
  return fillDailyRange(Array.from(byDate.values()), options.startDate, options.endDate, true);
}

function contentFormat(raw: string | null): InsightsContent["format"] {
  const value = (raw ?? "").toUpperCase();
  if (value.includes("CAROUSEL")) return "carousel";
  if (value.includes("VIDEO") || value.includes("REEL")) return "video";
  if (value.includes("IMAGE")) return "image";
  return "unknown";
}

function pinUrl(pinId: string): string {
  return `https://www.pinterest.com/pin/${pinId}/`;
}

function sortContent(rows: InsightsContent[]): InsightsContent[] {
  return [...rows].sort((a, b) => {
    const clickDiff = (b.metrics.websiteClicks ?? -1) - (a.metrics.websiteClicks ?? -1);
    if (clickDiff !== 0) return clickDiff;
    return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  });
}

/** Rows for the "Published via VibePin" scope: the publish whitelist, with whatever
 *  the collector has measured for each. A Pin with nothing measured still appears —
 *  it was published, and hiding it would be a worse answer than an em dash. */
export function vibepinContentRows(
  pins: VibePinPublishedPinterestPin[],
  lookup: MetricLookup,
): InsightsContent[] {
  return sortContent(pins.map((record): InsightsContent => {
    const read = contentMetricsFor(lookup, record.pinId);
    return {
      id: record.pinId,
      title: record.title || `VibePin Pin ${record.pinId.slice(-6)}`,
      imageUrl: record.imageUrl,
      postUrl: record.postUrl,
      publishedAt: record.publishedAt ?? null,
      format: contentFormat(record.mediaType),
      metrics: read.metrics,
      metricsAvailable: read.available,
      metricsState: read.state,
      origin: "vibepin",
      websiteClickAvailability: "pin_level",
      diagnosis: "",
    };
  }));
}

/**
 * Rows for the "Your account" scope: everything in the registry.
 *
 * `vibepin_draft_id` decides the origin: it is written only by a `vibepin_publish`
 * registry row, so it is evidence rather than inference. Title and thumbnail are
 * borrowed from the publish record when there is one — the registry keeps no image
 * URL, and a Pin we published is one we already have a picture of, so asking
 * Pinterest for it again would spend a call to learn something we know.
 */
export function accountContentRows(
  registry: ContentRegistryRow[],
  lookup: MetricLookup,
  provenanceByPin: Map<string, VibePinPublishedPinterestPin>,
): InsightsContent[] {
  return sortContent(registry.map((row): InsightsContent => {
    const read = contentMetricsFor(lookup, row.platformContentId);
    const published = provenanceByPin.get(row.platformContentId) ?? null;
    const origin: InsightsContentOrigin = row.vibepinDraftId ? "vibepin" : "pinterest";
    return {
      id: row.platformContentId,
      title: row.title || published?.title || `Pin ${row.platformContentId.slice(-6)}`,
      imageUrl: published?.imageUrl ?? null,
      postUrl: published?.postUrl ?? pinUrl(row.platformContentId),
      publishedAt: row.publishedAt ?? published?.publishedAt ?? null,
      format: contentFormat(row.format),
      metrics: read.metrics,
      metricsAvailable: read.available,
      metricsState: read.state,
      origin,
      websiteClickAvailability: "pin_level",
      diagnosis: "",
    };
  }));
}

/** Lifetime totals across the rows that actually carry numbers. Rows without
 *  measurements are left out rather than counted as zero. */
export function summarizeContent(rows: InsightsContent[]): InsightsMetrics {
  const summary = rows
    .filter(item => item.metricsAvailable !== false)
    .reduce((total, item) => ({
      views: total.views + item.metrics.views,
      interactions: total.interactions + item.metrics.interactions,
      saves: total.saves + item.metrics.saves,
      shares: total.shares + item.metrics.shares,
      websiteClicks: (total.websiteClicks ?? 0) + (item.metrics.websiteClicks ?? 0),
      trafficRate: null,
    }), emptyMetrics(0));
  summary.trafficRate = trafficRate(summary.websiteClicks, summary.views);
  return summary;
}

// ── Attribution ──────────────────────────────────────────────────────────────

/**
 * Does this Pin belong on the dashboard of this connection?
 *
 * The recorded target of the draft wins (it is what the publish path actually did),
 * then the registry owner (the account whose token listed the Pin), and only when
 * neither knows does a Pin stay visible on every account — where the owning account
 * is still the only one with numbers for it.
 */
export function attributePin(
  targetConnectionId: string | null,
  registryOwnerConnectionId: string | null,
  renderingConnectionId: string,
): boolean {
  if (targetConnectionId) return targetConnectionId === renderingConnectionId;
  if (registryOwnerConnectionId) return registryOwnerConnectionId === renderingConnectionId;
  return true;
}

async function attributedPins(
  pins: VibePinPublishedPinterestPin[],
  connectionId: string,
  sources: CollectionSources,
): Promise<VibePinPublishedPinterestPin[]> {
  const legacyPinIds = pins.filter(item => item.targetConnectionId === null).map(item => item.pinId);
  const owners = legacyPinIds.length > 0
    ? await sources.loadRegistryOwners(legacyPinIds).catch(() => new Map<string, string>())
    : new Map<string, string>();
  return pins.filter(item => attributePin(
    item.targetConnectionId,
    owners.get(item.pinId) ?? null,
    connectionId,
  ));
}

// ── Live sample (fallback only) ──────────────────────────────────────────────

function summarizeSlice(slice: LiveAnalyticsSlice | null): Record<string, unknown> {
  if (!slice) return {};
  if (slice.summary_metrics) return slice.summary_metrics;
  const summary: Record<string, number> = {};
  for (const row of slice.daily_metrics ?? []) {
    for (const [key, value] of Object.entries(row.metrics ?? {})) {
      summary[key] = finiteMetric(summary[key]) + finiteMetric(value);
    }
  }
  return summary;
}

function liveContentRows(
  pins: VibePinPublishedPinterestPin[],
  slices: Map<string, LiveAnalyticsSlice | null>,
): InsightsContent[] {
  return sortContent(pins.map((record): InsightsContent => {
    const slice = slices.get(record.pinId) ?? null;
    const metrics = summarizeSlice(slice);
    const read = (name: string) => finiteMetric(metrics[name]);
    const views = read("IMPRESSION");
    const clicks = read("OUTBOUND_CLICK");
    const saves = read("SAVE");
    return {
      id: record.pinId,
      title: record.title || `VibePin Pin ${record.pinId.slice(-6)}`,
      imageUrl: record.imageUrl,
      postUrl: record.postUrl,
      publishedAt: record.publishedAt ?? null,
      format: contentFormat(record.mediaType),
      metrics: {
        views,
        interactions: saves + clicks + read("PIN_CLICK") + read("TOTAL_COMMENTS") + read("TOTAL_REACTIONS"),
        saves,
        shares: 0,
        websiteClicks: clicks,
        trafficRate: trafficRate(clicks, views),
      },
      metricsAvailable: slice !== null,
      metricsState: slice !== null ? "ok" : "not_collected",
      origin: "vibepin",
      websiteClickAvailability: "pin_level",
      diagnosis: "",
    };
  }));
}

function liveDays(
  slices: Map<string, LiveAnalyticsSlice | null>,
  startDate: string,
  endDate: string,
): InsightsDay[] {
  const byDate = new Map<string, InsightsDay>();
  for (const slice of slices.values()) {
    for (const row of slice?.daily_metrics ?? []) {
      if (typeof row.date !== "string" || !row.date) continue;
      const current = byDate.get(row.date) ?? {
        date: row.date,
        views: 0,
        interactions: 0,
        saves: 0,
        shares: 0,
        websiteClicks: 0,
        trafficRate: null,
      };
      const read = (name: string) => finiteMetric(row.metrics?.[name]);
      const saves = read("SAVE");
      const clicks = read("OUTBOUND_CLICK");
      current.views += read("IMPRESSION");
      current.saves += saves;
      current.websiteClicks = (current.websiteClicks ?? 0) + clicks;
      current.interactions += saves + clicks + read("PIN_CLICK") + read("TOTAL_COMMENTS") + read("TOTAL_REACTIONS");
      current.trafficRate = trafficRate(current.websiteClicks, current.views);
      byDate.set(row.date, current);
    }
  }
  return fillDailyRange(Array.from(byDate.values()), startDate, endDate, true);
}

// ── Evidence assembly ────────────────────────────────────────────────────────

const EVIDENCE_METRICS: EvidenceMetricName[] = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK"];

/** Lifetime values per metric, `null` where nothing was observed. Never 0: the
 *  engine's ratios must be able to tell "no clicks" from "no measurement". */
function lifetimeOf(lookup: MetricLookup, pinId: string): Partial<Record<EvidenceMetricName, number | null>> {
  const values: Partial<Record<EvidenceMetricName, number | null>> = {};
  for (const name of EVIDENCE_METRICS) {
    values[name] = lookup.value("content", pinId, name, "lifetime", null);
  }
  return values;
}

/**
 * The set of Pins the engine reasons over, for BOTH scopes.
 *
 * Deliberately not "the rows of the current scope": cohorts are how a Pin is judged,
 * and a cohort assembled from the VibePin publish list alone would compare a Pin with
 * a fifth of its own account. The account's registry is the population; Pins VibePin
 * published that the registry has not caught up with are added so a freshly published
 * Pin is never invisible to its own diagnosis.
 */
export function evidenceContentRows(
  registry: ContentRegistryRow[],
  publishedByPin: Map<string, VibePinPublishedPinterestPin>,
  lookup: MetricLookup,
): EvidenceContentRow[] {
  const rows: EvidenceContentRow[] = [];
  const seen = new Set<string>();
  for (const row of registry) {
    seen.add(row.platformContentId);
    const published = publishedByPin.get(row.platformContentId) ?? null;
    rows.push({
      pinId: row.platformContentId,
      title: row.title ?? published?.title ?? null,
      description: row.description,
      linkUrl: row.linkUrl,
      publishedAt: row.publishedAt ?? published?.publishedAt ?? null,
      format: contentFormat(row.format ?? published?.mediaType ?? null),
      origin: row.vibepinDraftId ? "vibepin" : "pinterest",
      lifetime: lifetimeOf(lookup, row.platformContentId),
    });
  }
  for (const [pinId, published] of publishedByPin) {
    if (seen.has(pinId)) continue;
    rows.push({
      pinId,
      title: published.title,
      description: null,
      linkUrl: null,
      publishedAt: published.publishedAt,
      format: contentFormat(published.mediaType),
      origin: "vibepin",
      lifetime: lifetimeOf(lookup, pinId),
    });
  }
  return rows;
}

/** Board names and Pin titles offered to category inference. Bounded: a category is
 *  decided by what an account is mostly about, and the newest hundred rows say that
 *  as well as a thousand. */
export function inferenceTextsFrom(registry: ContentRegistryRow[], limit = 100): string[] {
  const boards = new Set<string>();
  const texts: string[] = [];
  for (const row of registry.slice(0, limit)) {
    if (row.title) texts.push(row.title);
    if (row.boardName) boards.add(row.boardName);
  }
  return [...boards, ...texts];
}

/**
 * The per-row line, from the same evidence the panel above the table shows.
 *
 * Rows with no numbers keep the four-way "why is this empty" wording (reconnect /
 * wait for the run / wait for Pinterest), which is a data-state answer, not a
 * comparison — the engine has nothing to say about a Pin nobody measured.
 */
export function attachEvidenceLines(
  rows: InsightsContent[],
  byPin: Map<string, Evidence[]>,
): InsightsContent[] {
  return rows.map(item => ({
    ...item,
    diagnosis: item.metricsAvailable === false
      ? missingMetricsDiagnosis(item)
      : describeContentRow(byPin.get(item.id)),
  }));
}

async function evidenceAndDiagnosis(
  sources: CollectionSources,
  rows: EvidenceContentRow[],
  inferenceTexts: string[],
  accountDaily: InsightsDay[],
): Promise<{ set: EvidenceSet; diagnosis: InsightsDiagnosis }> {
  const [observations, keywordSet] = await Promise.all([
    sources.loadObservationHistory(rows.map(row => row.pinId)).catch(() => [] as EvidenceObservation[]),
    sources.loadKeywordSet(inferenceTexts).catch(() => EMPTY_KEYWORD_SET_INPUT),
  ]);
  const set = buildEvidence({
    now: new Date(),
    accountDaily,
    content: rows,
    observations,
    keywordSet,
  });
  return { set, diagnosis: buildDiagnosis(set) };
}

// ── Messages (English; the page localizes the data-state line via `collection`) ──

const VIBEPIN_AVAILABILITY =
  "Shows every Pin with a confirmed VibePin publish record; drafts without one never appear here. "
  + "\"Went to site\" means someone left Pinterest — it does not prove the page finished loading.";

const ACCOUNT_AVAILABILITY =
  "Shows every Pin the nightly collection has registered for this account, including Pins published outside VibePin. "
  + "Account totals come from the Pinterest account report, not from adding up these rows.";

function accountOf(connection: InsightsConnectionRef): InsightsDashboard["account"] {
  return {
    id: connection.providerAccountId ?? connection.id,
    name: connection.providerAccountUsername
      ? `@${connection.providerAccountUsername}`
      : connection.providerAccountName ?? "Pinterest",
    username: connection.providerAccountUsername,
  };
}

function vibepinWarning(storageAvailable: boolean, total: number, missing: number): string | null {
  if (!storageAvailable) {
    return "VibePin publish records are temporarily unavailable. To avoid mixing in Pins we cannot verify, none are shown here.";
  }
  if (total === 0) {
    return "No VibePin content has a confirmed Pinterest publish record yet. Images without a publish record are never shown here.";
  }
  if (missing > 0) {
    return `${missing} of ${total} published VibePin Pins have no collected metrics yet. Those rows show — instead of a number.`;
  }
  return null;
}

// ── The read path ────────────────────────────────────────────────────────────

/**
 * Build the dashboard of one connection for one scope.
 *
 * Both scopes read the same population and produce the SAME per-connection
 * diagnosis. Flipping the toggle changes which Pins the table lists, not which
 * account the user owns, and a panel that changed its mind with the toggle would be
 * getting one of the two answers wrong. What the scope still decides is cost: per-Pin
 * daily rows are read only for the scope whose heatmap needs them — the account
 * scope heatmap is the Pinterest account report, a different and better measurement
 * than summing Pins.
 */
export type ConnectionEvidenceRead = {
  collection: InsightsCollectionState;
  registry: ContentRegistryRow[];
  /** Every VibePin publish record of the user, for the origin chips. */
  provenance: { pins: VibePinPublishedPinterestPin[]; storageAvailable: boolean };
  /** The publish records that belong to THIS connection. */
  published: VibePinPublishedPinterestPin[];
  publishedIds: string[];
  lookup: MetricLookup;
  values: LatestValueRow[];
  accountDaily: InsightsDay[];
  set: EvidenceSet;
  diagnosis: InsightsDiagnosis;
  /** Finish time of the newest completed collection run. */
  dataUpdatedAt: string | null;
};

/**
 * Everything both the dashboard and the report generator need from the ledger, read
 * once.
 *
 * Returns `null` when no collection run has ever FINISHED for this connection. The
 * dashboard answers that with a live sample; the report generator must answer it by
 * doing nothing, which is why the decision lives here as a null rather than inside
 * the dashboard fallback. A report hashed from a live sample would be a report whose
 * evidence cannot be re-derived tomorrow, which is the one thing a frozen report
 * exists to prevent.
 */
export async function readConnectionEvidence(
  input: {
    scope: InsightsScope;
    connection: InsightsConnectionRef;
    startDate: string;
    endDate: string;
  },
  sources: CollectionSources,
): Promise<ConnectionEvidenceRead | null> {
  const { scope, connection, startDate, endDate } = input;
  const finishedRun = await sources.loadLatestFinishedRun();
  if (!finishedRun) return null;

  const latestRun = await sources.loadLatestRun();
  const collection: InsightsCollectionState = {
    mode: "collected",
    dataUpdatedAt: finishedRun.finishedAt,
    skippedReason: latestRun?.skippedReason ?? null,
    sampleLimit: null,
  };

  const [accountRows, registry, provenance] = await Promise.all([
    sources.loadAccountMetrics(startDate, endDate),
    sources.loadRegistry(ACCOUNT_CONTENT_ROW_LIMIT),
    sources.loadProvenance().catch(() => ({ pins: [], storageAvailable: false })),
  ]);
  const published = await attributedPins(provenance.pins, connection.id, sources);
  const publishedIds = published.map(item => item.pinId);
  const registryIds = registry.map(row => row.platformContentId);

  // The rows of the selected scope carry daily observations (its heatmap needs them);
  // the other scope rows are read lifetime-only, because they are here to complete
  // the cohorts, and 200 Pins × 30 days × 6 metrics of daily rows would be tens of
  // thousands of rows fetched to be thrown away.
  const primaryIds = scope === "vibepin" ? publishedIds : registryIds;
  const primarySet = new Set(primaryIds);
  const secondaryIds = (scope === "vibepin" ? registryIds : publishedIds)
    .filter(id => !primarySet.has(id));
  const [primary, secondary] = await Promise.all([
    primaryIds.length > 0
      ? sources.loadContentMetrics(primaryIds, { startDate, endDate, includeDaily: scope === "vibepin" })
      : Promise.resolve(EMPTY_METRIC_ROWS),
    secondaryIds.length > 0
      ? sources.loadContentMetrics(secondaryIds, { startDate, endDate, includeDaily: false })
      : Promise.resolve(EMPTY_METRIC_ROWS),
  ]);
  const values = [...primary.values, ...secondary.values];
  const statuses = [...primary.statuses, ...secondary.statuses];
  const lookup = buildMetricLookup(values, statuses);

  const attributedByPin = new Map(published.map(pin => [pin.pinId, pin]));
  const accountDaily = daysFromValues(accountRows.values, { scope: "account", startDate, endDate });
  const { set, diagnosis } = await evidenceAndDiagnosis(
    sources,
    evidenceContentRows(registry, attributedByPin, lookup),
    inferenceTextsFrom(registry),
    accountDaily,
  );

  return {
    collection,
    registry,
    provenance,
    published,
    publishedIds,
    lookup,
    values,
    accountDaily,
    set,
    diagnosis,
    dataUpdatedAt: finishedRun.finishedAt,
  };
}

export async function buildPinterestInsights(
  input: {
    scope: InsightsScope;
    connection: InsightsConnectionRef;
    startDate: string;
    endDate: string;
  },
  sources: CollectionSources,
): Promise<InsightsDashboard> {
  const { scope, connection, startDate, endDate } = input;
  const read = await readConnectionEvidence(input, sources);
  if (!read) return buildFallbackDashboard(input, sources);

  const {
    collection, registry, provenance, published, publishedIds,
    lookup, values, accountDaily, set, diagnosis,
  } = read;
  const provenanceByPin = new Map(provenance.pins.map(pin => [pin.pinId, pin]));

  if (scope === "account") {
    const rows = accountContentRows(registry, lookup, provenanceByPin);
    return {
      platform: "pinterest",
      scope,
      connectionState: "ready",
      account: accountOf(connection),
      range: { startDate, endDate, days: 30 },
      summary: summarizeDays(accountDaily, true),
      daily: accountDaily,
      content: attachEvidenceLines(rows, set.byPin),
      availability: { views: "pin_level", websiteClicks: "pin_level", message: ACCOUNT_AVAILABILITY },
      collection,
      diagnosis,
      latestAvailableAt: read.dataUpdatedAt,
      syncedAt: new Date().toISOString(),
      warning: registry.length === 0
        ? "No Pins are registered for this account yet. They appear after the next collection run."
        : null,
    };
  }

  const rows = vibepinContentRows(published, lookup);
  const daily = daysFromValues(values, {
    scope: "content",
    pinIds: new Set(publishedIds),
    startDate,
    endDate,
  });
  const missing = rows.filter(item => item.metricsAvailable === false).length;

  return {
    platform: "pinterest",
    scope,
    connectionState: "ready",
    account: accountOf(connection),
    range: { startDate, endDate, days: 30 },
    summary: summarizeContent(rows),
    daily,
    content: attachEvidenceLines(rows, set.byPin),
    availability: { views: "pin_level", websiteClicks: "pin_level", message: VIBEPIN_AVAILABILITY },
    collection,
    diagnosis,
    latestAvailableAt: read.dataUpdatedAt,
    syncedAt: new Date().toISOString(),
    warning: vibepinWarning(provenance.storageAvailable, rows.length, missing),
  };
}

/** Evidence rows from a live sample: the same shape, filled from what Pinterest
 *  answered a moment ago rather than from the ledger. Cohorts of at most 20 mean
 *  almost everything comes back `insufficient` — the honest reading of a sample. */
function liveEvidenceRows(
  pins: VibePinPublishedPinterestPin[],
  slices: Map<string, LiveAnalyticsSlice | null>,
): EvidenceContentRow[] {
  return pins.map((record): EvidenceContentRow => {
    const slice = slices.get(record.pinId) ?? null;
    const metrics = summarizeSlice(slice);
    const read = (name: EvidenceMetricName): number | null => {
      if (slice === null) return null;
      const value = metrics[name];
      return value === undefined || value === null ? null : finiteMetric(value);
    };
    return {
      pinId: record.pinId,
      title: record.title,
      description: null,
      linkUrl: null,
      publishedAt: record.publishedAt,
      format: contentFormat(record.mediaType),
      origin: "vibepin",
      lifetime: {
        IMPRESSION: read("IMPRESSION"),
        SAVE: read("SAVE"),
        PIN_CLICK: read("PIN_CLICK"),
        OUTBOUND_CLICK: read("OUTBOUND_CLICK"),
      },
    };
  });
}

/**
 * The state before the first finished collection run.
 *
 * The account scope has no honest live equivalent — it would need a full Pin scan
 * plus an analytics call per Pin, which is precisely the spend the collector exists
 * to move off the request path — so it shows nothing, says why, and carries no
 * diagnosis: an evidence panel over zero rows would be a headline about nothing. The
 * VibePin scope reads a bounded sample so a user who connected an account today is
 * not told they have no data, and the engine runs over that sample with the cohort
 * sizes it really has.
 */
async function buildFallbackDashboard(
  input: {
    scope: InsightsScope;
    connection: InsightsConnectionRef;
    startDate: string;
    endDate: string;
  },
  sources: CollectionSources,
): Promise<InsightsDashboard> {
  const { scope, connection, startDate, endDate } = input;
  const latestRun = await sources.loadLatestRun();

  if (scope === "account") {
    return {
      platform: "pinterest",
      scope,
      connectionState: "ready",
      account: accountOf(connection),
      range: { startDate, endDate, days: 30 },
      summary: emptyMetrics(0),
      daily: fillDailyRange([], startDate, endDate, true),
      content: [],
      availability: { views: "pin_level", websiteClicks: "pin_level", message: ACCOUNT_AVAILABILITY },
      collection: {
        mode: "awaiting_first_run",
        dataUpdatedAt: null,
        skippedReason: latestRun?.skippedReason ?? null,
        sampleLimit: null,
      },
      diagnosis: null,
      latestAvailableAt: null,
      syncedAt: new Date().toISOString(),
      warning: null,
    };
  }

  const provenance = await sources.loadProvenance();
  const published = await attributedPins(provenance.pins, connection.id, sources);
  // Sliced BEFORE the reader is called: the cap is the promise, so it cannot be left
  // to whatever the reader happens to do with a longer list.
  const sample = published.slice(0, PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT);
  const slices = sample.length > 0
    ? await sources.loadLiveAnalytics(sample.map(item => item.pinId))
    : new Map<string, LiveAnalyticsSlice | null>();
  const rows = liveContentRows(sample, slices);
  const daily = liveDays(slices, startDate, endDate);
  const missing = rows.filter(item => item.metricsAvailable === false).length;
  const { set, diagnosis } = await evidenceAndDiagnosis(
    sources,
    liveEvidenceRows(sample, slices),
    [],
    daily,
  );

  return {
    platform: "pinterest",
    scope,
    connectionState: "ready",
    account: accountOf(connection),
    range: { startDate, endDate, days: 30 },
    summary: summarizeContent(rows),
    daily,
    content: attachEvidenceLines(rows, set.byPin),
    availability: { views: "pin_level", websiteClicks: "pin_level", message: VIBEPIN_AVAILABILITY },
    collection: {
      mode: "live_sample",
      dataUpdatedAt: null,
      skippedReason: latestRun?.skippedReason ?? null,
      sampleLimit: PIN_SINGLE_ANALYTICS_FALLBACK_LIMIT,
    },
    diagnosis,
    latestAvailableAt: null,
    syncedAt: new Date().toISOString(),
    warning: vibepinWarning(provenance.storageAvailable, rows.length, missing),
  };
}
