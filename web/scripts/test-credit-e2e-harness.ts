import assert from "node:assert/strict";
import {
  CREDIT_E2E_PLANS,
  CREDIT_E2E_PRODUCTION_REF,
  CREDIT_E2E_TEST_REF,
  assertStrictTestRef,
  buildScenario,
  dryRunReport,
  reportMarkdown,
  syntheticEmail,
} from "./lib/credit-e2e-harness";

const expected = {
  free: { images: 10, posts: 5, accounts: 1 },
  starter: { images: 150, posts: 150, accounts: 1 },
  pro: { images: 800, posts: 300, accounts: 2 },
  business: { images: 3000, posts: null, accounts: 3 },
} as const;

let passed = 0;
function test(name: string, fn: () => void): void {
  fn(); passed++; console.log(`  PASS ${name}`);
}

for (const round of [1, 2]) {
  test(`round ${round}: all four plans use synthetic-only accounts and exact limits`, () => {
    for (const plan of CREDIT_E2E_PLANS) {
      const near = buildScenario(plan, "credit-unit-run", "limit_minus_one");
      const exhausted = buildScenario(plan, "credit-unit-run", "limit");
      assert.equal(near.email, syntheticEmail(plan, "credit-unit-run"));
      assert.match(near.email, /^e2e-credit-(free|starter|pro|business)-credit-unit-run@vibepin\.test$/);
      assert.equal(near.aiImages.limit, expected[plan].images);
      assert.equal(near.aiImages.used, expected[plan].images - 1);
      assert.equal(exhausted.aiImages.used, expected[plan].images);
      assert.equal(near.accountsPerPlatform, expected[plan].accounts);
      assert.equal(near.scheduledPosts.limit, expected[plan].posts);
      if (expected[plan].posts === null) assert.equal(exhausted.scheduledPosts.used, 10_000);
      else assert.equal(near.scheduledPosts.used, expected[plan].posts - 1);
      // Internal apply payloads necessarily contain the synthetic identity; only
      // persisted/report output is required to be redacted.
      assert.match(near.emailFingerprint, /^sha256:[a-f0-9]{12}$/);
    }
  });

  test(`round ${round}: target guard accepts only the exact isolated test ref`, () => {
    assert.doesNotThrow(() => assertStrictTestRef(CREDIT_E2E_TEST_REF));
    assert.throws(() => assertStrictTestRef(CREDIT_E2E_PRODUCTION_REF), /Production/);
    assert.throws(() => assertStrictTestRef("some-other-ref"), /expected isolated test ref/);
  });

  test(`round ${round}: dry-run report is redacted and never claims external writes`, () => {
    const report = dryRunReport("credit-unit-run");
    const markdown = reportMarkdown(report);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.externalWrites, false);
    assert.equal(report.rounds.length, 2);
    assert.equal(report.rounds[0].scenarios.length, 8);
    assert.match(markdown, /NOT_OBSERVED/);
    assert.doesNotMatch(markdown, /@vibepin\.test/);
  });
}

console.log(`\n${passed} passed (two hermetic rounds).`);
