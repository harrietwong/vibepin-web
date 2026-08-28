/**
 * From observations to one thing to try next.
 *
 * Three constraints shape every template below.
 *
 * **1. It returns keys, not sentences.** The engine runs on the server, once per
 * connection, and is cached; the reader's language is known only in the page. So each
 * template is an i18n key plus parameters, rendered where the locale lives.
 *
 * **2. It names an action, never a cause.** "Fewer of the people who saw this left
 * for your site than for the middle Pin of its group" is an observation; "Pinterest
 * is suppressing this Pin" is a story, and the data cannot tell them apart. Every
 * recommendation is therefore phrased as an experiment the user can run — change one
 * thing, watch one number — rather than an explanation of what went wrong. A test
 * scans every template string in every locale for the vocabulary of causation
 * (suppress / shadowban / throttle / 限流 / 压制 / 算法惩罚, "because Pinterest",
 * "since the algorithm"), because a translator adding that vocabulary is the most
 * likely way it would enter this product.
 *
 * **3. One variable per recommendation.** Two changes at once produce a result nobody
 * can attribute — the user would learn nothing from the next 30 days. The type makes
 * the single variable structural, and two recommendations never propose the same
 * variable, so following both is still a readable experiment.
 */

import type {
  Evidence,
  EvidenceConfidence,
  EvidenceKind,
  EvidenceSet,
} from "./evidence";

export type I18nText = { key: string; params?: Record<string, string | number> };

/**
 * The variables a recommendation may ask the user to change.
 *
 * The full contract, deliberately wider than what today's rules reach: adding a rule
 * must not mean widening a type the API already ships.
 */
export type RecommendationVariable =
  | "hook"
  | "cta"
  | "first_image"
  | "publish_time"
  | "keyword"
  | "format"
  | "link";

export type InsightsFinding = {
  evidenceId: string;
  kind: EvidenceKind;
  confidence: EvidenceConfidence;
  text: I18nText;
};

export type InsightsRecommendation = {
  id: string;
  observationIds: string[];
  keep: I18nText;
  change: { variable: RecommendationVariable; phrasing: I18nText };
  test: I18nText;
};

export type InsightsDiagnosis = {
  headline: I18nText;
  findings: InsightsFinding[];
  recommendations: InsightsRecommendation[];
  confidence: EvidenceConfidence;
  ruleVersion: string;
  thresholdVersion: string;
  keywordSetVersion: number | null;
  category: string | null;
  /** Always rendered: it is what tells the reader how much the rest is worth. */
  sampleCaveat: I18nText;
};

/** Most findings shown in the panel. Three is what fits above a table without
 *  becoming a second table. */
export const MAX_FINDINGS = 3;
/** Recommendations shown. Two experiments at once is the most a person can attribute. */
export const MAX_RECOMMENDATIONS = 2;

/** Share of recent Pins whose title and description carry none of the account's
 *  keyword phrases before A1 is worth saying out loud. */
export const A1_REPORT_RATIO = 0.5;
/** Share of recent links pointing at a shortener before A3 is worth saying. */
export const A3_REPORT_RATIO = 0.2;
/** Publishes in the window before cadence can be described at all. */
export const A2_MIN_PUBLISHED = 3;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Priority is the order a human would want them: the observation that leaves the most
 * room to act comes first.
 *
 * F1 sits BELOW A1 for a reason that is easy to miss. F1 is a percentile cut, so it
 * flags roughly the bottom quarter of every cohort by construction — an account can
 * never be free of it, and a headline that is true for everyone forever tells the
 * reader nothing. It stays because naming WHICH Pins are in that quarter is useful on
 * the row itself; it just should not be the first thing said about an account when a
 * census observation like A1 (this share of your titles carries none of the phrases
 * people search) is available.
 */
const PRIORITY: EvidenceKind[] = ["F2", "A1", "F1", "F3", "A3", "A2"];

/** Flagged share below which F1 is not worth an account-level line: a couple of Pins
 *  at the bottom of a large cohort is what a bottom quarter looks like when it is
 *  nearly empty, not a pattern. */
export const F1_REPORT_RATIO = 0.15;

type Template = {
  kind: EvidenceKind;
  headlineKey: string;
  finding: (evidence: Evidence, confidence: EvidenceConfidence) => I18nText;
  recommendation?: {
    id: string;
    variable: RecommendationVariable;
    keepKey: string;
    changeKey: string;
    testKey: string;
  };
  /** Is this observation worth showing at all? Thresholds live here, not in the
   *  engine: the engine measures, this module decides what is worth a user's time. */
  reportable: (evidence: Evidence) => boolean;
};

