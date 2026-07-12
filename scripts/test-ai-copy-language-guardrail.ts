import assert from "node:assert/strict";
import {
  languageInstructions,
  buildFastPathPrompt,
  buildVisionPrompt,
  buildContextBlock,
  type FastPathPromptArgs,
  type VisionPromptArgs,
} from "../src/lib/ai-copy/visionServer";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK ${name}`);
}

const EN_KEYWORD = "Luxury Bedroom Ideas Aesthetic";

// ── languageInstructions() ───────────────────────────────────────────────────────

test("languageInstructions: target=English states English explicitly regardless of source language", () => {
  const lines = languageInstructions("en").join("\n");
  assert.match(lines, /Target output language: en/);
  assert.match(lines, /Write the title, description, altText, and keywords entirely in this language/);
});

test("languageInstructions: target=Chinese requires translation/paraphrase, not verbatim echo", () => {
  const lines = languageInstructions("zh-CN").join("\n");
  assert.match(lines, /Target output language: zh-CN/);
  assert.match(lines, /Translate or naturally paraphrase/);
  assert.match(lines, /never copy a raw source-language phrase verbatim/i);
});

test("languageInstructions: brand/product/platform names are the explicit exception", () => {
  const lines = languageInstructions("zh-CN").join("\n");
  assert.match(lines, /brand names, product names, platform names, and other proper nouns may stay exactly as originally written/);
});

test("languageInstructions: defaults to English when language is missing", () => {
  const lines = languageInstructions(undefined).join("\n");
  assert.match(lines, /Target output language: en/);
});

// ── buildFastPathPrompt() ─────────────────────────────────────────────────────────

const baseFastArgs: FastPathPromptArgs = {
  analysis: {
    imageSummary: "A cozy bedroom with a beige upholstered bed and warm wood nightstand.",
    visibleObjects: ["upholstered bed", "wood nightstand", "linen curtains"],
    colors: ["beige", "warm wood"],
    style: "modern minimalist",
  },
  recommendedKeywords: [],
  boardName: "Bedroom Ideas",
  category: EN_KEYWORD, // English opportunity/keyword phrase, sourced regardless of target language
  language: "en",
  mode: "initial",
};

test("fast path: target=English, English category source → prompt still instructs English output", () => {
  const prompt = buildFastPathPrompt({ ...baseFastArgs, language: "en" });
  assert.match(prompt, /Target output language: en/);
  assert.match(prompt, /reference_keyword_context/);
});

test("fast path: target=Chinese, English category source → prompt requires translation, never verbatim quoting", () => {
  const prompt = buildFastPathPrompt({ ...baseFastArgs, language: "zh-CN" });
  assert.match(prompt, /Target output language: zh-CN/);
  assert.match(prompt, /Translate or naturally paraphrase/);
  // The raw English phrase is present ONLY inside the JSON grounding-context blob
  // (as data, clearly labeled reference_keyword_context) — the instruction line
  // right above it tells the model not to quote it. We assert the guardrail wording
  // is present, not that the source phrase is absent (it must still reach the model
  // as context — just not verbatim in the output).
  assert.match(prompt, /reference_keyword_context/);
  assert.match(prompt, new RegExp(EN_KEYWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("fast path: recommended keywords are framed as concepts to translate, not quote, for non-English targets", () => {
  const prompt = buildFastPathPrompt({ ...baseFastArgs, language: "zh-CN", recommendedKeywords: ["cozy bedroom decor"] });
  assert.match(prompt, /translated\/paraphrased into the target language/);
  assert.match(prompt, /not text to quote verbatim unless the target language is English/);
});

test("fast path: board name context is flagged translate-unless-proper-noun", () => {
  const prompt = buildFastPathPrompt({ ...baseFastArgs, language: "zh-CN" });
  assert.match(prompt, /Board \(context only — translate\/paraphrase unless it is a proper noun\): Bedroom Ideas/);
});

// ── buildVisionPrompt() (vision-fallback path) ────────────────────────────────────

const baseVisionArgs: VisionPromptArgs = {
  contextBlock: buildContextBlock({
    productContext: { title: "Acme Nightstand", category: EN_KEYWORD },
    pageContext: {},
    boardContext: { name: "Bedroom Ideas" },
    keywords: ["cozy bedroom decor"],
    category: EN_KEYWORD,
  }),
  language: "en",
  mode: "initial",
};

test("vision path: target=English still explicitly requires English output", () => {
  const prompt = buildVisionPrompt({ ...baseVisionArgs, language: "en" });
  assert.match(prompt, /Target output language: en/);
});

test("vision path: target=Chinese requires translation/paraphrase of category+keyword context", () => {
  const prompt = buildVisionPrompt({ ...baseVisionArgs, language: "zh-CN" });
  assert.match(prompt, /Target output language: zh-CN/);
  assert.match(prompt, /Translate or naturally paraphrase/);
});

test("buildContextBlock: product/brand name allowed to stay original; category/keywords marked do-not-quote", () => {
  const block = buildContextBlock({
    productContext: { title: "Acme Nightstand", category: EN_KEYWORD },
    pageContext: {},
    boardContext: { name: "Bedroom Ideas" },
    keywords: ["cozy bedroom decor"],
    category: EN_KEYWORD,
  });
  assert.match(block, /Product \(name may stay as originally written; translate the category concept\): Acme Nightstand/);
  assert.match(block, /Reference keyword context \(do not quote verbatim — translate\/paraphrase into the target language\): Luxury Bedroom Ideas Aesthetic/);
  assert.match(block, /Related keyword context \(do not quote verbatim — translate\/paraphrase into the target language\): cozy bedroom decor/);
});

console.log(`\nAll ${passed} AI-copy language-guardrail tests passed.`);
