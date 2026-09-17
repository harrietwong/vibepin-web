import assert from "node:assert/strict";
import {
  CREDIT_E2E_PLANS,
  CREDIT_E2E_PRODUCTION_REF,
  CREDIT_E2E_TEST_REF,
  applyReport,
  assertStrictTestRef,
  buildScenario,
  dryRunReport,
  failedApplyReport,
  reportMarkdown,
  syntheticEmail,
  type TargetBinding,
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
const binding: TargetBinding = {
  previewOrigin: "https://preview.example.test",
  candidateCommit: "abcdef1234567890abcdef1234567890abcdef12",
  deploymentId: "dpl_exact",
  testSupabaseOrigin: "https://snulmwprsahzqvdbyenc.supabase.co",
  testSupabaseRef: CREDIT_E2E_TEST_REF,
  verified: true,
};
for (const round of [1, 2]) {
  test(`round ${round}: all four plans use synthetic-only accounts and exact limits`, () => {
    for (const plan of CREDIT_E2E_PLANS) {
      const near = buildScenario(plan, "credit-unit-run", "limit_minus_one");
      const exhausted = buildScenario(plan, "credit-unit-run", "limit");
      const initial = buildScenario(plan, "credit-unit-run", "default");
      assert.equal(near.email, syntheticEmail(plan, "credit-unit-run"));
      assert.match(near.email, /^e2e-credit-(free|starter|pro|business)-credit-unit-run@vibepin\.test$/);
      assert.equal(near.aiImages.limit, expected[plan].images);
      assert.equal(initial.aiImages.used, 0);
      assert.equal(initial.scheduledPosts.used, 0);
      assert.equal(near.aiImages.used, expected[plan].images - 1);
      assert.equal(exhausted.aiImages.used, expected[plan].images);
      assert.equal(near.accountsPerPlatform, expected[plan].accounts);
      assert.equal(near.scheduledPosts.limit, expected[plan].posts);
      if (expected[plan].posts === null) {
        assert.equal(near.scheduledPosts.used, 1, "Unlimited bucket uses an observed count, never a fake near-limit");
        assert.equal(exhausted.scheduledPosts.used, 2, "Unlimited bucket does not invent a limit boundary");
      }
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
    assert.equal(report.outcome, "NOT_EXECUTED");
    assert.equal(report.externalWrites, false);
    assert.equal(report.rounds.length, 2);
    assert.equal(report.rounds[0].scenarios.length, 12);
    assert.match(markdown, /NOT_EXECUTED/);
    assert.doesNotMatch(markdown, /@vibepin\.test/);
    assert.doesNotMatch(json, /@vibepin\.test/);
    assert.doesNotMatch(json, /password|bearer|service.role/i);
    assert.equal(report.binding.verified, false);
    assert.match(markdown, /NOT_EXECUTED/);
  });
}

test("apply preflight failure still produces a redacted failed report", () => {
  const report = failedApplyReport("credit-preflight-unit", new Error("failed for e2e-credit-pro-run@vibepin.test with Bearer secret"));
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.mode, "apply");
  assert.equal(report.binding.verified, false);
  assert.match(report.failures.join(" "), /\[redacted-email\]/);
  assert.doesNotMatch(JSON.stringify(report), /@vibepin\.test|Bearer secret/);
  assert.match(reportMarkdown(report), /Outcome: FAIL/);
});

await (async () => {
  const calls: string[] = [];
  const users = new Map<string, string>();
  const report = await applyReport({
    async assertTarget(ref) { calls.push(`target:${ref}`); return binding; },
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
      return { status: "PASS", actions: [{ resource: "all synthetic state", status: "PASS", detail: "zero residuals verified" }] };
    },
  }, "credit-apply-unit");

  assert.equal(report.mode, "apply");
  assert.equal(report.outcome, "PASS");
  assert.deepEqual(report.binding, binding);
  assert.equal(report.cleanup.status, "PASS");
  assert.equal(report.externalWrites, true);
  assert.equal(report.rounds.length, 2);
  assert.equal(calls.filter(v => v.startsWith("provision:")).length, 4, "exactly four accounts are provisioned");
  assert.equal(calls.filter(v => v.startsWith("seed:")).length, 24, "four plans × three scenarios × two rounds");
  assert.equal(calls.at(-1), "cleanup");
  assert.doesNotMatch(JSON.stringify(report), /@vibepin\.test|password|bearer|service.role/i);
  passed++;
  console.log("  PASS apply orchestration provisions four accounts, runs two rounds, redacts, and cleans up");
})();

