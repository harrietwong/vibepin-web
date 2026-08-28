/**
 * The evidence engine: collected rows in, named observations out.
 *
 * ── What this module is allowed to say ───────────────────────────────────────
 * Every rule here names something we MEASURED. None of them names a cause. That is
 * not a stylistic preference, it is the difference between a tool that helps and one
 * that misleads: we can see that a Pin was seen less than the middle Pin of its
 * group, and we cannot see why — Pinterest does not tell us, and the plausible
 * explanations (the image, the timing, the board, the season, the competition, the
 * distribution itself) are indistinguishable from the outside. A sentence like "this
 * Pin was suppressed" would be a story the data cannot support, and the user would
 * act on it. So evidence ids are descriptions (`impressions_below_cohort_median`),
 * never diagnoses, and the i18n templates are scanned by a test for the vocabulary
 * of causation.
 *
 * ── Cohorts, and the age problem the data actually has ───────────────────────
 * Comparing a Pin published yesterday with one published in March is not a
 * comparison; Pinterest impressions accumulate for months. So every comparison is
 * inside a cohort of the same connection, the same format, and the same age band.
 *
 * The honest complication: age-BANDED is not age-PINNED. A value measured "at day 7"
 * only exists for Pins the collector watched through day 7 — that is, Pins published
 * after this feature deploys. Every Pin this user has today has exactly one kind of
 * number: lifetime-to-date, read whenever we last asked. Two responses were possible.
 * Emit nothing until the age-pinned data exists (correct, and useless for a year), or
 * compare lifetime values inside a current-age band and say so. This engine does the
 * second: the band comes from `published_at` at evaluation time, the value is the
 * latest lifetime value, and `ageBasis` travels with the result so the caveat line
 * can state which kind of comparison the user is looking at. Where a real age-pinned
 * observation exists (windows identical to `pin_task`: [T+1,T+3), [T+7,T+10),
 * [T+30,T+37)) it is used instead, and C5 — growth from day 1 to day 7 — is
 * `insufficient` unless BOTH pinned observations exist, because it is the one number
 * that cannot be approximated from a lifetime total.
 *
 * ── Confidence is about the cohort, not the pin ──────────────────────────────
 * A percentile inside a 4-Pin cohort is arithmetic, not evidence. Tiers are keyed to
 * the number of comparable Pins: under 5 nothing comparative is asserted, 5–19 gives
 * direction only (above/below the middle Pin), 20+ exposes percentiles. The tier
 * governs what the templates may print, so a rule cannot leak a number that its
 * sample does not support.
 */

import { REDIRECT_DOMAINS, REDIRECT_DOMAINS_VERSION } from "./redirectDomains";
import { findPhrase } from "./phraseMatch";
import type { InsightsDay } from "./types";

/** Bump when a rule's definition changes (what is observed). */
export const RULE_VERSION = "insights-rules-1";
/** Bump when a number changes (a percentile cut, a window, a tier boundary). */
export const THRESHOLD_VERSION = "insights-thresholds-1";

export { REDIRECT_DOMAINS, REDIRECT_DOMAINS_VERSION };

/** Rows per cohort used for percentiles, newest first. Older Pins were measured
 *  against a different Pinterest and a different catalogue. */
export const COHORT_ROW_LIMIT = 300;
/** Window for the content-shape observations (A1, A3). */
export const CONTENT_WINDOW_DAYS = 90;
/** Window for publish cadence (A2). */
export const CADENCE_WINDOW_DAYS = 30;

/** Comparable Pins needed before direction may be stated. */
export const DIRECTIONAL_MIN_N = 5;
/** Comparable Pins needed before percentiles may be printed. */
export const QUANTIFIED_MIN_N = 20;

/** Percentile cuts. Named so a report can cite them. */
export const LOW_PERCENTILE = 25;
export const NORMAL_PERCENTILE = 40;

export type EvidenceKind =
  | "A1" | "A2" | "A3" | "A5"
  | "F1" | "F2" | "F3"
  | "C1" | "C2" | "C3" | "C4" | "C5";

export type EvidenceConfidence = "insufficient" | "directional" | "quantified";

export type AgeBucket = "t1" | "t7" | "t30" | "mature" | "unknown";
export type AgeBasis = "age_pinned" | "lifetime" | "mixed";

