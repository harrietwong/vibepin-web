/**
 * Turning an evidence set into the thing that gets frozen: pure, no database, no
 * clock of its own.
 *
 * Every decision a report generator has to make is in this file, and each is a
 * function that can be tested with a date and an object rather than a database and a
 * cron run: which ISO week we are in, whether a Pin is due for a scorecard, what the
 * snapshot contains, what its hash is, and whether a regeneration should write
 * anything at all.
 *
 * The hash is the load-bearing piece. Reports are versioned, never updated, so
 * "has anything changed" has to be answerable cheaply and identically on every run —
 * otherwise a nightly job produces version 47 of a report whose sentences never
 * changed, and the version number stops meaning anything. `stableStringify` is what
 * makes the answer independent of key order, and `meta` is deliberately excluded so
 * a moving collection timestamp cannot masquerade as a changed reading.
 */

import { createHash } from "node:crypto";
import { RULE_VERSION, THRESHOLD_VERSION, type Evidence, type EvidenceSet } from "./evidence";
import { describeContentRow, sampleCaveat, type I18nText, type InsightsDiagnosis } from "./recommendations";
import {
  REPORT_SCHEMA_VERSION,
  type InsightReportKind,
  type InsightReportRecord,
  type InsightReportSnapshot,
  type ReportVersions,
  type ScorecardMetrics,
  type ScorecardReportContent,
  type WeeklyReportContent,
} from "./reportTypes";

const MS_PER_DAY = 86_400_000;

/**
 * The scorecard windows.
 *
 * T+7 opens at day 7 and closes at day 9 rather than firing exactly on day 7: the
 * cron runs once a day and a collection can be skipped for a night, so a one-day
 * window would silently drop Pins for reasons that have nothing to do with them.
 * T+30 gets a wider tail (36) because a month-old Pin's numbers move slowly enough
 * that six days of slack costs nothing, while a missed scorecard costs the whole
 * comparison the user was promised.
 */
export const SCORECARD_WINDOWS: Record<"scorecard_t7" | "scorecard_t30", {
  minDays: number;
  maxDays: number;
  periodKey: string;
}> = {
  scorecard_t7: { minDays: 7, maxDays: 9, periodKey: "T7" },
  scorecard_t30: { minDays: 30, maxDays: 36, periodKey: "T30" },
};

// ── ISO week ─────────────────────────────────────────────────────────────────

/**
 * `YYYY-Www` for the ISO-8601 week-year — which is NOT the calendar year.
 *
 * The week belongs to the year that owns its THURSDAY. That single rule produces
 * both of the cases a naive `getFullYear()` gets wrong: 2025-12-29 is a Monday whose
 * Thursday is 2026-01-01, so it is `2026-W01`, and 2027-01-01 is a Friday whose
 * Thursday is 2026-12-31, so it is `2026-W53`. Getting this wrong does not throw —
 * it silently files one report under a period_key nothing else uses, where it stays
 * forever as the week the user never received.
 *
 * UTC throughout: the generator runs in a cron with no user timezone, and a week
 * boundary that depended on the server's locale would move under the data.
 */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Monday = 1 … Sunday = 7 (JS gives Sunday 0).
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Move to the Thursday of this ISO week; its calendar year is the week-year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const weekYear = d.getUTCFullYear();
  const jan1 = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / MS_PER_DAY + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Weekly reports are generated on Mondays (UTC) — the week just ended is a complete
 * week, and a "weekly report" covering four days is a different product. `force`
 * exists for backfills and for the acceptance run; it is a caller's explicit
 * decision, never a default.
 */
export function isWeeklyDue(now: Date, force = false): boolean {
  return force || now.getUTCDay() === 1;
}

// ── Scorecard eligibility ────────────────────────────────────────────────────

/** Whole days between publication and `now`; null when the Pin has no publish date. */
export function ageInDays(publishedAt: string | null, now: Date): number | null {
  if (!publishedAt) return null;
  const at = new Date(publishedAt).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.floor((now.getTime() - at) / MS_PER_DAY);
}

/**
 * Which scorecard, if any, this Pin is due for right now.
 *
 * Age alone decides the window; whether there is anything to SAY is a separate
 * question answered by `hasScorecardMeasurement`, because "too young" and "nobody
 * measured it" are different facts and collapsing them would hide a broken collector
 * behind a perfectly normal-looking skip.
 */
