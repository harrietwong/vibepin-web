#!/usr/bin/env tsx
/**
 * test-support-ai-responder.ts
 *
 * Verifies parseAiResponderOutput (the pure, network-free half of the AI
 * First Responder) handles valid JSON, fenced JSON, garbage, and
 * canAnswer=false passthrough correctly.
 *
 * Run: npx tsx scripts/test-support-ai-responder.ts
 * Exit 0 = all pass, 1 = failures.
 */

import { parseAiResponderOutput } from "../src/lib/support/aiResponder";

// ── Mini test runner (matches scripts/test-status-normalization.ts) ────────────
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

console.log("\n── parseAiResponderOutput ──");

test("1. valid JSON, canAnswer=true, parses reply verbatim", () => {
  const result = parseAiResponderOutput('{"canAnswer": true, "reply": "Try reconnecting Pinterest in Settings."}');
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, true);
  eq(result?.reply, "Try reconnecting Pinterest in Settings.");
});

test("2. fenced JSON (```json ... ```) is unwrapped and parsed", () => {
  const raw = "```json\n{\"canAnswer\": true, \"reply\": \"Check Settings -> Billing.\"}\n```";
  const result = parseAiResponderOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, true);
  eq(result?.reply, "Check Settings -> Billing.");
});

test("3. plain-fenced (``` ... ``` with no 'json' tag) is also unwrapped", () => {
  const raw = "```\n{\"canAnswer\": false, \"reply\": \"\"}\n```";
  const result = parseAiResponderOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, false);
});

test("4. garbage / non-JSON text returns null", () => {
  const result = parseAiResponderOutput("Sorry, I can't help with that right now.");
  eq(result, null);
});

test("5. empty string returns null", () => {
  eq(parseAiResponderOutput(""), null);
});

test("6. JSON missing canAnswer entirely returns null (structurally invalid)", () => {
  const result = parseAiResponderOutput('{"reply": "some text"}');
  eq(result, null);
});

test("7. canAnswer=false passthrough — reply is preserved even if non-empty", () => {
  // The model is instructed to leave reply empty when canAnswer=false, but the
  // parser itself must not silently coerce/drop it — that's the caller's job
  // (route.ts only posts a message when canAnswer && reply.trim()).
  const result = parseAiResponderOutput('{"canAnswer": false, "reply": "partial thought"}');
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, false);
  eq(result?.reply, "partial thought");
});

test("8. canAnswer=false with empty reply parses cleanly", () => {
  const result = parseAiResponderOutput('{"canAnswer": false, "reply": ""}');
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, false);
  eq(result?.reply, "");
});

test("9. extra prose around a JSON object is tolerated by outer-brace slicing", () => {
  const raw = 'Here is the answer:\n{"canAnswer": true, "reply": "Reconnect Pinterest."}\nHope that helps!';
  const result = parseAiResponderOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, true);
  eq(result?.reply, "Reconnect Pinterest.");
});

test("10. non-boolean canAnswer (e.g. string 'true') returns null", () => {
  const result = parseAiResponderOutput('{"canAnswer": "true", "reply": "x"}');
  eq(result, null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
