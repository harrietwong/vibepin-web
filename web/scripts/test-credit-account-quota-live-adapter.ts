/** Live-adapter boundary tests for the account quota runner (no network). */
import assert from "node:assert/strict";
import {
  buildSyntheticSocialConnectionRows,
  normalizeSeededConnections,
  SupabaseAccountQuotaAdapter,
  validateAtLimitConnectResponse,
  validateReconnectStartResponse,
} from "./lib/credit-account-quota-supabase-adapter";
import { buildAccountQuotaScenario } from "./lib/credit-account-quota-harness";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

for (const round of [1, 2] as const) {
  test(`round ${round}: malformed Test Supabase binding is rejected before a service client exists`, () => {
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

  test(`round ${round}: seed rows hold the exact cap without writing any provider token`, () => {
    const scenario = buildAccountQuotaScenario("business", "quota-live-unit");
    const rows = buildSyntheticSocialConnectionRows(scenario, "00000000-0000-4000-8000-000000000001");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(row => row.connection_status === "not_connected").length, 1);
    assert.ok(rows.every(row => row.provider === "pinterest"));
    assert.ok(rows.every(row => row.user_id === "00000000-0000-4000-8000-000000000001"));
    assert.ok(rows.every(row => row.provider_account_id.startsWith("synthetic-business-")));
    assert.doesNotMatch(JSON.stringify(rows), /access_token|refresh_token|oauth|secret/i);
  });

  test(`round ${round}: database connection_status maps to the quota lifecycle without a false reconnect target`, () => {
    assert.deepEqual(normalizeSeededConnections([
      { id: "one", connection_status: "connected" },
      { id: "two", connection_status: "not_connected" },
    ]), [
      { id: "one", status: "connected" },
      { id: "two", status: "not_connected" },
    ]);
    assert.throws(() => normalizeSeededConnections([{ id: "bad", connection_status: "expired" }]), /unexpected/);
  });

  test(`round ${round}: a full plan rejection requires 403 limit_reached, stable rows, and no OAuth state cookie`, () => {
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

  test(`round ${round}: reconnect start is allowed at cap but never follows a provider URL`, () => {
    assert.doesNotThrow(() => validateReconnectStartResponse({
      status: 200,
      body: { url: "/api/auth/pinterest/connect?next=%2Fapp%2Fsettings%2Fsocial&reconnect=00000000-0000-4000-8000-000000000001" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }));
    assert.throws(() => validateReconnectStartResponse({
      status: 403,
      body: { code: "limit_reached" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }), /must not be blocked/);
    assert.throws(() => validateReconnectStartResponse({
      status: 200,
      body: { url: "https://www.pinterest.com/oauth/?state=would-follow" },
      requestedReconnectId: "00000000-0000-4000-8000-000000000001",
    }), /local start URL/);
  });
}

console.log(`\nCredit account quota live adapter: ${passed} passed, 0 failed`);