const TEMPLATES: Record<string, Template> = {
  F2: {
    kind: "F2",
    headlineKey: "insights.recommendation.headline.f2",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.f2.quantified",
        params: { matched: num(evidence.details.matched), comparable: num(evidence.details.comparable) },
      }
      : { key: "insights.evidence.finding.f2.directional" }),
    recommendation: {
      id: "rec-cta",
      variable: "cta",
      keepKey: "insights.recommendation.f2.keep",
      changeKey: "insights.recommendation.f2.change",
      testKey: "insights.recommendation.f2.test",
    },
    reportable: evidence => num(evidence.details.matched) > 0,
  },
  F1: {
    kind: "F1",
    headlineKey: "insights.recommendation.headline.f1",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.f1.quantified",
        params: { matched: num(evidence.details.matched), comparable: num(evidence.details.comparable) },
      }
      : { key: "insights.evidence.finding.f1.directional" }),
    recommendation: {
      id: "rec-keyword",
      variable: "keyword",
      keepKey: "insights.recommendation.f1.keep",
      changeKey: "insights.recommendation.f1.change",
      testKey: "insights.recommendation.f1.test",
    },
    reportable: evidence => num(evidence.details.matched) > 0
      && (evidence.value ?? 0) >= F1_REPORT_RATIO,
  },
  A1: {
    kind: "A1",
    headlineKey: "insights.recommendation.headline.a1",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.a1.quantified",
        params: { without: num(evidence.details.without), checked: num(evidence.details.checked) },
      }
      : { key: "insights.evidence.finding.a1.directional" }),
    recommendation: {
      id: "rec-keyword",
      variable: "keyword",
      keepKey: "insights.recommendation.a1.keep",
      changeKey: "insights.recommendation.a1.change",
      testKey: "insights.recommendation.a1.test",
    },
    reportable: evidence => (evidence.value ?? 0) >= A1_REPORT_RATIO && num(evidence.details.checked) > 0,
  },
  F3: {
    kind: "F3",
    headlineKey: "insights.recommendation.headline.f3",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.f3.quantified",
        params: { matched: num(evidence.details.matched), comparable: num(evidence.details.comparable) },
      }
      : { key: "insights.evidence.finding.f3.directional" }),
    recommendation: {
      id: "rec-link",
      variable: "link",
      keepKey: "insights.recommendation.f3.keep",
      changeKey: "insights.recommendation.f3.change",
      testKey: "insights.recommendation.f3.test",
    },
    reportable: evidence => num(evidence.details.matched) > 0,
  },
  A3: {
    kind: "A3",
    headlineKey: "insights.recommendation.headline.a3",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.a3.quantified",
        params: { matched: num(evidence.details.matched), withLink: num(evidence.details.withLink) },
      }
      : { key: "insights.evidence.finding.a3.directional" }),
    recommendation: {
      id: "rec-link",
      variable: "link",
      keepKey: "insights.recommendation.a3.keep",
      changeKey: "insights.recommendation.a3.change",
      testKey: "insights.recommendation.a3.test",
    },
    reportable: evidence => (evidence.value ?? 0) >= A3_REPORT_RATIO && num(evidence.details.withLink) > 0,
  },
  A2: {
    kind: "A2",
    headlineKey: "insights.recommendation.headline.a2",
    finding: (evidence, confidence) => (confidence === "quantified"
      ? {
        key: "insights.evidence.finding.a2.quantified",
        params: {
          activeDays: num(evidence.details.activeDays),
          published: num(evidence.details.published),
          maxPerDay: num(evidence.details.maxPerDay),
        },
      }
      : { key: "insights.evidence.finding.a2.directional" }),
    recommendation: {
      id: "rec-publish-time",
      variable: "publish_time",
      keepKey: "insights.recommendation.a2.keep",
      changeKey: "insights.recommendation.a2.change",
      testKey: "insights.recommendation.a2.test",
    },
    // Only worth a line when publishing is bunched: on average more than two Pins per
    // active day over the window. A steady schedule needs no comment.
    reportable: evidence => num(evidence.details.published) >= A2_MIN_PUBLISHED
      && num(evidence.details.activeDays) > 0
      && num(evidence.details.published) >= num(evidence.details.activeDays) * 2,
  },
};

/** Row lines carry no numbers on purpose: the row already shows Seen, Saved and Went
 *  to site in the columns next to it, and repeating them in prose is noise that
 *  would also have to survive 18 translations. */
const ROW_KEYS = {
  impressionsBelow: "insights.evidence.row.impressionsBelow",
  outboundBelow: "insights.evidence.row.outboundBelow",
  clicksPresent: "insights.evidence.row.clicksPresent",
  outboundAbove: "insights.evidence.row.outboundAbove",
  impressionsAbove: "insights.evidence.row.impressionsAbove",
  savesAbove: "insights.evidence.row.savesAbove",
  typical: "insights.evidence.row.typical",
  insufficient: "insights.evidence.row.insufficient",
} as const;

const CAVEAT_KEYS = {
  lifetime: "insights.evidence.caveat.lifetime",
  age_pinned: "insights.evidence.caveat.agePinned",
  mixed: "insights.evidence.caveat.mixed",
} as const;

