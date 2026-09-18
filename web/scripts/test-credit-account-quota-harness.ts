/**
 * Contract tests for the isolated four-plan social-account quota harness.
 *
 * The production regression this catches is a start route that either starts OAuth
 * after a plan is full, or blocks an existing disconnected account from reconnecting.
 * These tests exercise the harness's observable orchestration boundary; its live
 * adapter remains separately gated on the exact Test Supabase ref.
 */
import assert from "node:assert/strict";
import {
  ACCOUNT_QUOTA_PLANS,
  ACCOUNT_QUOTA_PRODUCTION_REF,
  ACCOUNT_QUOTA_TEST_REF,
  applyAccountQuotaReport,
  assertAccountQuotaTestRef,
  buildAccountQuotaScenario,
  dryRunAccountQuotaReport,
  reportAccountQuotaMarkdown,
  syntheticAccountQuotaEmail,
  type AccountQuotaBinding,
} from "./lib/credit-account-quota-harness";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

const expectedLimits = { free: 1, starter: 1, pro: 2, business: 3 } as const;

async function main(): Promise<void> {
  for (const round of [1, 2] as const) {
    test(`round ${round}: each plan has its canonical per-platform cap and a disconnected held row`, () => {
      for (const plan of ACCOUNT_QUOTA_PLANS) {
        const scenario = buildAccountQuotaScenario(plan, "quota-unit-run");
        assert.equal(scenario.email, syntheticAccountQuotaEmail(plan, "quota-unit-run"));
        assert.equal(scenario.limit, expectedLimits[plan]);
        assert.equal(scenario.connections.length, expectedLimits[plan]);
        assert.equal(scenario.connections.filter(row => row.status === "disconnected").length, 1);
        assert.equal(scenario.connections.filter(row => row.provider === "pinterest").length, expectedLimits[plan]);
        assert.match(scenario.emailFingerprint, /^sha256:[a-f0-9]{12}$/);
      }
    });

    test(`round ${round}: target guard rejects Production and unknown refs`, () => {
      assert.doesNotThrow(() => assertAccountQuotaTestRef(ACCOUNT_QUOTA_TEST_REF));
      assert.throws(() => assertAccountQuotaTestRef(ACCOUNT_QUOTA_PRODUCTION_REF), /Production/);
      assert.throws(() => assertAccountQuotaTestRef("other-project"), /isolated test ref/);
    });

    test(`round ${round}: dry run is redacted and does not claim database or OAuth work`, () => {
      const report = dryRunAccountQuotaReport("quota-unit-run");
      const serialized = JSON.stringify(report);
      assert.equal(report.mode, "dry-run");
      assert.equal(report.outcome, "NOT_EXECUTED");
      assert.equal(report.externalWrites, false);
      assert.equal(report.rounds.length, 2);
      assert.equal(report.rounds[0].scenarios.length, 4);
      assert.doesNotMatch(serialized, /@vibepin\.test|oauth-state|bearer|password/i);
      assert.match(reportAccountQuotaMarkdown(report), /NOT_EXECUTED/);
    });
  }

  const binding: AccountQuotaBinding = {
    previewOrigin: "https://preview.example.test",
    candidateCommit: "abcdef1234567890abcdef1234567890abcdef12",
    deploymentId: "dpl_exact",
    testSupabaseOrigin: "https://snulmwprsahzqvdbyenc.supabase.co",
    testSupabaseRef: ACCOUNT_QUOTA_TEST_REF,
    verified: true,
  };
  const calls: string[] = [];
  const users = new Map<string, string>();
  const report = await applyAccountQuotaReport({
    async assertTarget(ref) {
      calls.push(`target:${ref}`);
      return binding;
    },
    async provision(scenario) {
      const userId = `user-${scenario.plan}`;
      users.set(scenario.plan, userId);
      calls.push(`provision:${scenario.plan}`);
      return { userId };
    },
    async seedConnections(scenario, userId, context) {
      assert.equal(userId, users.get(scenario.plan));
      assert.equal(scenario.connections.length, expectedLimits[scenario.plan]);
      calls.push(`seed:${context.round}:${scenario.plan}`);
    },
    async verifyConnectGate(scenario, userId, context) {
      assert.equal(userId, users.get(scenario.plan));
      calls.push(`gate:${context.round}:${scenario.plan}`);
      return [
        { surface: "database", status: "PASS", caseId: "AQ-01", detail: `${scenario.plan} exactly at limit; row count was unchanged` },
        { surface: "http", status: "PASS", caseId: "AQ-02", detail: `${scenario.plan} add rejected before OAuth; reconnect accepted without following provider` },
      ];
    },
    async cleanup(runId, userIds) {
      assert.equal(runId, "quota-apply-unit");
      assert.deepEqual([...userIds].sort(), [...users.values()].sort());
      calls.push("cleanup");
      return { status: "PASS", actions: [{ resource: "synthetic auth/social/billing", status: "PASS", detail: "zero residual run-scoped state" }] };
    },
  }, "quota-apply-unit");

  test("apply provisions exactly four identities and runs four plans twice", () => {
    assert.equal(report.outcome, "PASS");
    assert.equal(report.rounds.length, 2);
    assert.equal(calls.filter(call => call.startsWith("provision:")).length, 4);
    assert.equal(calls.filter(call => call.startsWith("seed:")).length, 8);
    assert.equal(calls.filter(call => call.startsWith("gate:")).length, 8);
    assert.equal(calls.at(-1), "cleanup");
    assert.doesNotMatch(JSON.stringify(report), /@vibepin\.test|bearer|password/i);
  });

  const failureCalls: string[] = [];
  const failed = await applyAccountQuotaReport({
    async assertTarget() { return binding; },
    async provision(scenario) { return { userId: `user-${scenario.plan}` }; },
    async seedConnections() { throw new Error("synthetic seed stopped"); },
    async verifyConnectGate() { throw new Error("unreachable"); },
    async cleanup() {
      failureCalls.push("cleanup");
      return { status: "PASS", actions: [{ resource: "synthetic state", status: "PASS", detail: "cleared" }] };
    },
  }, "quota-failure-unit");
  test("apply failure still runs cleanup and returns a redacted failed receipt", () => {
    assert.equal(failed.outcome, "FAIL");
    assert.deepEqual(failureCalls, ["cleanup"]);
    assert.doesNotMatch(JSON.stringify(failed), /@vibepin\.test|bearer|password/i);
  });

  console.log(`\nCredit account quota harness: ${passed} passed, 0 failed`);
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
