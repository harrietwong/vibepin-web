/**
 * The shapes a stored Insights report has: the frozen snapshot, and the two
 * projections the API hands out.
 *
 * This file exists separately from `reportBuilder.ts` for one mechanical reason: the
 * builder hashes, and hashing means `node:crypto`, which must never end up in a
 * client bundle. The "This week" card and the Plan scorecard modal import types from
 * HERE; nothing they import can drag a Node built-in into the browser.
 *
 * Everything user-visible in a snapshot is an i18n key plus params, never a rendered
 * sentence. A report is read weeks after it was written, possibly in a different
 * language than the one the cron job happened to run in — and a cron job has no
 * language at all. Keys keep a frozen report both immutable and translatable, which
 * a stored English string cannot be.
 */

import type { Evidence, EvidenceConfidence } from "./evidence";
import type { I18nText, InsightsFinding, InsightsRecommendation } from "./recommendations";

export type InsightReportKind = "weekly" | "scorecard_t7" | "scorecard_t30";

export type InsightNarrativeStatus = "template" | "llm" | "llm_failed_fallback";

/**
 * Bumped when the snapshot shape changes in a way an older reader cannot handle.
 * Stored inside the snapshot rather than only in a column so a row copied out of the
 * database still says what it is.
 */
export const REPORT_SCHEMA_VERSION = "insights.report.v1";

/** The versions that decide what a number in this report MEANS. */
export type ReportVersions = {
  /** Engine RULE_VERSION: which observations could be made at all. */
  rule: string;
  /** Engine THRESHOLD_VERSION: where the cut-offs sat. */
  threshold: string;
  /** account_keyword_set.version the phrase observations were measured against. */
  keywordSet: number | null;
  /** The category that keyword set was built for. */
  category: string | null;
};

/** How much of the account the reading is based on — always carried, never implied. */
export type ReportSample = {
  totalPins: number;
  comparablePins: number;
  cohorts: number;
  ageBasis: "age_pinned" | "lifetime" | "mixed";
  observedDays: number;
};

export type WeeklyReportContent = {
  headline: I18nText;
  findings: InsightsFinding[];
  recommendations: InsightsRecommendation[];
  confidence: EvidenceConfidence;
  sampleCaveat: I18nText;
  sample: ReportSample;
  /** The account-level observation rows the findings were drawn from. */
  evidence: Evidence[];
  versions: ReportVersions;
};

/** The four lifetime numbers a scorecard shows next to its line. */
export type ScorecardMetrics = {
  impressions: number | null;
  saves: number | null;
  pinClicks: number | null;
  outboundClicks: number | null;
};

export type ScorecardReportContent = {
  subject: {
    contentId: string;
    draftId: string | null;
    title: string | null;
    publishedAt: string | null;
    postUrl: string | null;
    /** Whole days between publish and generation — what "T+7" actually was. */
    ageDays: number;
  };
  /** The account's headline, so a scorecard is read in the account's context. */
  accountHeadline: I18nText;
  /** The one-line read on this Pin, from the same evidence as the content table. */
  line: I18nText;
  confidence: EvidenceConfidence;
  sampleCaveat: I18nText;
  metrics: ScorecardMetrics;
  /** This Pin's comparisons (C-kinds). */
  evidence: Evidence[];
  /** This Pin's flagged observations (F-kinds), if any fired. */
  flags: Evidence[];
  versions: ReportVersions;
};

/**
 * The frozen artefact.
 *
 * `content` is hashed; `meta` is not. Which run the data came from is bookkeeping,
 * and a report that produced a new version every night because a timestamp moved
 * would bury the versions that mean something.
 */
export type InsightReportSnapshot = {
  schema: typeof REPORT_SCHEMA_VERSION;
  kind: InsightReportKind;
  periodKey: string;
  content: WeeklyReportContent | ScorecardReportContent;
  meta: { dataThrough: string | null };
};

export function isWeeklyContent(
  content: WeeklyReportContent | ScorecardReportContent,
): content is WeeklyReportContent {
  return "findings" in content;
}

/** What one generated report is, before it becomes a row. */
export type InsightReportRecord = {
  kind: InsightReportKind;
  periodKey: string;
  subjectContentId: string | null;
  subjectDraftId: string | null;
  snapshot: InsightReportSnapshot;
  evidenceHash: string;
  evidenceVersion: string;
  ruleVersion: string;
  keywordSetVersion: number | null;
};

/** A list row: enough to label and order, never the body. */
export type InsightReportSummary = {
  id: string;
  kind: InsightReportKind;
  periodKey: string;
  subjectContentId: string | null;
  subjectDraftId: string | null;
  version: number;
  generatedAt: string;
  viewedAt: string | null;
  narrativeStatus: InsightNarrativeStatus;
  headline: I18nText;
  dataThrough: string | null;
};

/** The body. Reading one marks it viewed, which is also what freezes it. */
export type InsightReportDetail = InsightReportSummary & {
  evidenceHash: string;
  ruleVersion: string | null;
  keywordSetVersion: number | null;
  snapshot: InsightReportSnapshot;
  /** This user's thumb on this report, when they have given one. */
  helpful: boolean | null;
};

export type InsightReportListResponse = {
  reports: InsightReportSummary[];
  /** Present and true only when the plan is not entitled; then `reports` is empty. */
  locked?: true;
};