export function scorecardDueKind(
  publishedAt: string | null,
  now: Date,
): "scorecard_t7" | "scorecard_t30" | null {
  const age = ageInDays(publishedAt, now);
  if (age === null) return null;
  const t7 = SCORECARD_WINDOWS.scorecard_t7;
  if (age >= t7.minDays && age <= t7.maxDays) return "scorecard_t7";
  const t30 = SCORECARD_WINDOWS.scorecard_t30;
  if (age >= t30.minDays && age <= t30.maxDays) return "scorecard_t30";
  return null;
}

/**
 * Is there a measurement to build a scorecard on?
 *
 * True when any of the four lifetime values exists. Zero counts: a Pin seen zero
 * times was measured and the answer was zero, which is a finding. `null` is the
 * absence of an observation, and only that blocks the scorecard.
 */
export function hasScorecardMeasurement(metrics: ScorecardMetrics): boolean {
  return metrics.impressions !== null
    || metrics.saves !== null
    || metrics.pinClicks !== null
    || metrics.outboundClicks !== null;
}

// ── Stable serialization + hash ──────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * JSON with object keys in sorted order, at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two snapshots built from the same
 * evidence by two code paths (or two versions of V8) can serialize differently and
 * hash differently — which would present an unchanged report as a changed one every
 * time the generator was touched. Arrays keep their order: the order of findings IS
 * content, they are ranked.
 *
 * `undefined` is dropped rather than encoded, matching JSON semantics, so an
 * optional field that is absent and one that is explicitly undefined hash alike.
 */
export function stableStringify(value: unknown): string {
  const normalize = (input: unknown): JsonValue | undefined => {
    if (input === null) return null;
    if (Array.isArray(input)) return input.map(item => normalize(item) ?? null);
    if (input instanceof Date) return input.toISOString();
    switch (typeof input) {
      case "string":
      case "boolean":
        return input;
      case "number":
        return Number.isFinite(input) ? input : null;
      case "object": {
        const source = input as Record<string, unknown>;
        const out: { [key: string]: JsonValue } = {};
        for (const key of Object.keys(source).sort()) {
          const normalized = normalize(source[key]);
          if (normalized !== undefined) out[key] = normalized;
        }
        return out;
      }
      default:
        return undefined;
    }
  };
  return JSON.stringify(normalize(value) ?? null);
}

/**
 * The hash a regeneration is decided by: sha256 over the snapshot's CONTENT.
 *
 * `meta` is excluded on purpose — see the module header. The schema, kind and period
 * are inside the hash because the same content under a different period is a
 * different report.
 */
export function evidenceHashOf(snapshot: InsightReportSnapshot): string {
  const hashable = {
    schema: snapshot.schema,
    kind: snapshot.kind,
    periodKey: snapshot.periodKey,
    content: snapshot.content,
  };
  return createHash("sha256").update(stableStringify(hashable)).digest("hex");
}

// ── Snapshots ────────────────────────────────────────────────────────────────

function versionsOf(set: EvidenceSet): ReportVersions {
  return {
    rule: set.ruleVersion || RULE_VERSION,
    threshold: set.thresholdVersion || THRESHOLD_VERSION,
    keywordSet: set.keywordSetVersion,
    category: set.category,
  };
}

function recordOf(
  snapshot: InsightReportSnapshot,
  subject: { contentId: string | null; draftId: string | null },
  set: EvidenceSet,
): InsightReportRecord {
  return {
    kind: snapshot.kind,
    periodKey: snapshot.periodKey,
    subjectContentId: subject.contentId,
    subjectDraftId: subject.draftId,
    snapshot,
    evidenceHash: evidenceHashOf(snapshot),
    evidenceVersion: set.thresholdVersion || THRESHOLD_VERSION,
    ruleVersion: set.ruleVersion || RULE_VERSION,
    keywordSetVersion: set.keywordSetVersion,
  };
}

/**
 * The weekly account report: the same reading the Insights panel shows, frozen.
 *
 * Same reading BY CONSTRUCTION — it takes the diagnosis object the dashboard renders
 * rather than recomputing one from the evidence. A report that disagreed with the
 * page it was generated from would be worse than no report.
 */
