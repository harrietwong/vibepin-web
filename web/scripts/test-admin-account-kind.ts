/**
 * Unit tests for the account-kind classifier (src/lib/server/adminAccountKind.ts).
 * Run: npx tsx scripts/test-admin-account-kind.ts   (from web/)
 *
 * The cockpit's default view answers "how are our CUSTOMERS doing", so this
 * classifier decides who is counted at all. Two failure modes matter and both
 * are covered here:
 *
 *   FALSE POSITIVE — a real customer misread as a test account disappears from
 *     the founder's blocker list and never gets helped. This is why the local-part
 *     token match is delimiter-anchored: `contest@`, `attestation@`, `protest@`
 *     must stay customers.
 *   FALSE NEGATIVE — a seed/e2e account counted as a customer inflates every
 *     activation number. The real fixtures (`paddle-e2e-test@vibepin.co` in prod,
 *     `e2e-cockpit-*@example.test` in the test DB) must be caught.
 *
 * Also asserts the trust boundary: `user_metadata` is USER-EDITABLE and must
 * NEVER be able to relabel an account.
 */

import assert from "node:assert";
import { makeHarness } from "./adminMockDb";
import { classifyAccount, isNonCustomer, emptyExcluded, type AccountKind } from "../src/lib/server/adminAccountKind";

const { test, done } = makeHarness();

const ENV = {
  SUPER_ADMIN_EMAILS: "founder@vibepin.co, Second.Founder@vibepin.co",
  SUPPORT_ADMIN_EMAILS: "support@vibepin.co",
  ADMIN_TEST_ACCOUNT_EMAILS: "manual-fixture@vibepin.co",
};

const kindOf = (email: string | null, app_metadata: Record<string, unknown> | null = null, env = ENV): AccountKind =>
  classifyAccount({ email, app_metadata }, env);

// ── internal (allowlists win over everything) ────────────────────────────────

test("internal: email in SUPER_ADMIN_EMAILS", () => {
  assert.equal(kindOf("founder@vibepin.co"), "internal");
});

test("internal: email in SUPPORT_ADMIN_EMAILS", () => {
  assert.equal(kindOf("support@vibepin.co"), "internal");
});

test("internal: allowlist match is case-insensitive on BOTH sides", () => {
  // env entry is mixed-case, input is upper-case, and the entry has stray spaces.
  assert.equal(kindOf("SECOND.FOUNDER@VIBEPIN.CO"), "internal");
});

test("internal WINS over a test-looking address (order matters)", () => {
  // A staff member whose address contains an e2e/test token is still internal —
  // the allowlist is checked FIRST. Swapping the order would hide a founder in
  // the 'test' bucket.
  const env = { ...ENV, SUPER_ADMIN_EMAILS: "qa-test@vibepin.co" };
  assert.equal(kindOf("qa-test@vibepin.co", null, env), "internal");
});

test("internal WINS over app_metadata.is_test", () => {
  assert.equal(kindOf("founder@vibepin.co", { is_test: true }), "internal");
});

// ── test accounts (the real fixtures this feature exists for) ────────────────

test("test: paddle-e2e-test@vibepin.co (production fixture)", () => {
  assert.equal(kindOf("paddle-e2e-test@vibepin.co"), "test");
});

test("test: e2e-cockpit-a@example.test (test-DB fixture)", () => {
  assert.equal(kindOf("e2e-cockpit-a@example.test"), "test");
});

test("test: any example.test domain, even with an innocuous local part", () => {
  assert.equal(kindOf("alice@example.test"), "test");
});

test("test: app_metadata.is_test === true (trusted flag)", () => {
  assert.equal(kindOf("someone@real-customer.com", { is_test: true }), "test");
});

test("test: email named in ADMIN_TEST_ACCOUNT_EMAILS", () => {
  assert.equal(kindOf("manual-fixture@vibepin.co"), "test");
});