await (async () => {
  let cleaned = false;
  const failed = await applyReport({
      async assertTarget() { return binding; },
      async provision(input) { return { userId: `user-${input.plan}` }; },
      async seedUsage(input) {
        if (input.plan === "pro" && input.scenario === "limit") throw new Error("synthetic failure");
      },
      async collectEvidence() { return []; },
      async cleanup(_runId, userIds) {
        cleaned = true;
        assert.equal(userIds.length, 4);
        return { status: "PASS", actions: [{ resource: "all synthetic state", status: "PASS", detail: "zero residuals verified" }] };
      },
    }, "credit-cleanup-unit");
  assert.equal(cleaned, true, "cleanup must run after a mid-round failure");
  assert.equal(failed.outcome, "FAIL");
  assert.match(failed.failures.join(" "), /synthetic failure/);
  assert.equal(failed.cleanup.status, "PASS");
  assert.match(reportMarkdown(failed), /Outcome: FAIL/);
  passed++;
  console.log("  PASS apply orchestration returns a failed report and cleanup receipt");
})();

await (async () => {
  const report = await applyReport({
    async assertTarget() { return binding; },
    async provision(input) { return { userId: `user-${input.plan}` }; },
    async seedUsage() {},
    async collectEvidence() { return []; },
    async cleanup() {
      return {
        status: "FAIL",
        actions: [
          { resource: "owner-a auth", status: "FAIL", detail: "delete failed" },
          { resource: "owner-b auth", status: "PASS", detail: "deleted" },
        ],
      };
    },
  }, "credit-cleanup-failure-unit");
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.cleanup.status, "FAIL");
  assert.match(reportMarkdown(report), /Cleanup: FAIL/);
  passed++;
  console.log("  PASS cleanup failure is preserved in the report and fails the run");
})();

await (async () => {
  const report = await applyReport({
    async assertTarget() { return binding; },
    async provision(input) { return { userId: `user-${input.plan}` }; },
    async seedUsage() {},
    async collectEvidence(input) {
      return input.plan === "free" && input.scenario === "limit_minus_one"
        ? [{ surface: "billing", status: "FAIL", detail: "semantic mismatch" }]
        : [];
    },
    async cleanup() {
      return { status: "PASS", actions: [{ resource: "all synthetic state", status: "PASS", detail: "zero residuals verified" }] };
    },
  }, "credit-evidence-failure-unit");
  assert.equal(report.outcome, "FAIL");
  assert.match(report.failures.join(" "), /evidence/i);
  passed++;
  console.log("  PASS failed evidence makes the report fail even when orchestration completes");
})();

await (async () => {
  const report = await applyReport({
    async assertTarget() { return binding; },
    async provision(input) { return { userId: `user-${input.plan}` }; },
    async seedUsage() {},
    async collectEvidence() {
      return [{ surface: "product_path", status: "NOT_EXECUTED", detail: "no reviewed provider-safe fixture" }];
    },
    async cleanup() {
      return { status: "PASS", actions: [{ resource: "all synthetic state", status: "PASS", detail: "zero residuals verified" }] };
    },
  }, "credit-partial-unit");
  assert.equal(report.outcome, "PARTIAL");
  assert.equal(report.failures.length, 0);
  assert.match(reportMarkdown(report), /NOT_EXECUTED/);
  passed++;
  console.log("  PASS unexecuted product paths make the apply report partial, never pass");
})();

console.log(`\n${passed} passed (two hermetic rounds).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
