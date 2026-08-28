/**
 * Unit tests for the Insights evidence engine (pure: no network, no database).
 *
 * Three of these tests are the reason the module is shaped the way it is.
 *
 * **The mirror test.** `buildKeywordSet` must produce the same phrases — the same
 * hash — when a Pin's title changes. If the account's own words could reach the
 * phrase set, observation A1 ("your Pins carry none of your category's search
 * phrases") could never be false, and a rule that cannot be false is not evidence.
 * The signature makes this structurally impossible; the test makes it stay that way.
 *
 * **The blacklist scan.** Every template string, in English and in all 18 locale
 * catalogs, is scanned for the vocabulary of causation. We can observe that a Pin was
 * seen less often than the middle Pin of its group; nothing in Pinterest's API says
 * why. A translation that renders "seen less often" as "限流" turns a measurement
 * into an accusation, and it would ship silently — which is exactly why the scan
 * covers the locales and not only the source.
 *
 * **The tier boundaries.** 4 / 5 / 19 / 20 comparable Pins. A percentile from a
 * four-Pin cohort is arithmetic wearing the costume of statistics; the tiers are what
 * stop it reaching the page, so their boundaries are asserted rather than assumed.
 *
 * Run: npm run test:insights-engine
 */

import assert from "node:assert/strict";
import {
  containsPhrase,
  countPhraseHits,
  findPhrase,
  normalizePhrase,
  normalizeTokens,
  PHRASE_STOPWORDS,
} from "../src/lib/insights/phraseMatch";
import {
  buildCategoryPhraseIndex,
  buildKeywordSet,
  hashPhrases,
  inferCategory,
  keywordSetIsFresh,
  KEYWORD_SET_MAX_PHRASES,
  type KeywordExpansionRow,
  type TrendKeywordRow,
} from "../src/lib/insights/keywordSet";
import {
  ageBucketOf,
  buildEvidence,
  COHORT_ROW_LIMIT,
  median,
  observationWindow,
  percentileRank,
  REDIRECT_DOMAINS,
  tierFor,
  type Evidence,
  type EvidenceContentRow,
  type EvidenceInput,
  type EvidenceKind,
  type EvidenceObservation,
} from "../src/lib/insights/evidence";
import {
  buildDiagnosis,
  describeContentRow,
  TEMPLATE_KEYS,
} from "../src/lib/insights/recommendations";
import { en, PARTIAL } from "../src/lib/i18n/messages";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const NOW = new Date("2026-08-27T12:00:00.000Z");
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const KEYWORDS: TrendKeywordRow[] = [
  { keyword: "small pantry organization", category: "home-decor", priorityScore: 90 },
  { keyword: "kitchen shelf styling", category: "home-decor", priorityScore: 80 },
  { keyword: "bridal hair updo", category: "wedding", priorityScore: 70 },
];

const EXPANSIONS: KeywordExpansionRow[] = [
  { seedKeyword: "small pantry organization", expandedKeyword: "small pantry organization ideas", rank: 1 },
  { seedKeyword: "bridal hair updo", expandedKeyword: "bridal hair updo long", rank: 1 },
];

const KEYWORD_SET = {
  ...buildKeywordSet(KEYWORDS, EXPANSIONS, { category: "home-decor" }),
  version: 3,
  sourceSnapshotAt: NOW.toISOString(),
};

function content(overrides: Partial<EvidenceContentRow> & { pinId: string }): EvidenceContentRow {
  return {
    title: null,
    description: null,
    linkUrl: null,
    publishedAt: daysAgo(15),
    format: "image",
    origin: "vibepin",
    lifetime: {},
    ...overrides,
  };
}

function input(rows: EvidenceContentRow[], extra: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    now: NOW,
    accountDaily: [],
    content: rows,
    keywordSet: {
      phrases: KEYWORD_SET.phrases,
      category: KEYWORD_SET.category,
      version: KEYWORD_SET.version,
      hash: KEYWORD_SET.hash,
    },
    ...extra,
  };
}