const FALLBACK_HEADLINE = "insights.recommendation.headline.fallback";

/** Every key this module can emit. The test asserts each exists in the English
 *  catalog, so a template can never ship as a raw key on the page. */
export const TEMPLATE_KEYS: string[] = [
  ...Object.values(TEMPLATES).flatMap(template => [
    template.headlineKey,
    ...(template.recommendation
      ? [template.recommendation.keepKey, template.recommendation.changeKey, template.recommendation.testKey]
      : []),
  ]),
  ...Object.keys(TEMPLATES).flatMap(kind => [
    `insights.evidence.finding.${kind.toLowerCase()}.quantified`,
    `insights.evidence.finding.${kind.toLowerCase()}.directional`,
  ]),
  ...Object.values(ROW_KEYS),
  ...Object.values(CAVEAT_KEYS),
  FALLBACK_HEADLINE,
];

function reportableFindings(set: EvidenceSet): Array<{ evidence: Evidence; template: Template }> {
  const byKind = new Map(set.account.map(item => [item.kind, item] as const));
  const ordered: Array<{ evidence: Evidence; template: Template }> = [];
  for (const kind of PRIORITY) {
    const evidence = byKind.get(kind);
    const template = TEMPLATES[kind];
    if (!evidence || !template) continue;
    // Nothing comparative is asserted from a cohort too small to compare in.
    if (evidence.confidence === "insufficient") continue;
    if (!template.reportable(evidence)) continue;
    ordered.push({ evidence, template });
  }
  return ordered;
}

/**
 * The one-line read on a single Pin, from that Pin's own evidence.
 *
 * Same numbers as the panel by construction: this is a projection of the evidence
 * array, not a second rule that happens to agree today.
 */
export function describeContentRow(evidence: readonly Evidence[] | undefined): string {
  if (!evidence || evidence.length === 0) return ROW_KEYS.insufficient;
  const usable = evidence.filter(item => item.confidence !== "insufficient");
  if (usable.length === 0) return ROW_KEYS.insufficient;
  const find = (kind: EvidenceKind) => usable.find(item => item.kind === kind);

  if (find("F2")) return ROW_KEYS.outboundBelow;
  if (find("F1")) return ROW_KEYS.impressionsBelow;
  if (find("F3")) return ROW_KEYS.clicksPresent;

  const above = (kind: EvidenceKind) => find(kind)?.details.direction === "above";
  if (above("C2")) return ROW_KEYS.outboundAbove;
  if (above("C3")) return ROW_KEYS.impressionsAbove;
  if (above("C1")) return ROW_KEYS.savesAbove;
  return ROW_KEYS.typical;
}

export function sampleCaveat(set: EvidenceSet): I18nText {
  return {
    key: CAVEAT_KEYS[set.sample.ageBasis],
    params: { pins: set.sample.totalPins, comparable: set.sample.comparablePins },
  };
}

/**
 * Headline + findings + recommendations for one connection.
 *
 * The headline comes from the strongest reportable finding, and falls back to a
 * neutral line when only A-kinds (or nothing) survive the thresholds — a page that
 * invents a headline out of an empty evidence set is the exact failure this design
 * is against.
 */
export function buildDiagnosis(set: EvidenceSet): InsightsDiagnosis {
  const reportable = reportableFindings(set);

  const findings: InsightsFinding[] = reportable.slice(0, MAX_FINDINGS).map(({ evidence, template }) => ({
    evidenceId: evidence.id,
    kind: evidence.kind,
    confidence: evidence.confidence,
    text: template.finding(evidence, evidence.confidence),
  }));

  const recommendations: InsightsRecommendation[] = [];
  const usedVariables = new Set<RecommendationVariable>();
  for (const { evidence, template } of reportable) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    const recommendation = template.recommendation;
    if (!recommendation) continue;
    // Never two recommendations on the same variable: the second would not be a
    // second experiment, it would be the same one worded differently.
    if (usedVariables.has(recommendation.variable)) continue;
    usedVariables.add(recommendation.variable);
    recommendations.push({
      id: `${recommendation.id}:${evidence.kind}`,
      observationIds: [evidence.id],
      keep: { key: recommendation.keepKey },
      change: { variable: recommendation.variable, phrasing: { key: recommendation.changeKey } },
      test: { key: recommendation.testKey },
    });
  }

  const strongest = reportable[0] ?? null;
  return {
    headline: strongest
      ? { key: strongest.template.headlineKey }
      : { key: FALLBACK_HEADLINE },
    findings,
    recommendations,
    confidence: strongest ? strongest.evidence.confidence : "insufficient",
    ruleVersion: set.ruleVersion,
    thresholdVersion: set.thresholdVersion,
    keywordSetVersion: set.keywordSetVersion,
    category: set.category,
    sampleCaveat: sampleCaveat(set),
  };
}
