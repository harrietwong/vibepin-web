import assert from "node:assert/strict";
import {
  assertNoPrivateEvidence,
  buildBillingFixtureRows,
  buildUsageAccountRow,
  expectedBillingUi,
  runCleanupSteps,
  validateBillingUiText,
  validateBuildIdentity,
  validateRestoredAppMetadata,
  validatePreviewIdentity,
  validateTestSupabaseBinding,
  validateUsageSnapshot,
} from "./lib/credit-e2e-supabase-adapter";
import { buildScenario } from "./lib/credit-e2e-harness";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main(): Promise<void> {
  for (const round of [1, 2]) {
  test(`round ${round}: Preview identity requires exact HTTPS origin and deployment`, () => {
    const ok = {
      vercelEnv: "preview",
      deploymentId: "dpl_exact",
      host: "vibepin-fb-preview.vercel.app",
      origin: "https://vibepin-fb-preview.vercel.app",
      forwardedProto: "https",
    };
    assert.doesNotThrow(() => validatePreviewIdentity(ok, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
    }));
    assert.throws(() => validatePreviewIdentity({ ...ok, vercelEnv: "production" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
    }), /preview/i);
    assert.throws(() => validatePreviewIdentity({ ...ok, deploymentId: "dpl_wrong" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
    }), /deployment/i);
    assert.throws(() => validatePreviewIdentity({ ...ok, origin: "https://another-preview.vercel.app" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
    }), /origin/i);
  });

  test(`round ${round}: build identity requires the exact full commit`, () => {
    const expected = {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
    };
    assert.doesNotThrow(() => validateBuildIdentity({
      environment: "preview",
      buildSha: expected.expectedCommit,
      deploymentId: "dpl_exact",
    }, expected));
    assert.throws(() => validateBuildIdentity({
      environment: "preview",
      buildSha: expected.expectedCommit.slice(0, 7),
      deploymentId: "dpl_exact",
    }, expected), /full.*commit/i);
    assert.throws(() => validateBuildIdentity({
      environment: "preview",
      buildSha: `0${expected.expectedCommit.slice(1)}`,
      deploymentId: "dpl_exact",
    }, expected), /commit mismatch/i);
  });

  test(`round ${round}: Test Supabase binding requires exact HTTPS origin and ref`, () => {
    assert.deepEqual(validateTestSupabaseBinding({
      url: "https://snulmwprsahzqvdbyenc.supabase.co",
      projectRef: "snulmwprsahzqvdbyenc",
      anonKey: "test-anon",
      serviceRoleKey: "test-service",
    }), {
      origin: "https://snulmwprsahzqvdbyenc.supabase.co",
      projectRef: "snulmwprsahzqvdbyenc",
    });
    assert.throws(() => validateTestSupabaseBinding({
      url: "http://snulmwprsahzqvdbyenc.supabase.co",
      projectRef: "snulmwprsahzqvdbyenc",
      anonKey: "test-anon",
      serviceRoleKey: "test-service",
    }), /HTTPS/i);
    assert.throws(() => validateTestSupabaseBinding({
      url: "https://other.supabase.co",
      projectRef: "snulmwprsahzqvdbyenc",
      anonKey: "test-anon",
      serviceRoleKey: "test-service",
    }), /origin.*ref/i);
    assert.throws(() => validateTestSupabaseBinding({
      url: "https://snulmwprsahzqvdbyenc.supabase.co:8443",
      projectRef: "snulmwprsahzqvdbyenc",
      anonKey: "test-anon",
      serviceRoleKey: "test-service",
    }), /exact.*origin/i);
  });

  test(`round ${round}: usage seed row uses canonical limits and scenario counters`, () => {
    const scenario = buildScenario("pro", "credit-live-unit", "limit_minus_one");
    const row = buildUsageAccountRow(scenario, "00000000-0000-4000-8000-000000000001", new Date("2026-09-17T00:00:00.000Z"));
    assert.equal(row.plan_key, "pro");
    assert.equal(row.ai_images_used, 799);
    assert.equal(row.ai_images_limit, 800);
    assert.equal(row.scheduled_posts_used, 299);
    assert.equal(row.scheduled_posts_limit, 300);
    assert.equal(row.ai_images_reserved, 0);
    assert.equal(row.bonus_images_balance, 0);
    assert.equal(row.period_start, "2026-09-17T00:00:00.000Z");
  });

  test(`round ${round}: usage snapshot must match exact plan and counters`, () => {
    const scenario = buildScenario("free", "credit-live-unit", "limit");
    assert.doesNotThrow(() => validateUsageSnapshot({
      plan: "free",
      state: "metered",
      metered: true,
      aiImages: { used: 10, limit: 10, included: 10 },
      scheduledPosts: { used: 5, limit: 5, included: 5 },
    }, scenario));
    assert.throws(() => validateUsageSnapshot({
      plan: "free",
      state: "metered",
      metered: true,
      aiImages: { used: 9, limit: 10, included: 10 },
      scheduledPosts: { used: 5, limit: 5, included: 5 },
    }, scenario), /AI image used/i);
  });

  test(`round ${round}: billing fixture makes paid plan truth readable without payment/provider`, () => {
    const free = buildScenario("free", "credit-live-unit", "limit_minus_one");
    assert.equal(buildBillingFixtureRows(free, "00000000-0000-4000-8000-000000000001"), null);
    const pro = buildScenario("pro", "credit-live-unit", "limit_minus_one");
    const fixture = buildBillingFixtureRows(pro, "00000000-0000-4000-8000-000000000001", new Date("2026-09-17T00:00:00.000Z"));
    assert.ok(fixture);
    assert.equal(fixture.customer.user_id, "00000000-0000-4000-8000-000000000001");
    assert.equal(fixture.subscription.plan, "pro");
    assert.equal(fixture.subscription.status, "active");
    assert.match(fixture.customer.creem_customer_id, /^credit-e2e:credit-live-unit:pro:customer$/);
    assert.match(fixture.subscription.creem_subscription_id, /^credit-e2e:credit-live-unit:pro:subscription$/);
  });

  test(`round ${round}: Billing UI text must prove plan, used, limit, remaining, unlimited, and no sync error`, () => {
    const pro = buildScenario("pro", "credit-live-unit", "limit_minus_one");
    const proExpected = expectedBillingUi(pro);
    assert.deepEqual(proExpected, {
      plan: "Pro",
      aiImages: ["AI images", "799 / 800 used", "1 remaining"],
      scheduledPosts: ["Scheduled posts", "299 / 300 used", "1 remaining"],
    });
    assert.doesNotThrow(() => validateBillingUiText(
      "Current plan Pro Usage this period AI images 799 / 800 used 1 remaining Scheduled posts 299 / 300 used 1 remaining",
      pro,
    ));
    assert.throws(() => validateBillingUiText(
      "Current plan Pro Usage this period AI images 799 / 800 used Scheduled posts 299 / 300 used 1 remaining",
      pro,
    ), /1 remaining/i);
    const business = buildScenario("business", "credit-live-unit", "limit");
    assert.doesNotThrow(() => validateBillingUiText(
      "Current plan Business Usage this period AI images 3000 / 3000 used 0 remaining Scheduled posts 2 used Unlimited No monthly limit",
      business,
    ));
    assert.throws(() => validateBillingUiText(
      "Current plan Business Couldn't sync billing data AI images 3000 / 3000 used 0 remaining Scheduled posts 2 used Unlimited",
      business,
    ), /sync error/i);
  });

  test(`round ${round}: evidence PII scan rejects raw identities and tokens`, () => {
    assert.doesNotThrow(() => assertNoPrivateEvidence("Current plan Pro · 799 / 800 used · 1 remaining"));
    assert.throws(() => assertNoPrivateEvidence("e2e-credit-pro-run@vibepin.test"), /email/i);
    assert.throws(() => assertNoPrivateEvidence("owner 988ca85e-923b-4771-840f-d5c0520c6d88"), /owner/i);
    assert.throws(() => assertNoPrivateEvidence("Bearer secret-token-value"), /token/i);
  });

  test(`round ${round}: cleanup verifies run metadata is restored before auth deletion`, () => {
    const original = { provider: "email", providers: ["email"] };
    assert.doesNotThrow(() => validateRestoredAppMetadata(original, { provider: "email", providers: ["email"] }));
    assert.throws(() => validateRestoredAppMetadata(original, {
      provider: "email",
      providers: ["email"],
      credit_e2e_run_id: "credit-live-unit",
    }), /run metadata/i);
    assert.throws(() => validateRestoredAppMetadata({ ...original, plan: "free" }, {
      ...original,
      plan: "pro",
    }), /plan metadata/i);
  });
  }

await (async () => {
  const calls: string[] = [];
  const receipt = await runCleanupSteps([
    { resource: "owner-a usage", run: async () => { calls.push("a-usage"); throw new Error("boom"); } },
    { resource: "owner-a auth", run: async () => { calls.push("a-auth"); } },
    { resource: "owner-b usage", run: async () => { calls.push("b-usage"); } },
    { resource: "owner-b auth", run: async () => { calls.push("b-auth"); } },
  ]);
  assert.deepEqual(calls, ["a-usage", "a-auth", "b-usage", "b-auth"]);
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.actions.length, 4);
  assert.equal(receipt.actions.filter(item => item.status === "FAIL").length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /boom/);
  passed += 1;
  console.log("  PASS cleanup isolates every throw and continues every owner");
})();

console.log(`\n${passed} passed (two hermetic rounds).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