export function buildWeeklyReport(input: {
  set: EvidenceSet;
  diagnosis: InsightsDiagnosis;
  now: Date;
  dataThrough: string | null;
}): InsightReportRecord {
  const { set, diagnosis, now, dataThrough } = input;
  const content: WeeklyReportContent = {
    headline: diagnosis.headline,
    findings: diagnosis.findings,
    recommendations: diagnosis.recommendations,
    confidence: diagnosis.confidence,
    sampleCaveat: diagnosis.sampleCaveat,
    sample: { ...set.sample },
    evidence: set.account,
    versions: versionsOf(set),
  };
  const snapshot: InsightReportSnapshot = {
    schema: REPORT_SCHEMA_VERSION,
    kind: "weekly",
    periodKey: isoWeekKey(now),
    content,
    meta: { dataThrough },
  };
  return recordOf(snapshot, { contentId: null, draftId: null }, set);
}

const isKind = (prefix: "C" | "F") => (item: Evidence) => item.kind.startsWith(prefix);

/**
 * A scorecard for one published Pin.
 *
 * The Pin's own comparisons plus the account headline, and nothing else. A scorecard
 * is read next to a Pin the user recognises, so the useful sentence is "how did THIS
 * one do against Pins like it" — the account's reading is context, not the subject.
 * The line comes from `describeContentRow`, the same projection the content table
 * uses, so the two can never disagree about the same Pin.
 */
export function buildScorecardReport(input: {
  kind: "scorecard_t7" | "scorecard_t30";
  subject: {
    contentId: string;
    draftId: string | null;
    title: string | null;
    publishedAt: string | null;
    postUrl: string | null;
  };
  pinEvidence: Evidence[];
  metrics: ScorecardMetrics;
  set: EvidenceSet;
  accountHeadline: I18nText;
  now: Date;
  dataThrough: string | null;
}): InsightReportRecord {
  const { kind, subject, pinEvidence, metrics, set, accountHeadline, now, dataThrough } = input;
  const strongest = pinEvidence.find(item => item.confidence !== "insufficient") ?? pinEvidence[0] ?? null;
  const content: ScorecardReportContent = {
    subject: {
      contentId: subject.contentId,
      draftId: subject.draftId,
      title: subject.title,
      publishedAt: subject.publishedAt,
      postUrl: subject.postUrl,
      ageDays: ageInDays(subject.publishedAt, now) ?? 0,
    },
    accountHeadline,
    line: { key: describeContentRow(pinEvidence) },
    confidence: strongest?.confidence ?? "insufficient",
    sampleCaveat: sampleCaveat(set),
    metrics,
    evidence: pinEvidence.filter(isKind("C")),
    flags: pinEvidence.filter(isKind("F")),
    versions: versionsOf(set),
  };
  const snapshot: InsightReportSnapshot = {
    schema: REPORT_SCHEMA_VERSION,
    kind,
    periodKey: SCORECARD_WINDOWS[kind].periodKey,
    content,
    meta: { dataThrough },
  };
  return recordOf(snapshot, { contentId: subject.contentId, draftId: subject.draftId }, set);
}

// ── Regeneration ─────────────────────────────────────────────────────────────

/** The current row of one report identity, as the decision needs to see it. */
export type CurrentReportRow = {
  id: string;
  version: number;
  evidenceHash: string;
} | null;

export type RegenerationDecision =
  | { action: "noop" }
  | { action: "insert"; version: number; supersedeId: string | null };

/**
 * Should a regeneration write anything?
 *
 * Identical hash → no. This is the difference between a table that grows by one row
 * per real change and one that grows by one row per cron tick; only the first can be
 * read as a history.
 *
 * Different hash → insert at `version + 1` and supersede the old row. Never an
 * update: the old row may already have been sent or viewed, and rewriting what
 * somebody was shown is the failure this whole design is built against.
 */
export function regenerationDecision(
  current: CurrentReportRow,
  nextHash: string,
): RegenerationDecision {
  if (!current) return { action: "insert", version: 1, supersedeId: null };
  if (current.evidenceHash === nextHash) return { action: "noop" };
  return { action: "insert", version: current.version + 1, supersedeId: current.id };
}

/** The headline of any snapshot, for list rows. */
export function headlineOf(snapshot: InsightReportSnapshot): I18nText {
  const content = snapshot.content;
  return "headline" in content ? content.headline : content.accountHeadline;
}
