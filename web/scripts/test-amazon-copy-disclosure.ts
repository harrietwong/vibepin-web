/**
 * T3 (Amazon URL → copy) — server-side affiliate disclosure + 500-char budget.
 *
 * Exercises the REAL orchestrator (`orchestrateCopyGeneration`) and the REAL v2
 * validator with a mock provider:
 *  - flag on  → description ends with "#ad", length ≤ 500 (design §3.4)
 *  - already disclosed → not duplicated
 *  - flag off → provider output and prompt byte-identical to pre-T3 behaviour
 *  - 499-char boundary: no truncation; DESCRIPTION_TOO_LONG → repair (repair sees the
 *    RAW text, never our #ad) → re-append → valid; still too long → 422
 *  - non-English content gets the same "#ad" (ruling 7)
 *
 * Run: npx tsx scripts/test-amazon-copy-disclosure.ts
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

import assert from "node:assert/strict";
import type { CopyGenerationProvider, GenerateCopyRequest, ProviderCopyOutput } from "../src/lib/ai-copy/v2/orchestrator";
import type { FactCardV1, KeywordEvidence, ValidationReport } from "../src/lib/ai-copy/v2/types";

let passed = 0, failed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}\n    ${(error as Error).stack}`); }
}

/** Deterministic filler of exactly `n` chars, no stuffing (never 3 identical words in a row). */
function filler(n: number): string {
  const words = ["calm", "reading", "corner", "with", "warm", "neutral", "details", "for", "slow", "evenings"];
  let out = "", i = 0;
  while (out.length < n) { out += (out ? " " : "") + words[i % words.length]; i++; }
  return out.slice(0, n).trimEnd().padEnd(n, "x");
}

function factCard(locale = "en"): FactCardV1 {
  return { version: "fact-card-v1", sessionId: "s", draftId: "d", locale, facts: [] };
}
const evidence: KeywordEvidence = { keywordSetId: "k", sessionId: "s", draftId: "d", candidates: [], selectedKeywordIds: [], degradedMode: "no_keyword_demand_data" } as unknown as KeywordEvidence;

function req(extra: Partial<GenerateCopyRequest> = {}): GenerateCopyRequest {
  return { generationId: "g", sessionId: "s", draftId: "d", factCard: factCard(), keywordEvidence: evidence, ...extra };
}

type Calls = { generatePrompts: string[]; repairInputs: ProviderCopyOutput[]; repairReports: ValidationReport[]; repairPrompts: string[] };
function provider(outputs: { generate: ProviderCopyOutput; repair?: ProviderCopyOutput[] }, calls: Calls): CopyGenerationProvider {
  const repairs = [...(outputs.repair ?? [])];
  return {
    async generate(prompt: string) { calls.generatePrompts.push(prompt); return { ...outputs.generate }; },
    async detectClaims() { return { claims: [] }; },
    async repair(original: ProviderCopyOutput, report: ValidationReport, prompt: string) {
      calls.repairInputs.push({ ...original }); calls.repairReports.push(report); calls.repairPrompts.push(prompt);
      const next = repairs.shift();
      if (!next) throw new Error("unexpected repair");
      return { ...next };
    },
  };
}
const newCalls = (): Calls => ({ generatePrompts: [], repairInputs: [], repairReports: [], repairPrompts: [] });
const out = (description: string): ProviderCopyOutput => ({ title: "Calm Reading Corner", description, altText: "A calm reading corner" });

