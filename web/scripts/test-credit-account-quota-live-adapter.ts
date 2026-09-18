/** Live-adapter boundary tests for the account quota runner (no network). */
import assert from "node:assert/strict";
import {
  buildSyntheticSocialConnectionRows,
  executeSyntheticCleanupSteps,
  normalizeSeededConnections,
  SupabaseAccountQuotaAdapter,
  validateAtLimitConnectResponse,
  validateReconnectStartResponse,
} from "./lib/credit-account-quota-supabase-adapter";
import { buildAccountQuotaScenario } from "./lib/credit-account-quota-harness";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main(): Promise<void> {
for (const round of [1, 2] as const) {
  await test(`round ${round}: malformed Test Supabase binding is rejected before a service client exists`, () => {
    let factoryCalls = 0;
    assert.throws(() => new SupabaseAccountQuotaAdapter({
      baseUrl: "https://vibepin-fb-preview.vercel.app",
      expectedCommit: "abcdef1234567890abcdef1234567890abcdef12",
      expectedDeploymentId: "dpl_exact",
      config: {
        url: "https://other.supabase.co",
        projectRef: "snulmwprsahzqvdbyenc",
        anonKey: "test-anon",
        serviceRoleKey: "test-service",
      },
      serviceClientFactory: () => {
        factoryCalls += 1;
        return {} as never;
      },
    }), /origin.*ref/i);
    assert.equal(factoryCalls, 0);
  });

  await test(`round ${round}: seed rows hold the exact cap without writing any provider token`, () => {
    const scenario = buildAccountQuotaScenario("business", "quota-live-unit");
    const rows = buildSyntheticSocialConnectionRows(scenario, "00000000-0000-4000-8000-000000000001");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(row => row.connection_status === "not_connected").length, 1);
    assert.ok(rows.every(row => row.provider === "pinterest"));
    assert.ok(rows.every(row => row.user_id === "00000000-0000-4000-8000-000000000001"));
    assert.ok(rows.every(row => row.provider_account_id.startsWith("synthetic-business-")));
    assert.doesNotMatch(JSON.stringify(rows), /access_token|refresh_token|oauth|secret/i);
  });

  await test(`round ${round}: database connection_status maps to the quota lifecycle without a false reconnect target`, () => {
    assert.deepEqual(normalizeSeededConnections([
      { id: "one", connection_status: "connected" },
      { id: "two", connection_status: "not_connected" },
    ]), [
      { id: "one", status: "connected" },
      { id: "two", status: "not_connected" },
    ]);
    assert.throws(() => normalizeSeededConnections([{ id: "bad", connection_status: "expired" }]), /unexpected/);
  });

  await test(`round ${round}: a full plan rejection requires 403 limit_reached, stable rows, and no OAuth state cookie`, () => {
    assert.doesNotThrow(() => validateAtLimitConnectResponse({
      status: 403,
      body: { code: "limit_reached" },
      setCookie: null,
      rowsBefore: 2,
      rowsAfter: 2,
    }));
    assert.throws(() => validateAtLimitConnectResponse({
      status: 200,
      body: { code: "limit_reached" },
      setCookie: null,
      rowsBefore: 2,
      rowsAfter: 2,
    }), /HTTP 403/);
    assert.throws(() => validateAtLimitConnectResponse({
      status: 403,
      body: { code: "limit_reached" },
      setCookie: "pinterest_oauth_state=sealed",
      rowsBefore: 2,
      rowsAfter: 2,
    }), /OAuth state/);
    assert.throws(() => validateAtLimitConnectResponse({
      status: 403,
      body: { code: "limit_reached" },
      setCookie: null,
      rowsBefore: 2,
      rowsAfter: 3,
    }), /row count/);
  });

  await test(`round ${round}: reconnect start is allowed at cap but never follows a provider URL`, () => {
    assert.doesNotThrow(() => validateReconnectStartResponse({
      status: 200,
      body: { url: "https://www.pinterest.com/oauth/?response_type=code&client_id=synthetic-client&redirect_uri=https%3A%2F%2Fpreview.example.test%2Fapi%2Fauth%2Fpinterest%2Fcallback&state=sealed-state" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }));
    assert.throws(() => validateReconnectStartResponse({
      status: 403,
      body: { code: "limit_reached" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }), /must not be blocked/);
    assert.throws(() => validateReconnectStartResponse({
      status: 200,
      body: { url: "https://www.pinterest.com/oauth/?client_id=synthetic-client" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }), /state/);
  });

  await test(`round ${round}: cleanup retries a transient child delete in order before moving to the next step`, async () => {
    const order: string[] = [];
    let customerAttempts = 0;
    const actions = await executeSyntheticCleanupSteps([
      { resource: "subscription", remove: async () => { order.push("subscription"); return { error: null }; } },
      { resource: "customer", remove: async () => {
        customerAttempts += 1;
        order.push(`customer:${customerAttempts}`);
        return { error: customerAttempts === 1 ? { code: "23503" } : null };
      } },
      { resource: "social", remove: async () => { order.push("social"); return { error: null }; } },
      { resource: "auth", remove: async () => { order.push("auth"); return { error: null }; } },
    ]);
    assert.deepEqual(order, ["subscription", "customer:1", "customer:2", "social", "auth"]);
    assert.deepEqual(actions.map(item => item.status), ["PASS", "PASS", "PASS", "PASS"]);
  });

  await test(`round ${round}: cleanup records exactly three persistent failures then still deletes later state`, async () => {
    const order: string[] = [];
    let customerAttempts = 0;
    const actions = await executeSyntheticCleanupSteps([
      { resource: "customer", remove: async () => {
        customerAttempts += 1;
        order.push(`customer:${customerAttempts}`);
        return { error: { code: "23503" } };
      } },
      { resource: "social", remove: async () => { order.push("social"); return { error: null }; } },
      { resource: "auth", remove: async () => { order.push("auth"); return { error: null }; } },
    ]);
    assert.deepEqual(order, ["customer:1", "customer:2", "customer:3", "social", "auth"]);
    assert.deepEqual(actions.map(item => item.status), ["FAIL", "PASS", "PASS"]);
  });
}

console.log(`\nCredit account quota live adapter: ${passed} passed, 0 failed`);
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
