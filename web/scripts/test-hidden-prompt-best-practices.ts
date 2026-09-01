/**
 * Unit test for the P0-4 "PINTEREST CREATIVE BEST PRACTICES" section added to
 * hiddenPromptBuilder.ts (0831 feedback-loop research, report §1.3 + §4 P0-4).
 * Asserts the new section is present in the built prompt and that it does not
 * disturb the existing sections around it.
 * Run:  npx tsx scripts/test-hidden-prompt-best-practices.ts   (from web/)
 */
import assert from "node:assert/strict";
import { analyzeProductSet } from "../src/lib/studio/productAnalysis";
import { analyzeReferences } from "../src/lib/studio/referenceAnalysis";
import { inferCreativeIntent } from "../src/lib/studio/creativeIntent";
import { getCategoryPlaybook } from "../src/lib/studio/categoryPlaybooks";
import { buildHiddenPrompt } from "../src/lib/studio/hiddenPromptBuilder";
import {
  getRecommendedCreativeDirections, inferCreativeCategory,
  type SelectedCreativeAsset, type CategoryPlaybookId,
} from "../src/lib/studio/creativeDirections";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

function p(title: string, category?: string): SelectedCreativeAsset {
  return { role: "product", imageUrl: `p:${title}`, source: "upload", title, category, metadataConfidence: "stored" };
}

function buildPrompt(category: string, assets: SelectedCreativeAsset[], format = "2:3") {
  const cat = inferCreativeCategory({ explicitCategory: category, assets }) as CategoryPlaybookId;
  const productSet = analyzeProductSet(assets);
  const references = analyzeReferences(assets, {
    productCategory: cat,
    isCompleteOutfit: productSet.category === "fashion" && productSet.isCoherentSet,
  });
  const intent = inferCreativeIntent({
    category: cat, references, hasProducts: productSet.hasProducts, hasOpportunity: false,
    productSetSummary: productSet.setSummary, primaryProductTitle: productSet.products[0]?.title,
  });
  const directions = getRecommendedCreativeDirections({ category, assets });
  return buildHiddenPrompt({
    direction: directions[0], productSet, references, intent,
    playbook: getCategoryPlaybook(cat), controls: {}, format,
  });
}

console.log("\n=== hiddenPromptBuilder — Pinterest Creative Best Practices (P0-4) ===\n");

const assets = [p("ceramic coffee mug"), p("wool throw blanket")];

{
  const prompt = buildPrompt("home_decor", assets, "2:3");
  check("new section header is present",
    prompt.includes("PINTEREST CREATIVE BEST PRACTICES:"));
  check("mentions the 2:3 / 1000x1500 vertical aspect ratio guidance",
    /2:3/.test(prompt) && /1000x1500/.test(prompt));
  check("mentions the <20% text-overlay guidance",
    /20%/.test(prompt));
  check("mentions large/centered subject + thumbnail legibility",
    /centered/i.test(prompt) && /thumbnail/i.test(prompt));
  check("cites the aspect ratio the caller actually requested (2:3), not a hardcoded value",
    prompt.includes("vertical 2:3 aspect ratio"));
}

{
  // A different requested format still gets the section, referencing THAT format —
  // the section is a general practice reminder, not a format override.
  const prompt = buildPrompt("home_decor", assets, "1:1");
  check("section still appears for a non-default format",
    prompt.includes("PINTEREST CREATIVE BEST PRACTICES:"));
  check("references the caller's actual requested format (1:1) in the guidance line",
    prompt.includes("vertical 1:1 aspect ratio"));
}

{
  // Existing sections must be untouched by the new block: OUTPUT GOAL and STRICTLY
  // AVOID (last two sections) and CATEGORY PLAYBOOK (immediately before the new
  // section) must all still be present and in the same relative order.
  const prompt = buildPrompt("home_decor", assets, "2:3");
  const idxPlaybook = prompt.indexOf("CATEGORY PLAYBOOK:");
  const idxBestPractices = prompt.indexOf("PINTEREST CREATIVE BEST PRACTICES:");
  const idxOutputGoal = prompt.indexOf("OUTPUT GOAL:");
  const idxAvoid = prompt.indexOf("STRICTLY AVOID:");
  check("CATEGORY PLAYBOOK is still present", idxPlaybook !== -1);
  check("OUTPUT GOAL is still present", idxOutputGoal !== -1);
  check("STRICTLY AVOID is still present", idxAvoid !== -1);
  check("new section sits between CATEGORY PLAYBOOK and OUTPUT GOAL",
    idxPlaybook < idxBestPractices && idxBestPractices < idxOutputGoal,
    `playbook=${idxPlaybook} bestPractices=${idxBestPractices} outputGoal=${idxOutputGoal}`);
  check("STRICTLY AVOID remains the final section",
    idxAvoid > idxOutputGoal);
  check("OUTPUT GOAL's zero-text-rule line is unchanged (no text controls selected)",
    prompt.includes("ZERO TEXT RULE: no text, words, letters, numbers, captions, watermarks, logos, or typography anywhere in the image."));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
