/**
 * Creem billing status + portal route tests (WP-Billing P0, Commit 4).
 * Run: npx tsx scripts/test-creem-billing-status.ts
 *
 * Drives GET /api/billing/creem/status and POST /api/billing/creem/portal with
 * injected fakes (module-mocked auth + creemStore + creemClient). No DB/network.
 *
 * Covered: status shape for no-account / active-sub / scheduled-cancel; portal
 * rejects unauthenticated (401); portal 404 when no billing account; portal uses
 * ONLY the server-resolved customer id (the handler reads nothing from the
 * request — asserted by passing a request with an adversarial body and confirming
 * the Creem call receives the store-resolved id).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.CREEM_API_KEY = "creem_test_fake";

export {};

import { Module } from "node:module";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Injected fakes ──────────────────────────────────────────────────────────────

type SubRow = {
  creem_subscription_id: string;
  creem_customer_id: string;
  user_id: string | null;
  status: string;
  creem_product_id: string;
  plan: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  scheduled_cancel: boolean;
  last_event_at: string | null;
};

const fakes = {
  uid: "user-1" as string | null,
  customer: null as { creem_customer_id: string } | null,
  subs: [] as SubRow[],
  portalCalledWith: undefined as string | undefined,
  portalThrows: false,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: async () => fakes.uid };
  }
  if (request.includes("creem/creemStore")) {
    return {
      creemStatusGrantsAccess: (s: string) => s === "active" || s === "trialing",
      getCreemCustomerByUserId: async (_uid: string) => fakes.customer,
      getCreemSubscriptionsForCustomer: async (_cid: string) => fakes.subs,
    };
  }
  if (request.includes("creem/creemClient")) {
    return {
      createCustomerPortal: async (customerId: string) => {
        fakes.portalCalledWith = customerId;
        if (fakes.portalThrows) throw new Error("creem portal down");
        return { portalUrl: "https://creem.io/my-orders/login/abc" };
      },
    };
  }
  if (request.includes("server/entitlements")) {
    // Only normalizePlanKey is used by the status route.
    return {
      normalizePlanKey: (v: unknown) => {
        if (typeof v !== "string") return null;
        const t = v.trim().toLowerCase();
        return ["free", "starter", "pro", "business"].includes(t) ? t : null;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function getReq(): Request {
  return new Request("https://vibepin.co/api/billing/creem/status", { method: "GET" });
}
function postReq(body?: unknown): Request {
  return new Request("https://vibepin.co/api/billing/creem/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sub(over: Partial<SubRow>): SubRow {
  return {
    creem_subscription_id: "sub_1",
    creem_customer_id: "cus_1",
    user_id: "user-1",
    status: "active",
    creem_product_id: "prod_pro_m",
    plan: "pro",
    billing_interval: "month",
    current_period_end: "2026-08-01T00:00:00.000Z",
    scheduled_cancel: false,
    last_event_at: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

async function main() {
  const statusRoute = await import("../src/app/api/billing/creem/status/route");
  const portalRoute = await import("../src/app/api/billing/creem/portal/route");

  console.log("\nCreem billing status + portal tests\n");

  // ── status ──────────────────────────────────────────────────────────────────
  await test("status: 401 when unauthenticated", async () => {
    fakes.uid = null;
    const res = await statusRoute.GET(getReq() as never);
    assertEq(res.status, 401, "status");
    fakes.uid = "user-1";
  });

  await test("status: no billing account → { hasBillingAccount:false, plan:'free' }", async () => {
    fakes.customer = null;
    fakes.subs = [];
    const res = await statusRoute.GET(getReq() as never);
    assertEq(res.status, 200, "status");
    const json = (await res.json()) as { hasBillingAccount: boolean; plan: string };
    assertEq(json.hasBillingAccount, false, "hasBillingAccount");
    assertEq(json.plan, "free", "plan");
  });

  await test("status: active subscription shape", async () => {
    fakes.customer = { creem_customer_id: "cus_1" };
    fakes.subs = [sub({ status: "active", plan: "pro", billing_interval: "month" })];
    const res = await statusRoute.GET(getReq() as never);
    assertEq(res.status, 200, "status");
    const json = (await res.json()) as Record<string, unknown>;
    assertEq(json.hasBillingAccount, true, "hasBillingAccount");
    assertEq(json.plan, "pro", "plan");
    assertEq(json.interval, "month", "interval");
    assertEq(json.status, "active", "status field");
    assertEq(json.currentPeriodEnd, "2026-08-01T00:00:00.000Z", "currentPeriodEnd");
    assertEq(json.scheduledCancel, false, "scheduledCancel");
    // No Creem ids leaked.
    assert(!("creem_customer_id" in json), "no customer id leaked");
    assert(!("creem_subscription_id" in json), "no subscription id leaked");
    assert(!("creem_product_id" in json), "no product id leaked");
  });

  await test("status: scheduled-cancel subscription surfaces scheduledCancel=true and keeps plan", async () => {
    fakes.customer = { creem_customer_id: "cus_1" };
    fakes.subs = [sub({ status: "active", scheduled_cancel: true, plan: "business" })];
    const res = await statusRoute.GET(getReq() as never);
    const json = (await res.json()) as Record<string, unknown>;
    assertEq(json.scheduledCancel, true, "scheduledCancel");
    assertEq(json.plan, "business", "plan retained while scheduled to cancel");
  });

  await test("status: customer exists but no subscription → free with hasBillingAccount:true", async () => {
    fakes.customer = { creem_customer_id: "cus_1" };
    fakes.subs = [];
    const res = await statusRoute.GET(getReq() as never);
    const json = (await res.json()) as Record<string, unknown>;
    assertEq(json.hasBillingAccount, true, "hasBillingAccount");
    assertEq(json.plan, "free", "plan");
  });

  // ── portal ──────────────────────────────────────────────────────────────────
  await test("portal: 401 when unauthenticated", async () => {
    fakes.uid = null;
    const res = await portalRoute.POST(postReq() as never);
    assertEq(res.status, 401, "status");
    fakes.uid = "user-1";
  });

  await test("portal: 404 when no billing account", async () => {
    fakes.customer = null;
    const res = await portalRoute.POST(postReq() as never);
    assertEq(res.status, 404, "status");
    const json = (await res.json()) as { error: string };
    assertEq(json.error, "no_billing_account", "error");
  });

  await test("portal: uses ONLY the server-resolved customer id (ignores request body)", async () => {
    fakes.customer = { creem_customer_id: "cus_SERVER" };
    fakes.portalCalledWith = undefined;
    fakes.portalThrows = false;
    // Adversarial body tries to supply a different customer id — must be ignored.
    const res = await portalRoute.POST(
      postReq({ customer_id: "cus_ATTACKER", customerId: "cus_ATTACKER" }) as never,
    );
    assertEq(res.status, 200, "status");
    assertEq(fakes.portalCalledWith, "cus_SERVER", "portal called with server-resolved id");
    const json = (await res.json()) as { url: string };
    assertEq(json.url, "https://creem.io/my-orders/login/abc", "url passthrough");
  });

  await test("portal: 502 on upstream failure", async () => {
    fakes.customer = { creem_customer_id: "cus_1" };
    fakes.portalThrows = true;
    const res = await portalRoute.POST(postReq() as never);
    assertEq(res.status, 502, "status");
    const json = (await res.json()) as { error: string };
    assertEq(json.error, "portal_failed", "error");
    fakes.portalThrows = false;
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
