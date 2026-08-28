#!/usr/bin/env tsx
/**
 * buildPrefillFromInsight — the adapter between a reading and Create Pins.
 * Run: npx tsx scripts/test-insights-prefill.ts
 *
 * The three properties worth protecting here are not about shape.
 *
 * **The variable survives the trip.** The whole point of a Keep/Change/Test
 * recommendation is that ONE thing changes; if the named variable does not reach the
 * brief the image model reads, the user runs an experiment they cannot attribute and
 * the feature is worse than nothing.
 *
 * **The input is not mutated.** The caller passes React state, and a builder that
 * wrote into it would corrupt the panel that is still rendering it.
 *
 * **Absence stays absent.** No source Pin means no reference image — never a
 * placeholder, never an empty-string entry that downstream code treats as a URL.
 *
 * Exit code 0 = all pass, 1 = failures.
 */

import { buildPrefillFromInsight } from "../src/lib/createPinsPrefill";

let passed = 0, failed = 0;

function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ok   ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`     ${String(e)}`); failed++; }
}

function eq(a: unknown, b: unknown, msg?: string): void {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }
function includes(str: string, sub: string): void {
  if (!str.includes(sub)) throw new Error(`Expected "${sub}" in:\n${str}`);
}

// -- Fixtures ----------------------------------------------------------------
// Text arrives already rendered to the reader's language: the builder never reads
// a catalogue, which is why these are sentences and not keys.

const ACCOUNT_INPUT = {
  connectionId: "conn-abc",
  accountUsername: "quietspaces",
  category: "home decor",
  keyword: "small bedroom ideas",
  recommendation: {
    keep: "Your close-up styling shots, which people save most.",
    change: { variable: "Call to action", phrasing: "Ask for one specific next step in the description." },
    test: "Watch outbound clicks over the next 30 days.",
  },
};

const SCORECARD_INPUT = {
  connectionId: "conn-xyz",
  recommendation: {
    keep: "This account gets seen more than it gets clicked.",
    change: { variable: "First image", phrasing: "Fewer people left for your site than for the middle Pin of its group." },
    test: "Publish a variant that changes only that one thing.",
  },
  sourcePin: {
    imageUrl: "https://img.example/pin-1.jpg",
    title: "Tiny bedroom, big storage",
    pinId: "pin-1",
    draftId: "draft-1",
    boardId: "board-9",
    boardName: "Bedrooms",
  },
};

// -- Account-level shape -----------------------------------------------------

test("1. account-level: source is insights", () => {
  eq(buildPrefillFromInsight(ACCOUNT_INPUT).source, "insights");
});

test("2. account-level: opportunity titled by keyword, carries keyword + category", () => {
  const p = buildPrefillFromInsight(ACCOUNT_INPUT);
  eq(p.opportunity?.title, "small bedroom ideas");
  eq(p.opportunity?.keyword, "small bedroom ideas");
  eq(p.opportunity?.category, "home decor");
});

test("3. title falls back to category, then to a literal", () => {
  const noKeyword = buildPrefillFromInsight({ ...ACCOUNT_INPUT, keyword: undefined });
  eq(noKeyword.opportunity?.title, "home decor");
  const neither = buildPrefillFromInsight({ ...ACCOUNT_INPUT, keyword: undefined, category: undefined });
  eq(neither.opportunity?.title, "Insights recommendation");
});

test("4. evidenceSentence is one line carrying Keep / Change / Test", () => {
  const line = buildPrefillFromInsight(ACCOUNT_INPUT).opportunity?.evidenceSentence ?? "";
  ok(!line.includes("\n"), `evidenceSentence must be one line, got:\n${line}`);
  includes(line, "Keep:");
  includes(line, "Change:");
  includes(line, "Test:");
  includes(line, "Call to action");
});

test("5. defaultDestination points at the account the reading is about", () => {
  const d = buildPrefillFromInsight(ACCOUNT_INPUT).defaultDestination;
  eq(d?.provider, "pinterest");
  eq(d?.socialConnectionId, "conn-abc");
  eq(d?.boardId, undefined);
});

// -- The named variable ------------------------------------------------------

test("6. change.variable appears in the creative brief", () => {
  const brief = buildPrefillFromInsight(ACCOUNT_INPUT).creativeDirectionSeed ?? "";
  includes(brief, "Call to action");
});