async function main() {
  const orch = await import("../src/lib/ai-copy/v2/orchestrator");
  const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");
  const disc = await import("../src/lib/ai-copy/affiliateDisclosure");
  const { orchestrateCopyGeneration, buildPromptForSession, __setCopyProviderForTests, ValidationErrorV2, AFFILIATE_PROMPT_LINE } = orch;

  console.log("\n[disclosure helpers]");
  await test("hasAffiliateDisclosure recognises #ad / #affiliate / (paid link), not #adorable", () => {
    assert.equal(disc.hasAffiliateDisclosure("Great lamp #ad"), true);
    assert.equal(disc.hasAffiliateDisclosure("#AD great lamp"), true);
    assert.equal(disc.hasAffiliateDisclosure("Great lamp #affiliate"), true);
    assert.equal(disc.hasAffiliateDisclosure("Great lamp (paid link)"), true);
    assert.equal(disc.hasAffiliateDisclosure("An #adorable lamp"), false);
    assert.equal(disc.hasAffiliateDisclosure("Great lamp"), false);
    assert.equal(disc.hasAffiliateDisclosure(""), false);
  });
  await test("appendAffiliateDisclosure: end placement, single space, idempotent, never truncates", () => {
    assert.equal(disc.appendAffiliateDisclosure("Great lamp.  "), "Great lamp. #ad");
    assert.equal(disc.appendAffiliateDisclosure("Great lamp #ad"), "Great lamp #ad");
    assert.equal(disc.appendAffiliateDisclosure("Great lamp", "paid_link"), "Great lamp (paid link)");
    assert.equal(disc.appendAffiliateDisclosure(""), "#ad");
    const long = filler(499);
    assert.equal(disc.appendAffiliateDisclosure(long).length, 503, "append never cuts the body");
  });
  await test("budget excludes the marker and its space", () => {
    assert.equal(disc.affiliateDescriptionBudget("ad_hashtag"), 496);
    assert.equal(disc.affiliateDescriptionBudget("paid_link"), 488);
    assert.equal(disc.isAffiliateDisclosureKind("ad_hashtag"), true);
    assert.equal(disc.isAffiliateDisclosureKind("hashtag"), false);
  });

  console.log("\n[orchestrator: flag on]");
  await test("flag on: description ends with #ad and is ≤ 500", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out("Create a calm reading corner with warm neutral details.") }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.ok(r.description.endsWith(" #ad"), r.description);
    assert.ok(r.description.length <= 500);
    assert.equal(r.description, "Create a calm reading corner with warm neutral details. #ad");
    assert.equal(r.validationReport.valid, true);
  });
  await test("flag on: an existing disclosure is not duplicated", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out("Cozy corner idea #ad for slow evenings.") }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(r.description, "Cozy corner idea #ad for slow evenings.");
    assert.equal((r.description.match(/#ad\b/gi) ?? []).length, 1);
  });
  await test("flag on + non-English locale: same #ad marker (ruling 7)", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out("Ein ruhiger Leseplatz mit warmen Details.") }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag", factCard: factCard("de") }));
    assert.ok(r.description.endsWith(" #ad"));
  });
  await test("flag on: prompt carries the Amazon line and the reduced description cap", () => {
    const p = buildPromptForSession(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.ok(p.includes(AFFILIATE_PROMPT_LINE));
    assert.ok(p.includes("counted in characters (not words) including spaces and punctuation: title 100, description 496."), p);
    const seo = buildPromptForSession(req({ affiliateDisclosure: "ad_hashtag", lengthPreference: "seo-rich" }));
    assert.ok(seo.includes("description 321-421 characters"), "seo-rich guide stays well under the 496 cap (P1 0925)");
    assert.ok(!seo.includes("400-700"));
  });

  await test("P1 0925: every prompt states the verbatim-wording rule and a character (not word) unit, targets under the cap", () => {
    for (const r of [req(), req({ affiliateDisclosure: "ad_hashtag" })]) {
      for (const lengthPreference of ["short", "standard", "seo-rich"] as const) {
        const p = buildPromptForSession({ ...r, lengthPreference });
        assert.ok(p.includes(orch.GROUNDED_WORDING_LINE), "grounded wording line");
        assert.ok(p.includes("counted in characters (not words)"), "unit stated");
        const cap = orch.descriptionBudgetFor(r);
        const upper = Number(/description \d+-(\d+) characters/.exec(p)?.[1]);
        assert.ok(upper > 0 && upper <= Math.floor(cap * 0.85), `${lengthPreference}: target upper ${upper} vs cap ${cap}`);
      }
    }
  });

  console.log("\n[orchestrator: 500 budget boundary]");
  await test("496-char body + ' #ad' = exactly 500 → valid without repair", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(filler(496)) }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(r.description.length, 500);
    assert.equal(calls.repairInputs.length, 0);
  });
  await test("499-char body → 503 → DESCRIPTION_TOO_LONG → repair on RAW text → shorter → valid, ends #ad", async () => {
    const calls = newCalls();
    const shorter = filler(300);
    __setCopyProviderForTests(provider({ generate: out(filler(499)), repair: [out(shorter)] }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(calls.repairInputs.length, 1, "one repair");
    assert.ok(calls.repairReports[0].issues.some(i => i.code === "DESCRIPTION_TOO_LONG"), "repair reason is length");
    // T4 (deviation 3): the repair model sees the RAW text, so it is held to the RAW
    // budget (496), and its prompt states that number explicitly.
    assert.ok(calls.repairReports[0].issues.some(i => i.code === "DESCRIPTION_TOO_LONG" && i.message.includes("(499) exceeds maximum of 496")), JSON.stringify(calls.repairReports[0].issues));
    assert.ok(calls.repairPrompts[0].includes("must be at most 496 characters"), "repair prompt carries the raw budget");
    assert.equal(disc.hasAffiliateDisclosure(calls.repairInputs[0].description), false, "repair never sees our #ad");
    assert.equal(calls.repairInputs[0].description.length, 499, "repair got the untruncated raw text");
    assert.equal(r.description, `${shorter} #ad`);
    assert.ok(r.description.length <= 500);
  });
  await test("499-char body and repair still too long → 422 (no silent truncation)", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(filler(499)), repair: [out(filler(498))] }, calls));
    await assert.rejects(orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" })), (error: unknown) => {
      assert.ok(error instanceof ValidationErrorV2);
      assert.equal((error as InstanceType<typeof ValidationErrorV2>).status, 422);
      assert.ok((error as InstanceType<typeof ValidationErrorV2>).validationReport.issues.some(i => i.code === "DESCRIPTION_TOO_LONG"));
      return true;
    });
  });

  console.log("\n[T4: deviation 3 — repair held to the raw budget; 499/500 boundaries]");
  await test("497-char body → 501 shipped → too long; repair report states 497 vs 496 (not 500)", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(filler(497)), repair: [out(filler(496))] }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(calls.repairInputs.length, 1);
    const issue = calls.repairReports[0].issues.find(i => i.code === "DESCRIPTION_TOO_LONG");
    assert.ok(issue && issue.message.includes("(497) exceeds maximum of 496"), issue?.message);
    assert.equal(r.description.length, 500, "496 raw + ' #ad' = 500 exactly");
  });
  await test("final description of 499 chars (495 raw + ' #ad') is valid, no repair", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(filler(495)) }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(r.description.length, 499);
    assert.equal(calls.repairInputs.length, 0);
  });
  await test("model already disclosed: 500 chars incl. its own #ad is valid (no double append)", async () => {
    const calls = newCalls();
    const text = `${filler(496)} #ad`;
    __setCopyProviderForTests(provider({ generate: out(text) }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(r.description, text);
    assert.equal(r.description.length, 500);
    assert.equal(calls.repairInputs.length, 0);
  });
  await test("model already disclosed: 501 chars → too long → repair → ships ≤ 500 with #ad", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(`${filler(497)} #ad`), repair: [out(filler(400))] }, calls));
    const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
    assert.equal(calls.repairInputs.length, 1);
    assert.ok(r.description.length <= 500 && r.description.endsWith(" #ad"));
  });
  await test("any repair that honours the stated budget ships ≤ 500 (sweep 480..496)", async () => {
    for (let n = 480; n <= 496; n++) {
      const calls = newCalls();
      __setCopyProviderForTests(provider({ generate: out(filler(499)), repair: [out(filler(n))] }, calls));
      const r = await orchestrateCopyGeneration(req({ affiliateDisclosure: "ad_hashtag" }));
      assert.ok(r.description.length <= 500, `raw ${n} → ${r.description.length}`);
    }
  });
  await test("flag off: repair report unchanged; repair prompt adds only the shorten-only length line", async () => {
    const calls = newCalls();
    __setCopyProviderForTests(provider({ generate: out(filler(801)), repair: [out(filler(300))] }, calls));
    await orchestrateCopyGeneration(req());
    assert.ok(calls.repairReports[0].issues.some(i => i.message.includes("(801) exceeds maximum of 800")));
    assert.ok(calls.repairPrompts[0].startsWith(calls.generatePrompts[0]), "flag-off repair prompt extends the generate prompt");
    assert.ok(calls.repairPrompts[0].includes("The previous description was 801 characters. Shorten it to at most 680 characters (hard limit 800)"), calls.repairPrompts[0]);
    assert.ok(!calls.repairPrompts[0].includes("server appends the disclosure"), "no affiliate line when flag off");
  });

  console.log("\n[orchestrator: flag off regression]");
  await test("flag off: output is the provider text byte-for-byte (no #ad), 800 cap unchanged", async () => {
    const calls = newCalls();
    const text = filler(700);
    __setCopyProviderForTests(provider({ generate: out(text) }, calls));
    const r = await orchestrateCopyGeneration(req());
    assert.equal(r.description, text);
    assert.equal(calls.repairInputs.length, 0, "700 chars is fine under the default 800 cap");
  });
  await test("flag off: prompt has no Amazon line and the original limits", () => {
    const p = buildPromptForSession(req());
    assert.ok(!p.includes("Amazon"));
    assert.ok(p.includes("title 100, description 800."));
    const seo = buildPromptForSession(req({ lengthPreference: "seo-rich" }));
    assert.ok(seo.includes("title 70-95 characters, description 350-680 characters"));
  });

  console.log("\n[validateCopy descriptionMax]");
  await test("default max stays 800; explicit 500 flags a 501-char description", () => {
    const base = { title: "Calm Reading Corner", altText: "alt", factCard: factCard(), claimDetection: { status: "completed" as const, claims: [] } };
    assert.equal(validateCopy({ ...base, description: filler(600) }).valid, true);
    assert.equal(validateCopy({ ...base, description: filler(500), descriptionMax: 500 }).valid, true);
    const r = validateCopy({ ...base, description: filler(501), descriptionMax: 500 });
    assert.ok(r.issues.some(i => i.code === "DESCRIPTION_TOO_LONG"));
  });

  __setCopyProviderForTests(null);
  console.log(`\nAmazon copy disclosure: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
