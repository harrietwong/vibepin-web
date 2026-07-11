#!/usr/bin/env tsx
/**
 * test-support-translator.ts
 *
 * Verifies the pure, network-free parsers in translator.ts
 * (parseTranslateToZhOutput, parseTranslationOutput) handle valid JSON,
 * fenced JSON, garbage, and missing-fields cases correctly.
 *
 * Run: npx tsx scripts/test-support-translator.ts
 * Exit 0 = all pass, 1 = failures.
 */

import { parseTranslateToZhOutput, parseTranslationOutput } from "../src/lib/support/translator";

// ── Mini test runner (matches scripts/test-support-ai-responder.ts) ────────
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${String(e)}`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected)
    throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

console.log("\n── parseTranslateToZhOutput ──");

test("1. valid JSON parses language + translation", () => {
  const result = parseTranslateToZhOutput('{"language": "es", "translation": "No puedo conectar Pinterest."}');
  ok(result !== null, "must not be null");
  eq(result?.detectedLanguage, "es");
  eq(result?.zh, "No puedo conectar Pinterest.");
});

test("2. fenced JSON (```json ... ```) is unwrapped and parsed", () => {
  const raw = "```json\n{\"language\": \"zh\", \"translation\": \"无法连接 Pinterest。\"}\n```";
  const result = parseTranslateToZhOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.detectedLanguage, "zh");
  eq(result?.zh, "无法连接 Pinterest。");
});

test("3. plain-fenced (``` ... ``` with no 'json' tag) is also unwrapped", () => {
  const raw = "```\n{\"language\": \"en\", \"translation\": \"你好\"}\n```";
  const result = parseTranslateToZhOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.detectedLanguage, "en");
});

test("4. garbage / non-JSON text returns null", () => {
  eq(parseTranslateToZhOutput("Sorry, I can't translate that right now."), null);
});

test("5. empty string returns null", () => {
  eq(parseTranslateToZhOutput(""), null);
});

test("6. JSON missing language entirely returns null (structurally invalid)", () => {
  const result = parseTranslateToZhOutput('{"translation": "some text"}');
  eq(result, null);
});

test("7. JSON missing translation defaults to empty string rather than null", () => {
  const result = parseTranslateToZhOutput('{"language": "fr"}');
  ok(result !== null, "must not be null");
  eq(result?.detectedLanguage, "fr");
  eq(result?.zh, "");
});

test("8. extra prose around a JSON object is tolerated by outer-brace slicing", () => {
  const raw = 'Here is the translation:\n{"language": "ja", "translation": "こんにちは"}\nHope that helps!';
  const result = parseTranslateToZhOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.detectedLanguage, "ja");
  eq(result?.zh, "こんにちは");
});

console.log("\n── parseTranslationOutput ──");

test("9. valid JSON returns the translation string", () => {
  eq(parseTranslationOutput('{"translation": "Hola, gracias por contactarnos."}'), "Hola, gracias por contactarnos.");
});

test("10. fenced JSON is unwrapped and parsed", () => {
  const raw = "```json\n{\"translation\": \"Merci de nous avoir contactés.\"}\n```";
  eq(parseTranslationOutput(raw), "Merci de nous avoir contactés.");
});

test("11. garbage / non-JSON text returns null", () => {
  eq(parseTranslationOutput("I can't help with that."), null);
});

test("12. empty string returns null", () => {
  eq(parseTranslationOutput(""), null);
});

test("13. JSON missing translation field returns null", () => {
  eq(parseTranslationOutput('{"language": "es"}'), null);
});

test("14. non-string translation field returns null", () => {
  eq(parseTranslationOutput('{"translation": 123}'), null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