test("7. brief says everything else stays, so the result is attributable", () => {
  const brief = buildPrefillFromInsight(ACCOUNT_INPUT).creativeDirectionSeed ?? "";
  includes(brief, "one variable");
  ok(/everything else/i.test(brief), `Brief must hold the rest fixed:\n${brief}`);
});

test("7b. a caller sentence that already ends in a full stop does not double it", () => {
  // The recommendation text is rendered for a human first, so it arrives punctuated;
  // splicing it into a longer sentence is exactly where "description.." comes from.
  const p = buildPrefillFromInsight(ACCOUNT_INPUT);
  ok(!(p.creativeDirectionSeed ?? "").includes(".."), `Doubled terminator in brief:\n${p.creativeDirectionSeed}`);
  const line = p.opportunity?.evidenceSentence ?? "";
  ok(!line.includes(".."), `Doubled terminator in evidenceSentence:\n${line}`);
});

test("8. brief is 2-4 sentences", () => {
  const brief = buildPrefillFromInsight(ACCOUNT_INPUT).creativeDirectionSeed ?? "";
  const sentences = brief.split(/(?<=[.!?])\s+/).filter(part => part.trim().length > 0);
  ok(sentences.length >= 2 && sentences.length <= 4, `Expected 2-4 sentences, got ${sentences.length}:\n${brief}`);
});

// -- Scorecard shape ---------------------------------------------------------

test("9. scorecard: source Pin becomes the reference image", () => {
  const p = buildPrefillFromInsight(SCORECARD_INPUT);
  eq(p.pinReferences?.length, 1);
  eq(p.pinReferences?.[0].imageUrl, "https://img.example/pin-1.jpg");
  eq(p.pinReferences?.[0].source, "recent");
  eq(p.pinReferences?.[0].id, "pin-1");
  eq(p.pinReferences?.[0].title, "Tiny bedroom, big storage");
});

test("10. scorecard: the Pin's board rides along on the destination", () => {
  const d = buildPrefillFromInsight(SCORECARD_INPUT).defaultDestination;
  eq(d?.socialConnectionId, "conn-xyz");
  eq(d?.boardId, "board-9");
  eq(d?.boardName, "Bedrooms");
});

test("11. scorecard with no keyword or category still names its variable", () => {
  const brief = buildPrefillFromInsight(SCORECARD_INPUT).creativeDirectionSeed ?? "";
  includes(brief, "First image");
});

// -- Absence -----------------------------------------------------------------

test("12. no sourcePin - no pinReferences key at all", () => {
  const p = buildPrefillFromInsight(ACCOUNT_INPUT);
  eq(p.pinReferences, undefined, "A recommendation with no Pin must not carry references");
});

test("13. sourcePin without an image - no pinReferences", () => {
  const p = buildPrefillFromInsight({ ...SCORECARD_INPUT, sourcePin: { pinId: "pin-2", boardId: "board-3" } });
  eq(p.pinReferences, undefined);
  eq(p.defaultDestination?.boardId, "board-3", "The board is still known even without an image");
});

test("14. blank image string is treated as absent, not as a URL", () => {
  const p = buildPrefillFromInsight({ ...SCORECARD_INPUT, sourcePin: { ...SCORECARD_INPUT.sourcePin, imageUrl: "   " } });
  eq(p.pinReferences, undefined);
});

// -- Purity ------------------------------------------------------------------

test("15. input is not mutated (account-level)", () => {
  const before = JSON.stringify(ACCOUNT_INPUT);
  buildPrefillFromInsight(ACCOUNT_INPUT);
  eq(JSON.stringify(ACCOUNT_INPUT), before, "Builder wrote into its input");
});

test("16. input is not mutated (scorecard, nested sourcePin)", () => {
  const before = JSON.stringify(SCORECARD_INPUT);
  const p = buildPrefillFromInsight(SCORECARD_INPUT);
  // Even mutating the OUTPUT must not reach back into the input.
  if (p.pinReferences) p.pinReferences[0].imageUrl = "https://img.example/changed.jpg";
  if (p.defaultDestination) p.defaultDestination.boardId = "board-changed";
  eq(JSON.stringify(SCORECARD_INPUT), before, "Output shares structure with its input");
});

test("17. a frozen input is accepted", () => {
  const frozen = Object.freeze({
    ...ACCOUNT_INPUT,
    recommendation: Object.freeze({
      ...ACCOUNT_INPUT.recommendation,
      change: Object.freeze({ ...ACCOUNT_INPUT.recommendation.change }),
    }),
  });
  const p = buildPrefillFromInsight(frozen);
  eq(p.source, "insights");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
