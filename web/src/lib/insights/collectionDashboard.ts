/**
 * The Insights read path: turn v64 collection rows into a dashboard.
 *
 * Pure by construction — no Supabase client, no Pinterest client, no `server-only`
 * import. Everything it needs arrives through `CollectionSources`, a set of small
 * async readers supplied by `server/insights/dashboard.ts` in production and by an
 * in-memory fake in `scripts/test-insights-read.ts`.
 *
 * That split is what makes the central promise testable rather than asserted. The
 * promise is: **a page request makes no Pinterest API call — in every state**. Before
 * this module the dashboard called `getOrganicPinAnalytics` once per Pin while the
 * user waited, so every page view spent the account's rate-limit allowance on data we
 * already had a ledger for.
 *
 * ── No exceptions ────────────────────────────────────────────────────────────
 * There used to be one: a connection with no finished run read a bounded live sample
 * so it was not shown an empty page. That exception is gone, and with it the last
 * Pinterest reader in `CollectionSources`. The sample's calls sat outside every
 * budget the collector keeps — two accounts opening the page could spend ~40 of a
 * 60/min/user allowance nobody was counting — and it bought numbers the nightly run
 * would have written hours later anyway. "No API calls except when it matters most"
 * is not a contract; it is the shape of an outage waiting for a busy day.
 *
 * The state before the first run now says exactly that, and nothing else. Because no
 * reader here can reach Pinterest, the promise is now structural: a test's fetch spy
 * asserting zero calls cannot be defeated by a later edit that adds one back without
 * also adding a reader to this contract.
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
  InsightsPlatform,
  InsightsScope,
} from "./types";
import type { VibePinPublishedPinterestPin } from "@/lib/server/insights/publishProvenance";

/**
 * Pins read live when collection has never finished. Was 60 on the live-only path;
 * 20 here because this is a stopgap shown for at most one night, and 60 sequential
 * analytics calls is most of a connection's minute allowance spent on a page view.

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
  /** The Pin's image, captured by the collector when it listed the Pin. `null` renders
   *  a placeholder — the page never fetches one, which is the point of storing it. */
  imageUrl: string | null;
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
  /** Newest run WITH a finish time. The gate between "awaiting first run" and real
   *  data: a connection whose runs all crashed has nothing to show, and says so. */
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
  // NOTE: there is deliberately no Pinterest reader in this contract. Adding one is
  // how the zero-calls promise gets lost, so it has to be a visible decision here.
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
  /** Registry thumbnails by Pin id. The publish record's own image wins when it has
   *  one (it is ours, and cannot 404 when Pinterest rotates a CDN URL); the registry
   *  covers the Pins published before we started keeping the draft's image. */
  registryImages: Map<string, string | null> = new Map(),
): InsightsContent[] {
  return sortContent(pins.map((record): InsightsContent => {
    const read = contentMetricsFor(lookup, record.pinId);
    return {
      id: record.pinId,
      title: record.title || `VibePin Pin ${record.pinId.slice(-6)}`,
      imageUrl: record.imageUrl ?? registryImages.get(record.pinId) ?? null,
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
 * registry row, so it is evidence rather than inference.
 *
 * The thumbnail comes from the registry first — the collector stored what Pinterest
 * showed it while listing the Pin, which is the freshest thing anyone has — then from
 * the publish record, whose image is ours and cannot go stale but only exists for
 * Pins we published, and then from nothing at all. `null` renders a placeholder. The
 * page does not fetch a thumbnail in any of the three cases; that is the point of
 * keeping the column.
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
      imageUrl: row.imageUrl ?? published?.imageUrl ?? null,
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

export type PinAttribution = "mine" | "other_account" | "unknown";

/**
 * Which account does this Pin belong to, as far as anyone can tell?
 *
 * The recorded target of the draft wins — it is what the publish path actually did,
 * and no later observation is better evidence than the act itself. Failing that, the
 * registry owner: the account whose own token listed the Pin is the account that
 * holds it. Failing both, the answer is `unknown`, and `unknown` is deliberately not
 * a synonym for "mine".
 *
 * It used to be. A Pin neither source could place stayed visible on EVERY account
 * card, which for a two-account user meant the same Pin listed twice, and its metrics
 * present on one card and blank on the other — the account that really owns it is the
 * only one whose token can measure it. The blank copy is not a smaller version of the
 * truth; it is a row asserting that this account published something it never
 * published. So an unplaceable Pin now appears in exactly one place: the "not yet
 * attributed" group of the all-accounts view, which says what it is instead of
 * guessing whose it is. The registry's incremental pass runs daily, so the group
 * empties itself as ownership becomes knowable.
 */
export function attributePin(
  targetConnectionId: string | null,
  registryOwnerConnectionId: string | null,
  renderingConnectionId: string,
): PinAttribution {
  if (targetConnectionId) {
    return targetConnectionId === renderingConnectionId ? "mine" : "other_account";
  }
  if (registryOwnerConnectionId) {
    return registryOwnerConnectionId === renderingConnectionId ? "mine" : "other_account";
  }
  return "unknown";
}

export type AttributedPins = {
  /** Pins this connection published, per the draft record or the registry. */
  mine: VibePinPublishedPinterestPin[];
  /** Pins no source can place yet. The same set for every connection of one user,
   *  because it is derived from user-level provenance and the absence of a registry
   *  row — which is why the UI may show it once, and only outside the account cards. */
  unattributed: VibePinPublishedPinterestPin[];
};

async function attributedPins(
  pins: VibePinPublishedPinterestPin[],
  connectionId: string,
  sources: CollectionSources,
): Promise<AttributedPins> {
  const legacyPinIds = pins.filter(item => item.targetConnectionId === null).map(item => item.pinId);
  const owners = legacyPinIds.length > 0
    ? await sources.loadRegistryOwners(legacyPinIds).catch(() => new Map<string, string>())
    : new Map<string, string>();
  const mine: VibePinPublishedPinterestPin[] = [];
  const unattributed: VibePinPublishedPinterestPin[] = [];
  for (const item of pins) {
    const verdict = attributePin(item.targetConnectionId, owners.get(item.pinId) ?? null, connectionId);
    if (verdict === "mine") mine.push(item);
    else if (verdict === "unknown") unattributed.push(item);
  }
  return { mine, unattributed };
}

/**
 * The all-accounts "not yet attributed" group, from whichever account payloads have
 * arrived.
 *
 * Every connection of one user carries the SAME unattributed list — it is derived
 * from user-level publish provenance and the absence of a registry row, not from
 * anything account-specific — so the group must be deduped by Pin id rather than
 * taken from one payload. Taking the first would also make the group appear, grow and
 * re-order as the slower accounts finish loading.
 *
 * It lives here rather than in the page because it is the one rule in that merge
 * worth pinning down in a test, and the page is a client component the test harness
 * cannot import.
 */
export function dedupeUnattributedPins(
  dashboards: { platform: InsightsPlatform; unattributedContent?: InsightsContent[] }[],
): { item: InsightsContent; platform: InsightsPlatform }[] {
  const out: { item: InsightsContent; platform: InsightsPlatform }[] = [];
  const seen = new Set<string>();
  for (const dashboard of dashboards) {
    for (const item of dashboard.unattributedContent ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ item, platform: dashboard.platform });
    }
  }
  return out;
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
  /** Publish records no source can place on an account yet. Identical for every
   *  connection of one user, so the UI shows them once, outside the account cards. */
  unattributed: VibePinPublishedPinterestPin[];
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
  const { mine: published, unattributed } = await attributedPins(provenance.pins, connection.id, sources);
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
    unattributed,
    publishedIds,
    lookup,
    values,
    accountDaily,
    set,
    diagnosis,
    dataUpdatedAt: finishedRun.finishedAt,
  };
}

/**
 * The state before the first finished collection run.
 *
 * It shows nothing, and says why. There used to be a live fallback here that read up
 * to 20 single-Pin analytics so a freshly connected account was not told it had no
 * data — and it broke the one promise this module exists to make. Those calls were
 * outside every budget and ledger the collector maintains: two accounts opening the
 * page could issue ~40 analytics requests against a 60/min/user allowance nobody was
 * counting against, and they bought a number that the nightly run would replace hours
 * later anyway. A page that spends the user's rate limit to avoid an empty state has
 * chosen the wrong thing to protect.
 *
 * So both scopes return the same honest answer: no rows, `awaiting_first_run`, and
 * the reason the latest run gave if it already tried and stopped. No diagnosis — an
 * evidence panel over zero rows would be a headline about nothing.
 */
async function buildAwaitingFirstRunDashboard(
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

  return {
    platform: "pinterest",
    scope,
    connectionState: "ready",
    account: accountOf(connection),
    range: { startDate, endDate, days: 30 },
    summary: emptyMetrics(0),
    daily: fillDailyRange([], startDate, endDate, true),
    content: [],
    // Nothing has been collected, so nothing is known about ownership either. An
    // unattributed group here would be every VibePin Pin of the user, listed under a
    // heading that promises the registry will sort it out — before the registry exists.
    unattributedContent: [],
    availability: {
      views: "pin_level",
      websiteClicks: "pin_level",
      message: scope === "account" ? ACCOUNT_AVAILABILITY : VIBEPIN_AVAILABILITY,
    },
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
  if (!read) return buildAwaitingFirstRunDashboard(input, sources);

  const {
    collection, registry, provenance, published, unattributed, publishedIds,
    lookup, values, accountDaily, set, diagnosis,
  } = read;
  const provenanceByPin = new Map(provenance.pins.map(pin => [pin.pinId, pin]));
  const registryImages = new Map(registry.map(row => [row.platformContentId, row.imageUrl]));
  // Built once for both scopes. Their metrics read as "not collected", which is the
  // honest state: no account's token has measured a Pin no account has claimed.
  const unattributedRows = vibepinContentRows(unattributed, lookup, registryImages);

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
      unattributedContent: unattributedRows,
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

  const rows = vibepinContentRows(published, lookup, registryImages);
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
    unattributedContent: unattributedRows,
    availability: { views: "pin_level", websiteClicks: "pin_level", message: VIBEPIN_AVAILABILITY },
    collection,
    diagnosis,
    latestAvailableAt: read.dataUpdatedAt,
    syncedAt: new Date().toISOString(),
    warning: vibepinWarning(provenance.storageAvailable, rows.length, missing),
  };
}