export type EvidenceDetails = Record<string, string | number | boolean | null>;

export type Evidence = {
  /** Stable within one evidence set: the kind for account-level rows, `kind:pinId`
   *  for per-Pin rows. Recommendations cite these, so they must not be positional. */
  id: string;
  kind: EvidenceKind;
  value: number | null;
  baseline: number | null;
  /** Rows the observation was computed over (cohort size, or window size for A-kinds). */
  n: number;
  /** Of those, the ones carrying a usable value — what confidence is keyed to. */
  eligible_n: number;
  /** All content rows this connection had, so `n` can be read in proportion. */
  total_n: number;
  confidence: EvidenceConfidence;
  details: EvidenceDetails;
};

export type EvidenceMetricName = "IMPRESSION" | "SAVE" | "PIN_CLICK" | "OUTBOUND_CLICK";

export type EvidenceObservation = {
  pinId: string;
  metricName: string;
  metricValue: number;
  observedAt: string;
};

export type EvidenceContentRow = {
  pinId: string;
  title: string | null;
  description: string | null;
  linkUrl: string | null;
  publishedAt: string | null;
  format: "image" | "carousel" | "video" | "unknown";
  origin: "vibepin" | "pinterest";
  /** Latest LIFETIME value per metric; null means "not observed", never zero. */
  lifetime: Partial<Record<EvidenceMetricName, number | null>>;
};

export type EvidenceKeywordSet = {
  phrases: string[];
  category: string | null;
  version: number | null;
  hash: string;
};

export type EvidenceInput = {
  now: Date;
  /** Account-level daily rows for the visible window. Used for the sample-size
   *  statement — how many days actually carry a measurement — not for comparisons. */
  accountDaily: InsightsDay[];
  content: EvidenceContentRow[];
  /** Raw lifetime observation history, when the ledger is readable. The ONLY source
   *  of age-pinned values: `metric_latest_value` keeps one row per key, so a Pin's
   *  day-1 and day-7 readings are indistinguishable there. */
  observations?: EvidenceObservation[];
  keywordSet: EvidenceKeywordSet;
};

export type EvidenceSet = {
  ruleVersion: string;
  thresholdVersion: string;
  keywordSetVersion: number | null;
  keywordSetHash: string;
  category: string | null;
  /** Account-level observations: A-kinds always, F-kinds aggregated over cohorts. */
  account: Evidence[];
  /** Per-Pin observations, keyed by Pin id. The content table's line is a projection
   *  of exactly these, which is what keeps the table and the panel from disagreeing. */
  byPin: Map<string, Evidence[]>;
  sample: {
    totalPins: number;
    comparablePins: number;
    cohorts: number;
    ageBasis: AgeBasis;
    observedDays: number;
  };
};

// ── Small arithmetic, kept explicit ──────────────────────────────────────────

