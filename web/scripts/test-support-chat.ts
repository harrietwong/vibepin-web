#!/usr/bin/env tsx
/**
 * test-support-chat.ts
 *
 * Verifies parseChatReplyOutput (the pure, network-free half of the
 * multi-turn AI chat responder) and resolveEscalationReason (the pure
 * escalation-reason defaulting rule). DB-level guarantees (idempotency_key
 * uniqueness on support_emails, RLS, etc.) are enforced by the migration's
 * SQL constraints and are intentionally NOT covered here — this is a
 * network-free unit suite (matches scripts/test-support-ai-responder.ts).
 *
 * Run: npx tsx scripts/test-support-chat.ts
 * Exit 0 = all pass, 1 = failures.
 */

import { parseChatReplyOutput } from "../src/lib/support/chatResponder";
import { resolveEscalationReason } from "../src/lib/support/escalationCore";

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

console.log("\n── parseChatReplyOutput ──");

test("1. valid JSON, canAnswer=true, shouldEscalate=false parses verbatim", () => {
  const result = parseChatReplyOutput(
    '{"reply":"Try reconnecting Pinterest in Settings.","canAnswer":true,"category":"pinterest_connection_issue","shouldEscalate":false,"escalationReason":null}',
  );
  ok(result !== null, "must not be null");
  eq(result?.reply, "Try reconnecting Pinterest in Settings.");
  eq(result?.canAnswer, true);
  eq(result?.category, "pinterest_connection_issue");
  eq(result?.shouldEscalate, false);
  eq(result?.escalationReason, null);
});

test("2. fenced JSON (```json ... ```) is unwrapped and parsed", () => {
  const raw = '```json\n{"reply":"ok","canAnswer":true,"category":"other","shouldEscalate":false,"escalationReason":null}\n```';
  const result = parseChatReplyOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.reply, "ok");
});

test("3. plain-fenced (``` ... ``` with no 'json' tag) is also unwrapped", () => {
  const raw = '```\n{"reply":"","canAnswer":false,"category":"other","shouldEscalate":false,"escalationReason":null}\n```';
  const result = parseChatReplyOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.canAnswer, false);
});

test("4. garbage / non-JSON text returns null", () => {
  eq(parseChatReplyOutput("Sorry, I can't help with that right now."), null);
});

test("5. empty string returns null", () => {
  eq(parseChatReplyOutput(""), null);
});

test("6. missing canAnswer (control-flow field) is a hard failure -> null", () => {
  const result = parseChatReplyOutput('{"reply":"x","category":"other","shouldEscalate":false,"escalationReason":null}');
  eq(result, null);
});

test("7. missing shouldEscalate (control-flow field) is a hard failure -> null", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":true,"category":"other","escalationReason":null}');
  eq(result, null);
});

test("8. invalid/unrecognized category falls back to 'other' (documented deviation, not a hard failure)", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":true,"category":"not_a_real_category","shouldEscalate":false,"escalationReason":null}');
  ok(result !== null, "must not be null");
  eq(result?.category, "other");
});

test("9. missing category entirely also falls back to 'other'", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":true,"shouldEscalate":false,"escalationReason":null}');
  ok(result !== null, "must not be null");
  eq(result?.category, "other");
});

test("10. recognized escalationReason passes through verbatim when shouldEscalate=true", () => {
  const result = parseChatReplyOutput('{"reply":"We\'ll follow up by email.","canAnswer":true,"category":"credits_issue","shouldEscalate":true,"escalationReason":"credits_charged_no_result"}');
  ok(result !== null, "must not be null");
  eq(result?.shouldEscalate, true);
  eq(result?.escalationReason, "credits_charged_no_result");
});

test("11. unrecognized escalationReason when shouldEscalate=true falls back to 'cannot_answer' (documented deviation)", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":true,"category":"other","shouldEscalate":true,"escalationReason":"some_made_up_reason"}');
  ok(result !== null, "must not be null");
  eq(result?.escalationReason, "cannot_answer");
});

test("12. escalationReason is forced to null when shouldEscalate=false, even if the model set one", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":true,"category":"other","shouldEscalate":false,"escalationReason":"refund_request"}');
  ok(result !== null, "must not be null");
  eq(result?.escalationReason, null);
});

test("13. extra prose around a JSON object is tolerated by outer-brace slicing", () => {
  const raw = 'Here is the answer:\n{"reply":"Reconnect Pinterest.","canAnswer":true,"category":"pinterest_connection_issue","shouldEscalate":false,"escalationReason":null}\nHope that helps!';
  const result = parseChatReplyOutput(raw);
  ok(result !== null, "must not be null");
  eq(result?.reply, "Reconnect Pinterest.");
});

test("14. non-boolean canAnswer (e.g. string 'true') returns null", () => {
  const result = parseChatReplyOutput('{"reply":"x","canAnswer":"true","category":"other","shouldEscalate":false,"escalationReason":null}');
  eq(result, null);
});

console.log("\n── resolveEscalationReason ──");

test("15. explicit reason passes through trimmed", () => {
  eq(resolveEscalationReason("  refund_request  "), "refund_request");
});

test("16. undefined defaults to user_requested_human", () => {
  eq(resolveEscalationReason(undefined), "user_requested_human");
});

test("17. null defaults to user_requested_human", () => {
  eq(resolveEscalationReason(null), "user_requested_human");
});

test("18. empty/whitespace-only string defaults to user_requested_human", () => {
  eq(resolveEscalationReason("   "), "user_requested_human");
  eq(resolveEscalationReason(""), "user_requested_human");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
