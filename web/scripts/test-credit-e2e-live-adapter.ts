import assert from "node:assert/strict";
import {
  buildUsageAccountRow,
  validatePreviewIdentity,
  validateUsageSnapshot,
} from "./lib/credit-e2e-supabase-adapter";
import { buildScenario } from "./lib/credit-e2e-harness";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

for (const round of [1, 2]) {
  test(`round ${round}: Preview identity requires exact commit and deployment`, () => {
    const ok = {
      vercelEnv: "preview",
      gitCommitSha: "abcdef1",
      deploymentId: "dpl_exact",
      host: "vibepin-fb-preview.vercel.app",
    };
    assert.doesNotThrow(() => validatePreviewIdentity(ok, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890",
      expectedDeploymentId: "dpl_exact",
    }));
    assert.throws(() => validatePreviewIdentity({ ...ok, vercelEnv: "production" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890",
      expectedDeploymentId: "dpl_exact",
    }), /preview/i);
    assert.throws(() => validatePreviewIdentity({ ...ok, gitCommitSha: "0000000" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890",
      expectedDeploymentId: "dpl_exact",
    }), /commit/i);
    assert.throws(() => validatePreviewIdentity({ ...ok, deploymentId: "dpl_wrong" }, {
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890",
      expectedDeploymentId: "dpl_exact",
    }), /deployment/i);
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
}

console.log(`\n${passed} passed (two hermetic rounds).`);
