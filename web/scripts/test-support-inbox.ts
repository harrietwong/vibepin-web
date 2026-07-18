#!/usr/bin/env tsx
/**
 * test-support-inbox.ts
 *
 * Verifies the pure, network-free core of the admin Support Inbox:
 * escalation-reason -> Chinese label mapping, inbox-tab -> escalation_state
 * filter mapping, and the high-risk-reply detector (PRD §7.3).
 *
 * Run: npx tsx scripts/test-support-inbox.ts
 * Exit 0 = all pass, 1 = failures.
 */

import { escalationReasonLabelZh, escalationStatesForInboxTab, isHighRiskReply } from "../src/lib/support/inboxCore";

// ── Mini test runner (matches scripts/test-support-metrics.ts) ─────────────

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
  if (actual !== expected) throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function arrEq(actual: string[] | undefined, expected: string[] | undefined, msg?: string): void {
  const a = actual ? JSON.stringify(actual) : "undefined";
  const b = expected ? JSON.stringify(expected) : "undefined";
  if (a !== b) throw new Error(msg ?? `Expected ${b}, got ${a}`);
}

console.log("\n── escalationReasonLabelZh ──");

test("1. known reasons map to their Chinese label", () => {
  eq(escalationReasonLabelZh("refund_request"), "退款请求");
  eq(escalationReasonLabelZh("duplicate_charge"), "重复扣费");
  eq(escalationReasonLabelZh("credits_charged_no_result"), "扣费无结果");
  eq(escalationReasonLabelZh("account_security"), "账户安全");
  eq(escalationReasonLabelZh("data_deletion"), "数据删除");
  eq(escalationReasonLabelZh("user_requested_human"), "用户要求人工");
  eq(escalationReasonLabelZh("cannot_answer"), "AI无法解答");
});

test("2. null/undefined -> em dash placeholder", () => {
  eq(escalationReasonLabelZh(null), "—");
  eq(escalationReasonLabelZh(undefined), "—");
});

test("3. unrecognized reason falls back to the raw string (never disappears)", () => {
  eq(escalationReasonLabelZh("some_new_reason"), "some_new_reason");
});

console.log("\n── escalationStatesForInboxTab ──");

test("4. pending -> needs_email_reply + email_failed", () => {
  arrEq(escalationStatesForInboxTab("pending"), ["needs_email_reply", "email_failed"]);
});

test("5. failed -> email_failed only", () => {
  arrEq(escalationStatesForInboxTab("failed"), ["email_failed"]);
});

test("6. sent -> email_sent only", () => {
  arrEq(escalationStatesForInboxTab("sent"), ["email_sent"]);
});

test("7. all / null / unrecognized -> undefined (no filter)", () => {
  arrEq(escalationStatesForInboxTab("all"), undefined);
  arrEq(escalationStatesForInboxTab(null), undefined);
  arrEq(escalationStatesForInboxTab(undefined), undefined);
  arrEq(escalationStatesForInboxTab("bogus"), undefined);
});

console.log("\n── isHighRiskReply ──");

test("8. billing_or_subscription category is high-risk regardless of text", () => {
  eq(isHighRiskReply({ category: "billing_or_subscription", draftText: "hello" }), true);
});

test("9. credits_issue category is high-risk", () => {
  eq(isHighRiskReply({ category: "credits_issue" }), true);
});

test("10. refund_request / duplicate_charge / credits_charged_no_result / data_deletion / account_security reasons are high-risk", () => {
  eq(isHighRiskReply({ escalationReason: "refund_request" }), true);
  eq(isHighRiskReply({ escalationReason: "duplicate_charge" }), true);
  eq(isHighRiskReply({ escalationReason: "credits_charged_no_result" }), true);
  eq(isHighRiskReply({ escalationReason: "data_deletion" }), true);
  eq(isHighRiskReply({ escalationReason: "account_security" }), true);
});

test("11. user_requested_human / cannot_answer reasons are NOT inherently high-risk", () => {
  eq(isHighRiskReply({ escalationReason: "user_requested_human" }), false);
  eq(isHighRiskReply({ escalationReason: "cannot_answer" }), false);
});

test("12. Chinese draft keywords (退款/扣费/扣款/删除) trigger high-risk", () => {
  eq(isHighRiskReply({ draftText: "我们会为您退款" }), true);
  eq(isHighRiskReply({ draftText: "扣费金额已核实" }), true);
  eq(isHighRiskReply({ draftText: "扣款记录如下" }), true);
  eq(isHighRiskReply({ draftText: "已删除您的数据" }), true);
});

test("13. English draft keywords (refund/charge) trigger high-risk, case-insensitive", () => {
  eq(isHighRiskReply({ draftText: "We issued a Refund" }), true);
  eq(isHighRiskReply({ draftText: "The CHARGE was reversed" }), true);
});

test("14. benign category/reason/text -> not high-risk", () => {
  eq(isHighRiskReply({ category: "publishing_issue", escalationReason: "cannot_answer", draftText: "请重新连接 Pinterest" }), false);
});

test("15. empty input -> not high-risk", () => {
  eq(isHighRiskReply({}), false);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