test("test: token at the START of the local part", () => {
  assert.equal(kindOf("test-user@x.com"), "test");
  assert.equal(kindOf("e2e.run@x.com"), "test");
});

test("test: token at the END of the local part", () => {
  assert.equal(kindOf("smoke-test@x.com"), "test");
  assert.equal(kindOf("nightly_e2e@x.com"), "test");
});

test("test: token as the WHOLE local part", () => {
  assert.equal(kindOf("test@x.com"), "test");
  assert.equal(kindOf("e2e@x.com"), "test");
});

test("test: '+' separator (gmail-style tagging)", () => {
  assert.equal(kindOf("alice+test@x.com"), "test");
});

// ── customers (the false-positive guards) ────────────────────────────────────

test("customer: 'contest@x.com' is NOT a test account", () => {
  assert.equal(kindOf("contest@x.com"), "customer");
});

test("customer: 'attestation@x.com' is NOT a test account", () => {
  assert.equal(kindOf("attestation@x.com"), "customer");
});

test("customer: more embedded-substring guards", () => {
  for (const email of ["protest@x.com", "testimony@x.com", "latest@x.com", "greatest@x.com", "e2eee@x.com"]) {
    assert.equal(kindOf(email), "customer", `${email} must stay a customer`);
  }
});

test("customer: a plain address with no signals", () => {
  assert.equal(kindOf("jane@shopify-store.com"), "customer");
});

test("customer: 'example.test' as a SUBSTRING of a real domain is not the test domain", () => {
  // Domain match must be exact — 'example.test.evil.com' is not our test domain.
  assert.equal(kindOf("a@example.test.evil.com"), "customer");
});

test("customer: a null email cannot be classified away", () => {
  // We never guess a real signup out of the numbers on missing data.
  assert.equal(kindOf(null), "customer");
});

// ── SECURITY: user_metadata must never influence the verdict ─────────────────

test("SECURITY: user_metadata.is_test does NOT make an account 'test'", () => {
  // user_metadata is USER-EDITABLE. If it counted, any signed-up user could set
  // it themselves and vanish from the operator's blocker list — the same trust
  // boundary the plan-resolution fix closed. Only app_metadata is trusted.
  const u = { email: "real@customer.com", app_metadata: {}, user_metadata: { is_test: true } };
  assert.equal(classifyAccount(u as never, ENV), "customer");
});

test("SECURITY: a non-true app_metadata.is_test value is not truthy-coerced", () => {
  // Strict === true: the string "false" (or "true") must not flip the verdict.
  assert.equal(kindOf("real@customer.com", { is_test: "true" }), "customer");
  assert.equal(kindOf("real@customer.com", { is_test: 1 }), "customer");
});

// ── env handling ─────────────────────────────────────────────────────────────

test("empty / absent env allowlists classify nobody as internal", () => {
  assert.equal(classifyAccount({ email: "founder@vibepin.co", app_metadata: null }, {}), "customer");
});

test("blank entries in a comma list are ignored (no '' match)", () => {
  const env = { SUPER_ADMIN_EMAILS: "a@x.com,,  ,b@x.com" };
  assert.equal(classifyAccount({ email: "b@x.com", app_metadata: null }, env), "internal");
  // An empty email must not match the empty list entry.
  assert.equal(classifyAccount({ email: "", app_metadata: null }, env), "customer");
});

// ── helpers ──────────────────────────────────────────────────────────────────

test("isNonCustomer flags exactly test + internal", () => {
  assert.equal(isNonCustomer("customer"), false);
  assert.equal(isNonCustomer("test"), true);
  assert.equal(isNonCustomer("internal"), true);
});

test("emptyExcluded starts at zero and is a fresh object each call", () => {
  const a = emptyExcluded();
  assert.deepEqual(a, { test: 0, internal: 0 });
  a.test += 1;
  assert.deepEqual(emptyExcluded(), { test: 0, internal: 0 }, "must not share mutable state");
});

void done();