export function tierFor(eligibleN: number): EvidenceConfidence {
  if (eligibleN >= QUANTIFIED_MIN_N) return "quantified";
  if (eligibleN >= DIRECTIONAL_MIN_N) return "directional";
  return "insufficient";
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Mid-rank percentile: strictly-below plus half the ties.
 *
 * The half-ties term is what makes a cohort where every Pin has 0 outbound clicks
 * report 50 for all of them rather than 0 for all of them — "below everyone" is the
 * wrong reading of "identical to everyone", and it is the reading that would flag
 * every Pin of a brand-new account as underperforming. n=1 lands on 50 for the same
 * reason: a Pin compared with itself is neither above nor below.
 */
export function percentileRank(values: readonly number[], value: number): number | null {
  if (values.length === 0) return null;
  let below = 0;
  let ties = 0;
  for (const candidate of values) {
    if (candidate < value) below += 1;
    else if (candidate === value) ties += 1;
  }
  return ((below + ties / 2) / values.length) * 100;
}

export function ageDaysOf(publishedAt: string | null, now: Date): number | null {
  if (!publishedAt) return null;
  const published = new Date(publishedAt).getTime();
  if (!Number.isFinite(published)) return null;
  return (now.getTime() - published) / 86_400_000;
}

/** Current age band. Same boundaries as the `pin_task` windows, so a band and a
 *  pinned observation of the same name describe the same moment in a Pin's life. */
export function ageBucketOf(publishedAt: string | null, now: Date): AgeBucket {
  const age = ageDaysOf(publishedAt, now);
  if (age === null) return "unknown";
  if (age < 3) return "t1";
  if (age < 10) return "t7";
  if (age < 37) return "t30";
  return "mature";
}

/** Which measurement window an observation of a Pin published at `publishedAt` falls
 *  in, or null when it is between windows (a value nobody can call day-7). */
export function observationWindow(publishedAt: string | null, observedAt: string): AgeBucket | null {
  if (!publishedAt) return null;
  const published = new Date(publishedAt).getTime();
  const observed = new Date(observedAt).getTime();
  if (!Number.isFinite(published) || !Number.isFinite(observed)) return null;
  const age = (observed - published) / 86_400_000;
  if (age >= 1 && age < 3) return "t1";
  if (age >= 7 && age < 10) return "t7";
  if (age >= 30 && age < 37) return "t30";
  return null;
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export function isRedirectHost(url: string | null): boolean {
  const host = hostOf(url);
  return host !== null && REDIRECT_DOMAINS.includes(host);
}

// ── Per-Pin derived numbers ──────────────────────────────────────────────────

type PinnedValues = Partial<Record<AgeBucket, Partial<Record<string, { value: number; observedAt: string }>>>>;

type PinFacts = {
  row: EvidenceContentRow;
  bucket: AgeBucket;
  cohortKey: string;
  basis: "age_pinned" | "lifetime";
  impressions: number | null;
  saves: number | null;
  pinClicks: number | null;
  outbound: number | null;
  saveRate: number | null;
  outboundRate: number | null;
  clickToOutbound: number | null;
  /** IMPRESSION at day 1 and day 7, when both were really observed. */
  t1Impressions: number | null;
  t7Impressions: number | null;
};

function indexObservations(
  content: readonly EvidenceContentRow[],
  observations: readonly EvidenceObservation[],
): Map<string, PinnedValues> {
  const publishedByPin = new Map(content.map(row => [row.pinId, row.publishedAt]));
  const byPin = new Map<string, PinnedValues>();
  for (const observation of observations) {
    const publishedAt = publishedByPin.get(observation.pinId) ?? null;
    const window = observationWindow(publishedAt, observation.observedAt);
    if (!window) continue;
    if (!Number.isFinite(observation.metricValue)) continue;
    const pin = byPin.get(observation.pinId) ?? {};
    const bucket = pin[window] ?? {};
    const existing = bucket[observation.metricName];
    // Latest observation inside the window wins: Pinterest revises figures for about
    // three days, and the last reading in the window is the settled one.
    if (!existing || observation.observedAt > existing.observedAt) {
      bucket[observation.metricName] = { value: observation.metricValue, observedAt: observation.observedAt };
    }
    pin[window] = bucket;
    byPin.set(observation.pinId, pin);
  }
  return byPin;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function pinFactsOf(
  row: EvidenceContentRow,
  now: Date,
  pinned: PinnedValues | undefined,
): PinFacts {
  const bucket = ageBucketOf(row.publishedAt, now);
  const atBucket = pinned?.[bucket] ?? {};
  let usedPinned = false;
  const read = (name: EvidenceMetricName): number | null => {
    const pinnedValue = atBucket[name];
    if (pinnedValue) {
      usedPinned = true;
      return pinnedValue.value;
    }
    const lifetime = row.lifetime[name];
    return lifetime === undefined ? null : lifetime;
  };
  const impressions = read("IMPRESSION");
  const saves = read("SAVE");
  const pinClicks = read("PIN_CLICK");
  const outbound = read("OUTBOUND_CLICK");
  const t1 = pinned?.t1?.IMPRESSION?.value ?? null;
  const t7 = pinned?.t7?.IMPRESSION?.value ?? null;

  return {
    row,
    bucket,
    cohortKey: `${row.format}|${bucket}`,
    basis: usedPinned ? "age_pinned" : "lifetime",
    impressions,
    saves,
    pinClicks,
    outbound,
    saveRate: ratio(saves, impressions),
    outboundRate: ratio(outbound, impressions),
    clickToOutbound: ratio(outbound, pinClicks),
    t1Impressions: t1,
    t7Impressions: t7,
  };
}

type CohortMetric = "impressions" | "saveRate" | "outboundRate" | "outbound" | "clickToOutbound";

const COHORT_METRICS: CohortMetric[] = ["impressions", "saveRate", "outboundRate", "outbound", "clickToOutbound"];

function metricOf(facts: PinFacts, metric: CohortMetric): number | null {
  switch (metric) {
    case "impressions": return facts.impressions;
    case "saveRate": return facts.saveRate;
    case "outboundRate": return facts.outboundRate;
    case "outbound": return facts.outbound;
    case "clickToOutbound": return facts.clickToOutbound;
  }
}

type Cohort = {
  key: string;
  format: string;
  bucket: AgeBucket;
  members: PinFacts[];
  values: Record<CohortMetric, number[]>;
  eligible: Record<CohortMetric, number>;
  medians: Record<CohortMetric, number | null>;
  tiers: Record<CohortMetric, EvidenceConfidence>;
};

function buildCohorts(facts: readonly PinFacts[]): Map<string, Cohort> {
  const grouped = new Map<string, PinFacts[]>();
  for (const item of facts) {
    const list = grouped.get(item.cohortKey) ?? [];
    list.push(item);
    grouped.set(item.cohortKey, list);
  }

  const cohorts = new Map<string, Cohort>();
  for (const [key, list] of grouped) {
    // Newest first, then capped: when a cohort exceeds the limit the Pins that fall
    // out are the oldest, which is the end whose comparison value has decayed most.
    const members = [...list]
      .sort((a, b) => (b.row.publishedAt ?? "").localeCompare(a.row.publishedAt ?? ""))
      .slice(0, COHORT_ROW_LIMIT);
    const values = {} as Record<CohortMetric, number[]>;
    const eligible = {} as Record<CohortMetric, number>;
    const medians = {} as Record<CohortMetric, number | null>;
    const tiers = {} as Record<CohortMetric, EvidenceConfidence>;
    for (const metric of COHORT_METRICS) {
      const collected = members
        .map(member => metricOf(member, metric))
        .filter((value): value is number => value !== null && Number.isFinite(value));
      values[metric] = collected;
      eligible[metric] = collected.length;
      medians[metric] = median(collected);
      tiers[metric] = tierFor(collected.length);
    }
    const [format, bucket] = key.split("|");
    cohorts.set(key, { key, format, bucket: bucket as AgeBucket, members, values, eligible, medians, tiers });
  }
  return cohorts;
}

function direction(value: number, baseline: number | null): "above" | "below" | "at" {
  if (baseline === null) return "at";
  if (value > baseline) return "above";
  if (value < baseline) return "below";
  return "at";
}

/** Details a tier is allowed to carry. Percentiles only at `quantified`; at
 *  `directional` the direction alone; at `insufficient` nothing numeric. */
function comparisonDetails(
  confidence: EvidenceConfidence,
  percentile: number | null,
  value: number,
  baseline: number | null,
  extra: EvidenceDetails = {},
): EvidenceDetails {
  if (confidence === "insufficient") return { ...extra };
  if (confidence === "directional") {
    return { ...extra, direction: direction(value, baseline) };
  }
  return {
    ...extra,
    direction: direction(value, baseline),
    percentile: percentile === null ? null : Math.round(percentile),
  };
}

// ── Account-level observations (A-kinds) ─────────────────────────────────────

function withinDays(publishedAt: string | null, now: Date, days: number): boolean {
  const age = ageDaysOf(publishedAt, now);
  return age !== null && age >= 0 && age <= days;
}

function buildA1(
  content: readonly EvidenceContentRow[],
  keywordSet: EvidenceKeywordSet,
  now: Date,
  totalN: number,
): Evidence {
  const window = content.filter(row => withinDays(row.publishedAt, now, CONTENT_WINDOW_DAYS)
    && ((row.title ?? "").trim() !== "" || (row.description ?? "").trim() !== ""));
  let without = 0;
  for (const row of window) {
    const text = `${row.title ?? ""} ${row.description ?? ""}`;
    if (!findPhrase(text, keywordSet.phrases)) without += 1;
  }
  const eligible = keywordSet.phrases.length > 0 ? window.length : 0;
  const value = eligible > 0 ? without / eligible : null;
  return {
    id: "A1",
    kind: "A1",
    value: value === null ? null : Math.round(value * 1000) / 1000,
    baseline: null,
    n: window.length,
    eligible_n: eligible,
    total_n: totalN,
    confidence: tierFor(eligible),
    details: {
      metric: "title_desc_without_phrase_ratio",
      windowDays: CONTENT_WINDOW_DAYS,
      without,
      checked: eligible,
      percent: value === null ? null : Math.round(value * 100),
      phraseCount: keywordSet.phrases.length,
      category: keywordSet.category,
    },
  };
}

function buildA2(content: readonly EvidenceContentRow[], now: Date, totalN: number): Evidence {
  const window = content.filter(row => withinDays(row.publishedAt, now, CADENCE_WINDOW_DAYS));
  const perDay = new Map<string, number>();
  for (const row of window) {
    const day = (row.publishedAt ?? "").slice(0, 10);
    if (!day) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const activeDays = perDay.size;
  const maxPerDay = perDay.size === 0 ? 0 : Math.max(...perDay.values());
  const perDayMean = window.length / CADENCE_WINDOW_DAYS;
  return {
    id: "A2",
    kind: "A2",
    value: activeDays,
    baseline: null,
    n: window.length,
    eligible_n: window.length,
    total_n: totalN,
    confidence: tierFor(window.length),
    details: {
      metric: "publish_cadence",
      windowDays: CADENCE_WINDOW_DAYS,
      activeDays,
      published: window.length,
      perDayMean: Math.round(perDayMean * 100) / 100,
      maxPerDay,
    },
  };
}

function buildA3(content: readonly EvidenceContentRow[], now: Date, totalN: number): Evidence {
  const window = content.filter(row => withinDays(row.publishedAt, now, CONTENT_WINDOW_DAYS)
    && (row.linkUrl ?? "").trim() !== "");
  const matched = window.filter(row => isRedirectHost(row.linkUrl)).length;
  const value = window.length > 0 ? matched / window.length : null;
  return {
    id: "A3",
    kind: "A3",
    value: value === null ? null : Math.round(value * 1000) / 1000,
    baseline: null,
    n: window.length,
    eligible_n: window.length,
    total_n: totalN,
    confidence: tierFor(window.length),
    details: {
      metric: "link_redirect_domain_ratio",
      windowDays: CONTENT_WINDOW_DAYS,
      matched,
      withLink: window.length,
      percent: value === null ? null : Math.round(value * 100),
      listVersion: REDIRECT_DOMAINS_VERSION,
    },
  };
}

function buildA5(
  totalN: number,
  comparable: number,
  cohorts: number,
  ageBasis: AgeBasis,
  observedDays: number,
): Evidence {
  return {
    id: "A5",
    kind: "A5",
    value: totalN,
    baseline: null,
    n: totalN,
    eligible_n: comparable,
    total_n: totalN,
    // The sample-size statement is a census of what we hold; it is never withheld,
    // because it is precisely the line that explains why other things are withheld.
    confidence: "quantified",
    details: {
      metric: "sample_size",
      pins: totalN,
      comparable,
      cohorts,
      ageBasis,
      observedDays,
    },
  };
}

// ── Findings (F-kinds) ───────────────────────────────────────────────────────

type Flag = { pin: PinFacts; cohort: Cohort; confidence: EvidenceConfidence };

function aggregateFinding(
  kind: "F1" | "F2" | "F3",
  metric: string,
  flags: Flag[],
  eligiblePins: number,
  cohorts: Map<string, Cohort>,
  drivingMetric: CohortMetric,
  totalN: number,
  extra: EvidenceDetails = {},
): Evidence {
  // The aggregate is only as strong as its WEAKEST contributing cohort: five cohorts
  // of four Pins are not a sample of twenty, and adding them up would print
  // percentile-grade language over percentile-grade nonsense.
  const contributing = flags.filter(flag => flag.confidence !== "insufficient");
  const weakest = contributing.length > 0
    ? Math.min(...contributing.map(flag => flag.cohort.eligible[drivingMetric]))
    : Math.max(0, ...[...cohorts.values()].map(cohort => cohort.eligible[drivingMetric]));
  const confidence = tierFor(weakest);
  const matched = contributing.length;
  return {
    id: kind,
    kind,
    value: eligiblePins > 0 ? Math.round((matched / eligiblePins) * 1000) / 1000 : null,
    baseline: null,
    n: eligiblePins,
    eligible_n: weakest,
    total_n: totalN,
    confidence: matched === 0 ? "insufficient" : confidence,
    details: {
      metric,
      matched,
      comparable: eligiblePins,
      ...(confidence === "quantified" ? { cohortMin: weakest } : {}),
      ...extra,
    },
  };
}

// ── The engine ───────────────────────────────────────────────────────────────

export function buildEvidence(input: EvidenceInput): EvidenceSet {
  const { now, content, keywordSet } = input;
  const totalN = content.length;
  const pinnedByPin = indexObservations(content, input.observations ?? []);
  const facts = content.map(row => pinFactsOf(row, now, pinnedByPin.get(row.pinId)));
  const cohorts = buildCohorts(facts);
  const cohortOf = (item: PinFacts) => cohorts.get(item.cohortKey)!;

  const byPin = new Map<string, Evidence[]>();
  const f1Flags: Flag[] = [];
  const f2Flags: Flag[] = [];
  const f3Flags: Flag[] = [];
  let impressionEligible = 0;
  let outboundRateEligible = 0;
  let outboundEligible = 0;
  let comparable = 0;
  let anyPinned = false;
  let anyLifetime = false;

  for (const item of facts) {
    const cohort = cohortOf(item);
    const rows: Evidence[] = [];
    const hasAny = [item.impressions, item.saves, item.pinClicks, item.outbound]
      .some(value => value !== null);
    if (hasAny) comparable += 1;
    if (item.basis === "age_pinned") anyPinned = true;
    else if (hasAny) anyLifetime = true;

    const emitComparison = (
      kind: "C1" | "C2" | "C3" | "C4",
      metric: CohortMetric,
      metricName: string,
      value: number | null,
    ): { percentile: number | null; confidence: EvidenceConfidence } => {
      const confidence = cohort.tiers[metric];
      if (value === null) {
        rows.push({
          id: `${kind}:${item.row.pinId}`,
          kind,
          value: null,
          baseline: null,
          n: cohort.members.length,
          eligible_n: cohort.eligible[metric],
          total_n: totalN,
          confidence: "insufficient",
          details: { metric: metricName, pinId: item.row.pinId, bucket: item.bucket, basis: item.basis },
        });
        return { percentile: null, confidence: "insufficient" };
      }
      const percentile = percentileRank(cohort.values[metric], value);
      const baseline = cohort.medians[metric];
      rows.push({
        id: `${kind}:${item.row.pinId}`,
        kind,
        value: confidence === "insufficient" ? null : Math.round(value * 100) / 100,
        baseline: confidence === "quantified" && baseline !== null ? Math.round(baseline * 100) / 100 : null,
        n: cohort.members.length,
        eligible_n: cohort.eligible[metric],
        total_n: totalN,
        confidence,
        details: comparisonDetails(confidence, percentile, value, baseline, {
          metric: metricName,
          pinId: item.row.pinId,
          bucket: item.bucket,
          basis: item.basis,
        }),
      });
      return { percentile, confidence };
    };

    emitComparison("C1", "saveRate", "save_rate_pct", item.saveRate);
    const c2 = emitComparison("C2", "outboundRate", "outbound_click_rate_pct", item.outboundRate);
    const c3 = emitComparison("C3", "impressions", "impressions_pct", item.impressions);
    emitComparison("C4", "clickToOutbound", "pin_click_to_outbound_ratio_pct", item.clickToOutbound);

    // C5 — the only rule that REQUIRES age-pinned data, and says so when it lacks it.
    const growth = item.t1Impressions !== null && item.t7Impressions !== null && item.t1Impressions > 0
      ? ((item.t7Impressions - item.t1Impressions) / item.t1Impressions) * 100
      : null;
    rows.push({
      id: `C5:${item.row.pinId}`,
      kind: "C5",
      value: growth === null ? null : Math.round(growth * 10) / 10,
      baseline: null,
      n: cohort.members.length,
      eligible_n: growth === null ? 0 : 1,
      total_n: totalN,
      confidence: growth === null ? "insufficient" : "quantified",
      details: {
        metric: "t1_t7_growth_pct",
        pinId: item.row.pinId,
        basis: growth === null ? "unavailable" : "age_pinned",
        t1: item.t1Impressions,
        t7: item.t7Impressions,
      },
    });

    const outboundPercentile = item.outbound === null
      ? null
      : percentileRank(cohort.values.outbound, item.outbound);

    if (item.impressions !== null) impressionEligible += 1;
    if (item.outboundRate !== null) outboundRateEligible += 1;
    if (item.outbound !== null) outboundEligible += 1;

    // F1 — seen less than the middle Pin of its cohort.
    if (c3.percentile !== null && c3.percentile < LOW_PERCENTILE) {
      f1Flags.push({ pin: item, cohort, confidence: cohort.tiers.impressions });
      rows.push({
        id: `F1:${item.row.pinId}`,
        kind: "F1",
        value: null,
        baseline: null,
        n: cohort.members.length,
        eligible_n: cohort.eligible.impressions,
        total_n: totalN,
        confidence: cohort.tiers.impressions,
        details: { metric: "impressions_below_cohort_median", pinId: item.row.pinId, bucket: item.bucket, basis: item.basis },
      });
    }
    // F2 — seen normally, but fewer of those people left for the site.
    if (c3.percentile !== null && c3.percentile >= NORMAL_PERCENTILE
      && c2.percentile !== null && c2.percentile < LOW_PERCENTILE) {
      const confidence = tierFor(Math.min(cohort.eligible.impressions, cohort.eligible.outboundRate));
      f2Flags.push({ pin: item, cohort, confidence });
      rows.push({
        id: `F2:${item.row.pinId}`,
        kind: "F2",
        value: null,
        baseline: null,
        n: cohort.members.length,
        eligible_n: Math.min(cohort.eligible.impressions, cohort.eligible.outboundRate),
        total_n: totalN,
        confidence,
        details: {
          metric: "outbound_rate_below_cohort_median_with_normal_impressions",
          pinId: item.row.pinId,
          bucket: item.bucket,
          basis: item.basis,
        },
      });
    }
    // F3 — people did leave for the site; what happened next is not observable here.
    if (outboundPercentile !== null && outboundPercentile >= NORMAL_PERCENTILE && (item.outbound ?? 0) > 0) {
      f3Flags.push({ pin: item, cohort, confidence: cohort.tiers.outbound });
      rows.push({
        id: `F3:${item.row.pinId}`,
        kind: "F3",
        value: item.outbound,
        baseline: null,
        n: cohort.members.length,
        eligible_n: cohort.eligible.outbound,
        total_n: totalN,
        confidence: cohort.tiers.outbound,
        details: { metric: "clicks_present_conversion_unobserved", pinId: item.row.pinId, bucket: item.bucket, basis: item.basis },
      });
    }

    byPin.set(item.row.pinId, rows);
  }

  const ageBasis: AgeBasis = anyPinned && anyLifetime ? "mixed" : anyPinned ? "age_pinned" : "lifetime";
  const observedDays = input.accountDaily.filter(day => day.views > 0
    || day.interactions > 0
    || (day.websiteClicks ?? 0) > 0).length;

  const account: Evidence[] = [
    buildA1(content, keywordSet, now, totalN),
    buildA2(content, now, totalN),
    buildA3(content, now, totalN),
    aggregateFinding("F1", "impressions_below_cohort_median", f1Flags, impressionEligible, cohorts, "impressions", totalN,
      { threshold: LOW_PERCENTILE }),
    aggregateFinding("F2", "outbound_rate_below_cohort_median_with_normal_impressions", f2Flags, outboundRateEligible, cohorts, "outboundRate", totalN,
      { threshold: LOW_PERCENTILE }),
    aggregateFinding("F3", "clicks_present_conversion_unobserved", f3Flags, outboundEligible, cohorts, "outbound", totalN,
      { threshold: NORMAL_PERCENTILE }),
    buildA5(totalN, comparable, cohorts.size, ageBasis, observedDays),
  ];

  return {
    ruleVersion: RULE_VERSION,
    thresholdVersion: THRESHOLD_VERSION,
    keywordSetVersion: keywordSet.version,
    keywordSetHash: keywordSet.hash,
    category: keywordSet.category,
    account,
    byPin,
    sample: {
      totalPins: totalN,
      comparablePins: comparable,
      cohorts: cohorts.size,
      ageBasis,
      observedDays,
    },
  };
}
