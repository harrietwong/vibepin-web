import assert from "node:assert/strict";
import {
  CREDIT_E2E_PLANS,
  CREDIT_E2E_PRODUCTION_REF,
  CREDIT_E2E_TEST_REF,
  applyReport,
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

async function main(): Promise<void> {
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
    const json = JSON.stringify(report);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.externalWrites, false);
    assert.equal(report.rounds.length, 2);
    assert.equal(report.rounds[0].scenarios.length, 8);
    assert.match(markdown, /NOT_OBSERVED/);
    assert.doesNotMatch(markdown, /@vibepin\.test/);
    assert.doesNotMatch(json, /@vibepin\.test/);
    assert.doesNotMatch(json, /password|bearer|service.role/i);
  });
}

await (async () => {
  const calls: string[] = [];
  const users = new Map<string, string>();
  const report = await applyReport({
    async assertTarget(ref) { calls.push(`target:${ref}`); },
    async provision(input, password) {
      assert.match(input.email, /@vibepin\.test$/);
      assert.ok(password.length >= 32);
      const userId = `user-${input.plan}`;
      users.set(input.plan, userId);
      calls.push(`provision:${input.plan}`);
      return { userId };
    },
    async seedUsage(input, userId) {
      assert.equal(userId, users.get(input.plan));
      calls.push(`seed:${input.plan}:${input.scenario}`);
    },
    async collectEvidence(input, userId) {
      assert.equal(userId, users.get(input.plan));
      calls.push(`evidence:${input.plan}:${input.scenario}`);
      return [{ surface: "database", status: "PASS", detail: `${input.plan}:${input.scenario}` }];
    },
    async cleanup(runId, userIds) {
      assert.equal(runId, "credit-apply-unit");
      assert.deepEqual(userIds.sort(), [...users.values()].sort());
      calls.push("cleanup");
    },
  }, "credit-apply-unit");

  assert.equal(report.mode, "apply");
  assert.equal(report.externalWrites, true);
  assert.equal(report.rounds.length, 2);
  assert.equal(calls.filter(v => v.startsWith("provision:")).length, 4, "exactly four accounts are provisioned");
  assert.equal(calls.filter(v => v.startsWith("seed:")).length, 16, "four plans × two scenarios × two rounds");
  assert.equal(calls.at(-1), "cleanup");
  assert.doesNotMatch(JSON.stringify(report), /@vibepin\.test|password|bearer|service.role/i);
  passed++;
  console.log("  PASS apply orchestration provisions four accounts, runs two rounds, redacts, and cleans up");
})();

await (async () => {
  let cleaned = false;
  await assert.rejects(
    applyReport({
      async assertTarget() {},
      async provision(input) { return { userId: `user-${input.plan}` }; },
      async seedUsage(input) {
        if (input.plan === "pro" && input.scenario === "limit") throw new Error("synthetic failure");
      },
      async collectEvidence() { return []; },
      async cleanup(_runId, userIds) {
        cleaned = true;
        assert.equal(userIds.length, 4);
      },
    }, "credit-cleanup-unit"),
    /synthetic failure/,
  );
  assert.equal(cleaned, true, "cleanup must run after a mid-round failure");
  passed++;
  console.log("  PASS apply orchestration guarantees cleanup on failure");
})();

console.log(`\n${passed} passed (two hermetic rounds).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
