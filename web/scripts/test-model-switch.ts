/**
 * Source-level test for the Create Pins model switch (GPT Image / Gemini Image).
 * Run: npx tsx scripts/test-model-switch.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const requestRoute = readFileSync(join(process.cwd(), "src/app/api/generate/route.ts"), "utf8");

let passed = 0, failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK   ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

console.log("\n=== Model switch (frontend) ===\n");

// E — dropdown exposes Gemini Image with the gemini_image key
assert("E: MODEL_OPTIONS includes gemini_image", /value:\s*"gemini_image"/.test(page));
assert("E: Gemini Image label shown (no raw API model name)", /label:\s*"Gemini Image"/.test(page));
assert("E: no raw provider model id leaked in dropdown labels",
  !/label:\s*"gemini-[\d.]/i.test(page) && !/label:\s*"gpt-image-\d/i.test(page));

// F — GPT Image still present
assert("F: MODEL_OPTIONS still includes gpt_image", /value:\s*"gpt_image"/.test(page));
assert("F: GPT Image label present", /label:\s*"GPT Image"/.test(page));

// The selected model key is what gets sent (not hard-coded gpt_image)
assert("selected model flows into snapshot (modelKey: model)", /modelKey:\s*model/.test(page));
assert("generation sends snapshot model key", /modelKey:\s*snap\.modelKey/.test(page));
assert("requestGenerate forwards model_key from input", /model_key:\s*input\.modelKey/.test(page));

// Route forwards model_key to the generator
assert("route reads model_key from body", /body\.model_key/.test(requestRoute));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