const accountEvidence = (rows: Evidence[], kind: EvidenceKind): Evidence => {
  const found = rows.find(item => item.kind === kind);
  assert.ok(found, `expected ${kind} in the account evidence`);
  return found;
};

// ── phraseMatch ──────────────────────────────────────────────────────────────

test("normalization folds case, width and punctuation, and drops stopwords", () => {
  assert.deepEqual(normalizeTokens("Small Pantry Organization ideas"), ["small", "pantry", "organization", "ideas"]);
  // Full-width characters arrive from pasted product copy; NFKC folds them.
  assert.deepEqual(normalizeTokens("ＤＩＹ Shelf"), ["diy", "shelf"]);
  // A hyphen separates words rather than gluing them: "shopthelook" matches nothing.
  assert.deepEqual(normalizeTokens("shop-the-look — 3 ideas!"), ["shop-the-look", "3", "ideas"]);
  assert.deepEqual(normalizeTokens("ideas for a small pantry"), ["ideas", "small", "pantry"]);
  assert.deepEqual(normalizeTokens(null), []);
  assert.ok(PHRASE_STOPWORDS.length >= 100, "the stopword list is a versioned constant of ~120 words");
});

test("containsPhrase is a contiguous run, not a bag of words", () => {
  const phrase = ["small", "pantry", "organization"];
  assert.equal(containsPhrase(normalizeTokens("Small Pantry Organization ideas"), phrase), true);
  // Stopwords are dropped from both sides, so an inserted "for a" cannot hide a phrase.
  assert.equal(containsPhrase(normalizeTokens("Small pantry organization for a rental"), phrase), true);
  // Reordered tokens are a different phrase. This is the line a fuzzy matcher blurs.
  assert.equal(containsPhrase(normalizeTokens("organization pantry small"), phrase), false);
  // A gap breaks contiguity.
  assert.equal(containsPhrase(normalizeTokens("small kitchen pantry organization"), phrase), false);
  assert.equal(containsPhrase(normalizeTokens("anything"), []), false);
  assert.equal(findPhrase("Small Pantry Organization ideas", KEYWORD_SET.phrases), "small pantry organization");
  assert.equal(findPhrase("A photo of a chair", KEYWORD_SET.phrases), null);
  assert.equal(countPhraseHits("small pantry organization and kitchen shelf styling", KEYWORD_SET.phrases), 2);
  assert.equal(normalizePhrase("  The Best   Kitchen Shelf Styling "), "best kitchen shelf styling");
});

// ── keyword set ──────────────────────────────────────────────────────────────

test("the keyword set comes from trend data only — Pin text cannot reach it", () => {
  const before = buildKeywordSet(KEYWORDS, EXPANSIONS, { category: "home-decor" });
  assert.deepEqual(before.phrases, [
    "small pantry organization",
    "kitchen shelf styling",
    "small pantry organization ideas",
  ]);
  // A Pin's title changes; the inputs of the builder do not, so neither does the set.
  const after = buildKeywordSet(KEYWORDS, EXPANSIONS, { category: "home-decor" });
  assert.equal(after.hash, before.hash);
  assert.equal(hashPhrases(before.phrases), before.hash);
  // Another category's keywords are not in this account's set.
  assert.equal(before.phrases.includes("bridal hair updo"), false);
  // Single-token keywords match too much to be evidence and are dropped.
  const oneWord = buildKeywordSet([{ keyword: "pantry", category: "home-decor", priorityScore: 99 }], [], { category: "home-decor" });
  assert.deepEqual(oneWord.phrases, []);
});

test("the set is capped and ordered by strength, seeds before expansions", () => {
  const many: TrendKeywordRow[] = Array.from({ length: 400 }, (_, index) => ({
    keyword: `kitchen shelf ${index}`,
    category: "home-decor",
    priorityScore: index,
  }));
  const built = buildKeywordSet(many, [], { category: "home-decor" });
  assert.equal(built.phrases.length, 300, "seed limit is 300");
  assert.equal(built.phrases[0], "kitchen shelf 399", "highest priority first");
  assert.ok(built.phrases.length <= KEYWORD_SET_MAX_PHRASES);
});

