import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Page } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertNoPrivateEvidence,
  assertScreenshotDomSafe,
  buildBillingFixtureRows,
  buildScreenshotMaskLocators,
  buildSyntheticAppMetadata,
  buildUsageAccountRow,
  expectedBillingUi,
  runCleanupSteps,
  SupabaseCreditE2eAdapter,
  validateBillingUiText,
  validateBuildIdentity,
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

const validAdapterOptions = {
  baseUrl: "https://vibepin-fb-preview.vercel.app",
  expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
  expectedDeploymentId: "dpl_exact",
  config: {
    url: "https://snulmwprsahzqvdbyenc.supabase.co",
    projectRef: "snulmwprsahzqvdbyenc",
    anonKey: "test-anon",
    serviceRoleKey: "test-service",
  },
};

function visibleTextFromFixture(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node)
    .replace(/<(?:div|section|main|p|h[1-6])(?:\s[^>]*)?>/gi, "\n")
    .replace(/<\/(?:div|section|main|p|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function responseLossService() {
  const users: Array<{ id: string; email: string; app_metadata: Record<string, unknown> }> = [];
  const deletedUserIds: string[] = [];
  let createPayload: Record<string, unknown> | null = null;
  const query = () => {
    const result = { data: [], error: null, count: 0 };
    const builder: Record<string, unknown> & PromiseLike<typeof result> = {
      delete: () => builder,
      select: () => builder,
      eq: () => builder,
      like: () => builder,
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const service = {
    from: () => query(),
    auth: {
      admin: {
        async createUser(payload: Record<string, unknown>) {
          createPayload = payload;
          users.push({
            id: "00000000-0000-4000-8000-000000000099",
            email: String(payload.email),
            app_metadata: { ...payload.app_metadata as Record<string, unknown> },
          });
          return { data: { user: null }, error: new Error("response lost after commit") };
        },
        async listUsers() { return { data: { users: [...users] }, error: null }; },
        async deleteUser(userId: string) {
          deletedUserIds.push(userId);
          const index = users.findIndex(user => user.id === userId);
          if (index >= 0) users.splice(index, 1);
          return { data: {}, error: null };
        },
        async getUserById(userId: string) {
          return { data: { user: users.find(user => user.id === userId) ?? null }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { service, users, deletedUserIds, getCreatePayload: () => createPayload };
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

    let clientFactoryCalls = 0;
    assert.throws(() => new SupabaseCreditE2eAdapter({
      ...validAdapterOptions,
      config: { ...validAdapterOptions.config, url: "https://other.supabase.co" },
      serviceClientFactory: () => {
        clientFactoryCalls += 1;
        return {} as SupabaseClient;
      },
    }), /origin.*ref/i);
    assert.equal(clientFactoryCalls, 0, "exact config must be validated before constructing a Supabase client");
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
    const free = buildScenario("free", "credit-live-unit", "limit");
    const freeCurrentPlan = "Current plan\nFree\nActive";
    const freeUsage = [
      "Usage this period",
      "AI images 10 / 10 used",
      "0 remaining",
      "AI text generations 0 / 10 used",
      "10 remaining",
      "Scheduled posts 5 / 5 used",
      "0 remaining",
    ].join("\n");
    assert.doesNotThrow(() => validateBillingUiText({ currentPlanText: freeCurrentPlan, usageText: freeUsage }, free));
    assert.throws(() => validateBillingUiText({
      currentPlanText: freeCurrentPlan,
      usageText: freeUsage.replace("AI images 10 / 10 used", "AI images 110 / 10 used"),
    }, free), /AI images.*mismatch/i);
    assert.throws(() => validateBillingUiText({
      currentPlanText: freeCurrentPlan,
      usageText: freeUsage.replace("Scheduled posts 5 / 5 used", "Scheduled posts 15 / 5 used"),
    }, free), /Scheduled posts.*mismatch/i);

    const pro = buildScenario("pro", "credit-live-unit", "limit_minus_one");
    const proExpected = expectedBillingUi(pro);
    assert.deepEqual(proExpected, {
      plan: "Pro",
      aiImages: ["AI images", "799 / 800 used", "1 remaining"],
      scheduledPosts: ["Scheduled posts", "299 / 300 used", "1 remaining"],
    });
    const proCurrentPlan = "Current plan\nPro\nActive";
    const proUsage = [
      "Usage this period",
      "AI images 799 / 800 used",
      "1 remaining",
      "AI text generations 0 / 250 used",
      "250 remaining",
      "Scheduled posts 299 / 300 used",
      "1 remaining",
    ].join("\n");
    assert.doesNotThrow(() => validateBillingUiText({ currentPlanText: proCurrentPlan, usageText: proUsage }, pro));
    assert.throws(() => validateBillingUiText({
      currentPlanText: proCurrentPlan,
      usageText: proUsage.replace("AI images 799 / 800 used", "AI images 1799 / 800 used"),
    }, pro), /AI images.*mismatch/i);
    assert.throws(() => validateBillingUiText({
      currentPlanText: proCurrentPlan,
      usageText: proUsage.replace("1 remaining", "remaining unavailable"),
    }, pro), /AI images remaining/i);
    const business = buildScenario("business", "credit-live-unit", "limit");
    const currentPlanDomFixture = createElement("section", { "data-testid": "billing-current-plan" },
      createElement("p", null, "CURRENT PLAN"),
      createElement("h2", null, "BUSINESS", createElement("span", null, "Monthly")),
      createElement("span", null, "Active"),
    );
    const usageDomFixture = createElement("section", { "data-testid": "billing-usage-period" },
      createElement("h3", null, "Usage this period"),
      createElement("div", null, createElement("span", null, "AI images"), createElement("span", null, "3000 / 3000 used"), createElement("p", null, "0 remaining")),
      createElement("div", null, createElement("span", null, "AI text generations"), createElement("span", null, "0 / 1000 used"), createElement("p", null, "1000 remaining")),
      createElement("div", null, createElement("span", null, "Scheduled posts"), createElement("span", null, "2 used"), createElement("p", null, "No monthly limit")),
    );
    assert.doesNotThrow(() => validateBillingUiText({
      currentPlanText: visibleTextFromFixture(currentPlanDomFixture),
      usageText: visibleTextFromFixture(usageDomFixture),
    }, business));
    assert.throws(() => validateBillingUiText({
      currentPlanText: visibleTextFromFixture(currentPlanDomFixture),
      usageText: visibleTextFromFixture(usageDomFixture).replace("Scheduled posts 2 used", "Scheduled posts 12 used"),
    }, business), /Scheduled posts used.*mismatch/i);
    assert.deepEqual(expectedBillingUi(business).scheduledPosts, ["Scheduled posts", "2 used", "No monthly limit"]);
    assert.throws(() => validateBillingUiText(
      "Current plan Business Couldn't sync billing data AI images 3000 / 3000 used 0 remaining Scheduled posts 2 used No monthly limit",
      business,
    ), /sync error/i);
  });

  test(`round ${round}: evidence PII scan rejects raw identities and tokens`, () => {
    assert.doesNotThrow(() => assertNoPrivateEvidence("Current plan Pro · 799 / 800 used · 1 remaining"));
    assert.throws(() => assertNoPrivateEvidence("e2e-credit-pro-run@vibepin.test"), /email/i);
    assert.throws(() => assertNoPrivateEvidence("owner 988ca85e-923b-4771-840f-d5c0520c6d88"), /owner/i);
    assert.throws(() => assertNoPrivateEvidence("Bearer secret-token-value"), /token/i);
  });

  test(`round ${round}: temporary auth accounts carry exact discovery metadata`, () => {
    const scenario = buildScenario("pro", "credit-live-unit", "default");
    assert.deepEqual(buildSyntheticAppMetadata(scenario), {
      plan: "pro",
      credit_e2e_run_id: "credit-live-unit",
      credit_e2e_synthetic: true,
    });
  });
  }

await (async () => {
  let fetchCalls = 0;
  const fetchSpy: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected external request");
  };
  const adapter = new SupabaseCreditE2eAdapter({ ...validAdapterOptions, supabaseFetchImpl: fetchSpy, fetchImpl: fetchSpy });
  const receipt = await adapter.cleanup("credit-never-bound", []);
  assert.equal(fetchCalls, 0, "cleanup before verified binding/resource creation must issue zero external requests");
  assert.equal(receipt.status, "PASS");
  passed += 1;
  console.log("  PASS unverified empty cleanup performs zero external requests");
})();

await (async () => {
  const embeddedEmail = "e2e-credit-pro-credit-shot@vibepin.test";
  const nonSecretFixturePassword = `fixture-${embeddedEmail.length}`;
  await assert.doesNotReject(() => assertScreenshotDomSafe(
    async () => `Signed in as ${embeddedEmail} · Current plan Pro`,
    embeddedEmail,
  ));
  await assert.rejects(() => assertScreenshotDomSafe(
    async () => { throw new Error("DOM unavailable"); },
    embeddedEmail,
  ), /DOM unavailable/);

  const maskCalls: Array<{ text: string; exact?: boolean }> = [];
  const fakePage = {
    getByTestId: () => ({ kind: "account" }),
    getByText: (text: string, options?: { exact?: boolean }) => {
      maskCalls.push({ text, exact: options?.exact });
      return { kind: "email" };
    },
  } as unknown as Page;
  assert.equal(buildScreenshotMaskLocators(fakePage, embeddedEmail).length, 2);
  assert.deepEqual(maskCalls, [{ text: embeddedEmail, exact: false }]);

  const adapter = new SupabaseCreditE2eAdapter({
    ...validAdapterOptions,
    screenshotDir: "unused-hermetic-screenshot-dir",
    serviceClientFactory: () => ({} as SupabaseClient),
  });
  const capture = (adapter as unknown as {
    maskedScreenshot: (
      page: Page,
      input: ReturnType<typeof buildScenario>,
      round: 1 | 2,
      credential: { email: string; password: string },
      suffix: "pass" | "fail",
    ) => Promise<string>;
  }).maskedScreenshot.bind(adapter);
  let screenshotCalls = 0;
  const unreadablePage = {
    locator: () => ({ innerText: async () => { throw new Error("DOM unavailable"); } }),
    screenshot: async () => { screenshotCalls += 1; },
  } as unknown as Page;
  await assert.rejects(capture(
    unreadablePage,
    buildScenario("pro", "credit-shot", "default"),
    1,
    { email: embeddedEmail, password: nonSecretFixturePassword },
    "fail",
  ), /DOM unavailable/);
  const unmaskablePage = {
    locator: () => ({ innerText: async () => `Signed in as ${embeddedEmail}` }),
    getByTestId: () => ({ kind: "account" }),
    getByText: () => { throw new Error("mask unavailable"); },
    screenshot: async () => { screenshotCalls += 1; },
  } as unknown as Page;
  await assert.rejects(capture(
    unmaskablePage,
    buildScenario("pro", "credit-shot", "default"),
    1,
    { email: embeddedEmail, password: nonSecretFixturePassword },
    "fail",
  ), /mask unavailable/);
  assert.equal(screenshotCalls, 0, "unreadable or unmaskable evidence must never call page.screenshot");
  passed += 1;
  console.log("  PASS screenshot safety rejects unreadable DOM and masks embedded synthetic email text");
})();

await (async () => {
  const fake = responseLossService();
  fake.users.push({
    id: "00000000-0000-4000-8000-000000000088",
    email: "real-user@example.test",
    app_metadata: { plan: "pro", credit_e2e_run_id: "credit-response-loss", credit_e2e_synthetic: true },
  });
  const adapter = new SupabaseCreditE2eAdapter({
    ...validAdapterOptions,
    serviceClientFactory: () => fake.service,
  });
  const scenario = buildScenario("pro", "credit-response-loss", "default");
  await assert.rejects(adapter.provision(scenario, "temporary-password"), /Could not provision/);
  assert.equal(fake.users.length, 2, "the fake simulates an Auth commit whose response was lost");
  assert.deepEqual(fake.getCreatePayload()?.app_metadata, buildSyntheticAppMetadata(scenario));
  const receipt = await adapter.cleanup(scenario.runId, []);
  assert.equal(receipt.status, "PASS");
  assert.deepEqual(fake.users.map(user => user.email), ["real-user@example.test"], "discovery must ignore non-whitelisted emails even with copied metadata");
  assert.deepEqual(fake.deletedUserIds, ["00000000-0000-4000-8000-000000000099"]);
  assert.match(JSON.stringify(receipt), /zero-residual auth/i);
  passed += 1;
  console.log("  PASS lost createUser response is recovered by restricted run discovery and deleted");
})();

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