test("category inference reads the account's own text but never writes it into the set", () => {
  const index = buildCategoryPhraseIndex(KEYWORDS);
  const inferred = inferCategory(["Small Pantry Organization", "Kitchen shelf styling board"], index);
  assert.equal(inferred.category, "home-decor");
  assert.equal(inferred.hits, 2);
  // No hits anywhere is "we do not know", never the biggest category.
  assert.equal(inferCategory(["untitled board"], index).category, null);
  assert.equal(keywordSetIsFresh({ category: "home-decor", sourceSnapshotAt: daysAgo(5) }, "home-decor", NOW), true);
  assert.equal(keywordSetIsFresh({ category: "home-decor", sourceSnapshotAt: daysAgo(45) }, "home-decor", NOW), false);
  assert.equal(keywordSetIsFresh({ category: "wedding", sourceSnapshotAt: daysAgo(1) }, "home-decor", NOW), false);
  assert.equal(keywordSetIsFresh(null, "home-decor", NOW), false);
});

// ── arithmetic ───────────────────────────────────────────────────────────────

test("percentile edge cases: a single row and a wall of ties both land mid-rank", () => {
  assert.equal(percentileRank([5], 5), 50, "a Pin compared with itself is neither above nor below");
  // A cohort where nobody has clicks must not report every Pin as bottom-of-cohort.
  assert.equal(percentileRank([0, 0, 0, 0], 0), 50);
  assert.equal(percentileRank([1, 2, 3, 4], 1), 12.5);
  assert.equal(percentileRank([1, 2, 3, 4], 4), 87.5);
  assert.equal(percentileRank([], 1), null);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("confidence tiers turn at 5 and 20 comparable Pins", () => {
  assert.equal(tierFor(0), "insufficient");
  assert.equal(tierFor(4), "insufficient");
  assert.equal(tierFor(5), "directional");
  assert.equal(tierFor(19), "directional");
  assert.equal(tierFor(20), "quantified");
});

test("age bands follow the pin_task windows", () => {
  assert.equal(ageBucketOf(daysAgo(1), NOW), "t1");
  assert.equal(ageBucketOf(daysAgo(5), NOW), "t7");
  assert.equal(ageBucketOf(daysAgo(20), NOW), "t30");
  assert.equal(ageBucketOf(daysAgo(60), NOW), "mature");
  assert.equal(ageBucketOf(null, NOW), "unknown");
  const published = daysAgo(30);
  assert.equal(observationWindow(published, daysAgo(28)), "t1");
  assert.equal(observationWindow(published, daysAgo(22)), "t7");
  assert.equal(observationWindow(published, daysAgo(25)), null, "between windows is not a day-7 reading");
});

// ── A-kinds ──────────────────────────────────────────────────────────────────

test("A1 counts recent Pins whose title and description carry no phrase", () => {
  const rows = [
    content({ pinId: "1", title: "Small Pantry Organization ideas", publishedAt: daysAgo(10) }),
    content({ pinId: "2", title: "A nice photo", publishedAt: daysAgo(20) }),
    content({ pinId: "3", title: null, description: "kitchen shelf styling in a rental", publishedAt: daysAgo(30) }),
    content({ pinId: "4", title: "Another photo", publishedAt: daysAgo(40) }),
    // Outside the 90-day window, and one with no text at all: neither is counted.
    content({ pinId: "5", title: "Old photo", publishedAt: daysAgo(120) }),
    content({ pinId: "6", title: "   ", description: null, publishedAt: daysAgo(3) }),
  ];
  const a1 = accountEvidence(buildEvidence(input(rows)).account, "A1");
  assert.equal(a1.details.checked, 4);
  assert.equal(a1.details.without, 2);
  assert.equal(a1.value, 0.5);
  assert.equal(a1.details.percent, 50);
});

test("A2 describes cadence: active days, mean per day, busiest day", () => {
  const rows = [
    content({ pinId: "1", publishedAt: `${daysAgo(2).slice(0, 10)}T09:00:00.000Z` }),
    content({ pinId: "2", publishedAt: `${daysAgo(2).slice(0, 10)}T10:00:00.000Z` }),
    content({ pinId: "3", publishedAt: `${daysAgo(2).slice(0, 10)}T11:00:00.000Z` }),
    content({ pinId: "4", publishedAt: `${daysAgo(9).slice(0, 10)}T09:00:00.000Z` }),
    content({ pinId: "5", publishedAt: daysAgo(400) }),
  ];
  const a2 = accountEvidence(buildEvidence(input(rows)).account, "A2");
  assert.equal(a2.details.published, 4);
  assert.equal(a2.details.activeDays, 2);
  assert.equal(a2.details.maxPerDay, 3);
  assert.equal(a2.details.perDayMean, Math.round((4 / 30) * 100) / 100);
});

test("A3 counts destination links on the versioned shortener list", () => {
  const rows = [
    content({ pinId: "1", linkUrl: "https://bit.ly/abc" }),
    content({ pinId: "2", linkUrl: "https://www.t.co/xyz" }),
    content({ pinId: "3", linkUrl: "https://quietspaces.example/product/1" }),
    content({ pinId: "4", linkUrl: "not a url" }),
    content({ pinId: "5", linkUrl: null }),
  ];
  const a3 = accountEvidence(buildEvidence(input(rows)).account, "A3");
  assert.equal(a3.details.withLink, 4, "rows without a link are not in the denominator");
  assert.equal(a3.details.matched, 2, "www. is stripped before the list is consulted");
  assert.equal(a3.value, 0.5);
  assert.ok(REDIRECT_DOMAINS.includes("bit.ly") && REDIRECT_DOMAINS.includes("shorturl.at"));
});

// ── cohorts ──────────────────────────────────────────────────────────────────

test("cohorts split by format and age band, newest 300 rows each", () => {
  const rows: EvidenceContentRow[] = [];
  for (let index = 0; index < 320; index += 1) {
    rows.push(content({
      pinId: `image-${index}`,
      format: "image",
      // All inside the "mature" band, newest first by construction.
      publishedAt: daysAgo(40 + index),
      lifetime: { IMPRESSION: 100 + index },
    }));
  }
  rows.push(content({ pinId: "video-1", format: "video", publishedAt: daysAgo(40), lifetime: { IMPRESSION: 5 } }));
  rows.push(content({ pinId: "fresh-1", format: "image", publishedAt: daysAgo(1), lifetime: { IMPRESSION: 5 } }));

  const set = buildEvidence(input(rows));
  assert.equal(set.sample.cohorts, 3, "image|mature, video|mature and image|t1 are three cohorts");
  const c3 = set.byPin.get("image-0")!.find(item => item.kind === "C3")!;
  assert.equal(c3.n, COHORT_ROW_LIMIT, "the cohort is capped at 300 members");
  assert.equal(c3.eligible_n, COHORT_ROW_LIMIT);
  // A lone Pin in its own cohort can be compared with nobody.
  const lonely = set.byPin.get("video-1")!.find(item => item.kind === "C3")!;
  assert.equal(lonely.confidence, "insufficient");
  assert.equal(lonely.value, null, "an insufficient comparison prints no number");
});

// ── F-kinds ──────────────────────────────────────────────────────────────────

/** A cohort of `count` Pins with the given impressions/outbound, plus one probe Pin. */
function cohortRows(count: number, probe: { impressions: number; outbound: number; pinId?: string }): EvidenceContentRow[] {
  const rows: EvidenceContentRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(content({
      pinId: `peer-${index}`,
      publishedAt: daysAgo(40 + index),
      lifetime: { IMPRESSION: 1000 + index, SAVE: 10, PIN_CLICK: 100, OUTBOUND_CLICK: 100 + index },
    }));
  }
  rows.push(content({
    pinId: probe.pinId ?? "probe",
    publishedAt: daysAgo(41),
    lifetime: {
      IMPRESSION: probe.impressions,
      SAVE: 10,
      PIN_CLICK: 100,
      OUTBOUND_CLICK: probe.outbound,
    },
  }));
  return rows;
}

test("F1 flags a Pin seen less than the bottom quarter of its cohort", () => {
  const set = buildEvidence(input(cohortRows(24, { impressions: 1, outbound: 0 })));
  const probe = set.byPin.get("probe")!;
  assert.ok(probe.some(item => item.kind === "F1"), "impressions percentile below 25");
  const aggregate = accountEvidence(set.account, "F1");
  // A percentile cut flags its own bottom quarter by construction: in a 25-Pin cohort
  // six Pins sit under the 25th percentile no matter how good the account is. That is
  // why F1 is a per-Pin pointer ("look at these") and not an account-level verdict,
  // and why the headline order puts a census observation like A1 ahead of it.
  assert.equal(aggregate.details.matched, 6);
  assert.equal(aggregate.details.comparable, 25);
  assert.equal(aggregate.confidence, "quantified");
  assert.equal(describeContentRow(probe), "insights.evidence.row.impressionsBelow");
  // A peer in the middle of the pack is not flagged.
  assert.equal(set.byPin.get("peer-12")!.some(item => item.kind === "F1"), false);
});

test("F2 needs normal impressions AND a low outbound rate", () => {
  // Seen as often as the cohort, but almost nobody went on to the site.
  const flagged = buildEvidence(input(cohortRows(24, { impressions: 1_000_000, outbound: 0 })));
  const probe = flagged.byPin.get("probe")!;
  assert.ok(probe.some(item => item.kind === "F2"));
  assert.equal(describeContentRow(probe), "insights.evidence.row.outboundBelow");
  // Low impressions with the same low outbound rate is F1's situation, not F2's.
  const lowReach = buildEvidence(input(cohortRows(24, { impressions: 1, outbound: 0 })));
  assert.equal(lowReach.byPin.get("probe")!.some(item => item.kind === "F2"), false);
});

test("F3 names clicks that happened and stops there", () => {
  const set = buildEvidence(input(cohortRows(24, { impressions: 1200, outbound: 5000 })));
  const probe = set.byPin.get("probe")!;
  const f3 = probe.find(item => item.kind === "F3");
  assert.ok(f3, "outbound clicks at or above the 40th percentile");
  assert.equal(f3!.details.metric, "clicks_present_conversion_unobserved");
  // A Pin with zero outbound clicks is not "converting", whatever its percentile.
  const zero = buildEvidence(input(cohortRows(24, { impressions: 1200, outbound: 0 })));
  assert.equal(zero.byPin.get("probe")!.some(item => item.kind === "F3"), false);
});

test("confidence follows the cohort: 4 comparable Pins state nothing, 5 state direction, 20 state numbers", () => {
  const at4 = buildEvidence(input(cohortRows(3, { impressions: 1, outbound: 0 })));
  const c3at4 = at4.byPin.get("probe")!.find(item => item.kind === "C3")!;
  assert.equal(c3at4.eligible_n, 4);
  assert.equal(c3at4.confidence, "insufficient");
  assert.equal(c3at4.value, null);
  assert.equal(c3at4.details.percentile, undefined);
  assert.equal(describeContentRow(at4.byPin.get("probe")), "insights.evidence.row.insufficient");
  assert.equal(accountEvidence(at4.account, "F1").confidence, "insufficient");

  const at5 = buildEvidence(input(cohortRows(4, { impressions: 1, outbound: 0 })));
  const c3at5 = at5.byPin.get("probe")!.find(item => item.kind === "C3")!;
  assert.equal(c3at5.eligible_n, 5);
  assert.equal(c3at5.confidence, "directional");
  assert.equal(c3at5.details.direction, "below");
  assert.equal(c3at5.details.percentile, undefined, "a directional tier never prints a percentile");
  assert.equal(c3at5.baseline, null, "nor a cohort median");

  const at19 = buildEvidence(input(cohortRows(18, { impressions: 1, outbound: 0 })));
  assert.equal(at19.byPin.get("probe")!.find(item => item.kind === "C3")!.confidence, "directional");

  const at20 = buildEvidence(input(cohortRows(19, { impressions: 1, outbound: 0 })));
  const c3at20 = at20.byPin.get("probe")!.find(item => item.kind === "C3")!;
  assert.equal(c3at20.eligible_n, 20);
  assert.equal(c3at20.confidence, "quantified");
  assert.equal(typeof c3at20.details.percentile, "number");
  assert.ok(c3at20.baseline !== null);
});

// ── C5 ───────────────────────────────────────────────────────────────────────

test("C5 is insufficient unless BOTH age-pinned observations exist", () => {
  const published = daysAgo(20);
  const rows = [content({ pinId: "aged", publishedAt: published, lifetime: { IMPRESSION: 900 } })];

  const withoutHistory = buildEvidence(input(rows));
  const c5 = withoutHistory.byPin.get("aged")!.find(item => item.kind === "C5")!;
  assert.equal(c5.confidence, "insufficient");
  assert.equal(c5.value, null);
  assert.equal(c5.details.basis, "unavailable");
  assert.equal(withoutHistory.sample.ageBasis, "lifetime", "the caveat must say these are lifetime totals");

  const onlyT1: EvidenceObservation[] = [
    { pinId: "aged", metricName: "IMPRESSION", metricValue: 100, observedAt: daysAgo(18) },
  ];
  assert.equal(
    buildEvidence(input(rows, { observations: onlyT1 })).byPin.get("aged")!.find(item => item.kind === "C5")!.confidence,
    "insufficient",
    "one age-pinned reading is not a growth measurement",
  );

  const both: EvidenceObservation[] = [
    ...onlyT1,
    { pinId: "aged", metricName: "IMPRESSION", metricValue: 250, observedAt: daysAgo(12) },
  ];
  const withHistory = buildEvidence(input(rows, { observations: both }));
  const grown = withHistory.byPin.get("aged")!.find(item => item.kind === "C5")!;
  assert.equal(grown.confidence, "quantified");
  assert.equal(grown.value, 150, "(250 - 100) / 100 = 150%");
  // A day-1 and a day-7 reading make C5 possible, and change nothing else: this Pin is
  // 20 days old, so its C1–C4 comparisons still use the lifetime total, and the caveat
  // has to keep saying so. Growth being measurable does not make the rest age-pinned.
  assert.equal(withHistory.sample.ageBasis, "lifetime");
  assert.equal(withHistory.byPin.get("aged")!.find(item => item.kind === "C3")!.details.basis, "lifetime");
});

test("a reading taken inside the Pin's current band replaces the lifetime total", () => {
  const rows = [content({ pinId: "recent", publishedAt: daysAgo(8), lifetime: { IMPRESSION: 900 } })];
  const set = buildEvidence(input(rows, {
    // Published 8 days ago, observed at day 8: the day-7 window, which is also the
    // band this Pin is in right now.
    observations: [{ pinId: "recent", metricName: "IMPRESSION", metricValue: 120, observedAt: NOW.toISOString() }],
  }));
  const c3 = set.byPin.get("recent")!.find(item => item.kind === "C3")!;
  assert.equal(c3.details.basis, "age_pinned");
  assert.equal(set.sample.ageBasis, "age_pinned");
});

// ── recommendations ──────────────────────────────────────────────────────────

test("a recommendation changes exactly one variable, and never the same one twice", () => {
  const rows = [
    ...cohortRows(24, { impressions: 1_000_000, outbound: 0, pinId: "cta-probe" }),
    // Bunched publishing in the last 30 days, all with shortened links and no phrases.
    ...Array.from({ length: 6 }, (_, index) => content({
      pinId: `recent-${index}`,
      title: "A nice photo",
      linkUrl: "https://bit.ly/abc",
      publishedAt: `${daysAgo(4).slice(0, 10)}T0${index}:00:00.000Z`,
    })),
  ];
  const diagnosis = buildDiagnosis(buildEvidence(input(rows)));
  assert.ok(diagnosis.recommendations.length >= 1 && diagnosis.recommendations.length <= 2);
  const variables = diagnosis.recommendations.map(item => item.change.variable);
  assert.equal(new Set(variables).size, variables.length, "two recommendations never share a variable");
  for (const recommendation of diagnosis.recommendations) {
    assert.equal(typeof recommendation.change.variable, "string");
    assert.ok(recommendation.observationIds.length >= 1, "a recommendation cites the evidence it came from");
    assert.ok(recommendation.keep.key.startsWith("insights.recommendation."));
    assert.ok(recommendation.test.key.startsWith("insights.recommendation."));
  }
  assert.ok(diagnosis.findings.length <= 3);
  assert.equal(diagnosis.headline.key, "insights.recommendation.headline.f2", "strongest finding leads");
  assert.equal(diagnosis.sampleCaveat.key, "insights.evidence.caveat.lifetime");
  assert.equal(diagnosis.sampleCaveat.params?.pins, rows.length);
});

test("an account with nothing comparable gets the fallback headline and no invented findings", () => {
  const set = buildEvidence(input([content({ pinId: "only", title: "A photo", publishedAt: daysAgo(2) })]));
  const diagnosis = buildDiagnosis(set);
  assert.equal(diagnosis.headline.key, "insights.recommendation.headline.fallback");
  assert.deepEqual(diagnosis.findings, []);
  assert.deepEqual(diagnosis.recommendations, []);
  assert.equal(diagnosis.confidence, "insufficient");
  // The caveat is never withheld: it is the line that explains the silence above it.
  assert.equal(diagnosis.sampleCaveat.key, "insights.evidence.caveat.lifetime");
  assert.equal(diagnosis.ruleVersion, set.ruleVersion);
  assert.equal(diagnosis.keywordSetVersion, 3);
});

// ── language ─────────────────────────────────────────────────────────────────

test("every template key exists in the English catalog", () => {
  const catalog = en as unknown as Record<string, string>;
  for (const key of TEMPLATE_KEYS) {
    assert.ok(typeof catalog[key] === "string" && catalog[key].length > 0, `missing English string for ${key}`);
  }
});

test("no template, in any language, claims a cause", () => {
  // Words that assert an intent or a mechanism nobody outside Pinterest can observe.
  const banned = /suppress|shadowban|throttl|限流|压制|算法惩罚/i;
  const causal = /because\s+pinterest|since\s+the\s+algorithm/i;
  const scanned = (key: string) => key.startsWith("insights.evidence.")
    || key.startsWith("insights.recommendation.")
    || key.startsWith("insights.diagnosis.");

  let checked = 0;
  const scan = (locale: string, key: string, value: string) => {
    checked += 1;
    assert.equal(banned.test(value), false, `${locale}.${key} claims a cause: ${value}`);
    assert.equal(causal.test(value), false, `${locale}.${key} explains why: ${value}`);
  };
  for (const [key, value] of Object.entries(en as unknown as Record<string, string>)) {
    if (scanned(key)) scan("en", key, value);
  }
  for (const [locale, catalog] of Object.entries(PARTIAL)) {
    for (const [key, value] of Object.entries(catalog as Record<string, string>)) {
      if (scanned(key) && typeof value === "string") scan(locale, key, value);
    }
  }
  // Evidence ids and metric names are user-visible in support threads and logs.
  for (const key of TEMPLATE_KEYS) scan("key", key, key);
  assert.ok(checked > 100, `expected the scan to cover the catalogs, saw ${checked} strings`);
});

console.log(`\n${passed} Insights evidence-engine tests passed.`);
