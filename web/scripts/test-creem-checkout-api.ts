/**
 * Creem checkout route unit tests (WP-Billing P0, Commit 2).
 * Run: npx tsx scripts/test-creem-checkout-api.ts
 *
 * Exercises POST /api/billing/creem/checkout with injected fakes (module-mocked
 * auth + Creem client + supabase admin). No network, no DB.
 *
 * Covered: 401 unauthenticated; 400 bad plan/interval (incl. plan=free);
 * product_id always resolved from the server env map (asserts the mocked Creem
 * call body); success_url host allowlisting (evil origin → vibepin.co);
 * metadata.userId present; 502 upstream failure shape.
 */

// Env must be set BEFORE any server module loads.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// Deterministic product ids for the six mappings.
process.env.CREEM_PRODUCT_STARTER_MONTHLY = "prod_starter_m";
process.env.CREEM_PRODUCT_STARTER_YEARLY = "prod_starter_y";
process.env.CREEM_PRODUCT_PRO_MONTHLY = "prod_pro_m";
process.env.CREEM_PRODUCT_PRO_YEARLY = "prod_pro_y";
process.env.CREEM_PRODUCT_BUSINESS_MONTHLY = "prod_business_m";
process.env.CREEM_PRODUCT_BUSINESS_YEARLY = "prod_business_y";
process.env.CREEM_API_KEY = "creem_test_fake";
// Billing mode: "test" is usable in a non-production runtime (VERCEL_ENV unset,
// NODE_ENV not "production"), so the happy-path checkout tests exercise the real
// route logic. Individual guard tests override CREEM_MODE / runtime env locally.
process.env.CREEM_MODE = "test";

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
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── Module mocking (intercept require of the route's dependencies) ──────────────
// The route imports authUser, supabase, creemClient. We inject fakes by patching
// Module._load, keyed on the resolved specifier suffix.

type Fakes = {
  uid: string | null;
  email: string | null;
  checkout: (input: unknown) => Promise<{ checkoutUrl: string }>;
  lastCheckoutInput?: unknown;
};
const fakes: Fakes = {
  uid: "user-123",
  email: "buyer@example.com",
  checkout: async () => ({ checkoutUrl: "https://test-api.creem.io/checkout/abc" }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: async () => fakes.uid };
  }
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase") || request.includes("lib/supabase")) {
    return {
      createServerClient: () => ({
        auth: {
          admin: {
            getUserById: async (_id: string) =>
              fakes.email
                ? { data: { user: { email: fakes.email } }, error: null }
                : { data: { user: null }, error: { message: "no user" } },
          },
        },
      }),
    };
  }
  if (request.includes("creem/creemClient")) {
    return {
      createCheckoutSession: async (input: unknown) => {
        fakes.lastCheckoutInput = input;
        return fakes.checkout(input);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function makeReq(body: unknown, origin?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers["origin"] = origin;
  return new Request("https://vibepin.co/api/billing/creem/checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function main() {
  // Import AFTER the loader patch so the route picks up the fakes. tsx compiles
  // to ESM-over-CJS; the route's `import` lowers to require, intercepted above.
  const route = await import("../src/app/api/billing/creem/checkout/route");

  console.log("\nCreem checkout API tests\n");

  await test("401 when unauthenticated", async () => {
    fakes.uid = null;
    const res = await route.POST(makeReq({ plan: "pro", interval: "month" }) as never);
    assertEq(res.status, 401, "status");
    fakes.uid = "user-123";
  });

  await test("400 on unknown plan", async () => {
    const res = await route.POST(makeReq({ plan: "enterprise", interval: "month" }) as never);
    assertEq(res.status, 400, "status");
  });

  await test("400 on plan=free (not purchasable)", async () => {
    const res = await route.POST(makeReq({ plan: "free", interval: "month" }) as never);
    assertEq(res.status, 400, "status");
  });

  await test("400 on bad interval", async () => {
    const res = await route.POST(makeReq({ plan: "pro", interval: "week" }) as never);
    assertEq(res.status, 400, "status");
  });

  await test("productId is resolved from the server env map (pro/year)", async () => {
    fakes.lastCheckoutInput = undefined;
    const res = await route.POST(makeReq({ plan: "pro", interval: "year" }, "https://vibepin.co") as never);
    assertEq(res.status, 200, "status");
    const input = fakes.lastCheckoutInput as { productId: string; metadata: { userId: string } };
    assertEq(input.productId, "prod_pro_y", "productId from CREEM_PRODUCT_PRO_YEARLY");
    assertEq(input.metadata.userId, "user-123", "metadata.userId present");
  });

  await test("productId for business/month", async () => {
    const res = await route.POST(makeReq({ plan: "business", interval: "month" }, "https://vibepin.co") as never);
    assertEq(res.status, 200, "status");
    const input = fakes.lastCheckoutInput as { productId: string };
    assertEq(input.productId, "prod_business_m", "productId from CREEM_PRODUCT_BUSINESS_MONTHLY");
  });

  await test("success_url uses request origin when host is allowlisted (localhost)", async () => {
    const res = await route.POST(makeReq({ plan: "starter", interval: "month" }, "http://localhost:3000") as never);
    assertEq(res.status, 200, "status");
    const input = fakes.lastCheckoutInput as { successUrl: string };
    assertEq(input.successUrl, "http://localhost:3000/welcome", "allowlisted localhost origin honored");
  });

  await test("success_url falls back to vibepin.co for an evil origin", async () => {
    const res = await route.POST(makeReq({ plan: "starter", interval: "month" }, "https://evil.example.com") as never);
    assertEq(res.status, 200, "status");
    const input = fakes.lastCheckoutInput as { successUrl: string };
    assertEq(input.successUrl, "https://vibepin.co/welcome", "evil origin → default vibepin.co");
  });

  await test("success_url falls back to vibepin.co when no origin header", async () => {
    const res = await route.POST(makeReq({ plan: "starter", interval: "month" }) as never);
    assertEq(res.status, 200, "status");
    const input = fakes.lastCheckoutInput as { successUrl: string };
    assertEq(input.successUrl, "https://vibepin.co/welcome", "no origin → default");
  });

  await test("returns { url } from the created checkout", async () => {
    fakes.checkout = async () => ({ checkoutUrl: "https://test-api.creem.io/checkout/xyz" });
    const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
    assertEq(res.status, 200, "status");
    const json = (await res.json()) as { url: string };
    assertEq(json.url, "https://test-api.creem.io/checkout/xyz", "url passthrough");
  });

  await test("502 checkout_failed on upstream failure", async () => {
    fakes.checkout = async () => {
      throw new Error("creem down");
    };
    const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
    assertEq(res.status, 502, "status");
    const json = (await res.json()) as { error: string };
    assertEq(json.error, "checkout_failed", "error shape");
    fakes.checkout = async () => ({ checkoutUrl: "https://test-api.creem.io/checkout/abc" });
  });

  await test("502 when the user has no email (cannot build customer)", async () => {
    fakes.email = null;
    const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
    assertEq(res.status, 502, "status");
    fakes.email = "buyer@example.com";
  });

  await test("500 plan_not_configured when the env mapping is unset", async () => {
    const saved = process.env.CREEM_PRODUCT_STARTER_MONTHLY;
    delete process.env.CREEM_PRODUCT_STARTER_MONTHLY;
    try {
      const res = await route.POST(makeReq({ plan: "starter", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 500, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "plan_not_configured", "error shape");
    } finally {
      process.env.CREEM_PRODUCT_STARTER_MONTHLY = saved;
    }
  });

  // ── Billing-mode production release guard (Fix 1) ─────────────────────────────

  await test("mode=disabled → 503 billing_disabled (paid CTA shows coming soon)", async () => {
    const saved = process.env.CREEM_MODE;
    process.env.CREEM_MODE = "disabled";
    try {
      const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 503, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "billing_disabled", "error shape");
    } finally {
      process.env.CREEM_MODE = saved;
    }
  });

  await test("mode unset defaults to disabled → 503", async () => {
    const saved = process.env.CREEM_MODE;
    delete process.env.CREEM_MODE;
    try {
      const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 503, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "billing_disabled", "error shape");
    } finally {
      process.env.CREEM_MODE = saved;
    }
  });

  await test("production + mode=test (test key) → 500 billing_misconfigured", async () => {
    const savedMode = process.env.CREEM_MODE;
    const savedVercel = process.env.VERCEL_ENV;
    process.env.CREEM_MODE = "test";
    process.env.VERCEL_ENV = "production";
    try {
      const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 500, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "billing_misconfigured", "error shape");
    } finally {
      process.env.CREEM_MODE = savedMode;
      if (savedVercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedVercel;
    }
  });

  await test("mode=live with a test key → 500 billing_misconfigured", async () => {
    const savedMode = process.env.CREEM_MODE;
    process.env.CREEM_MODE = "live"; // CREEM_API_KEY is still creem_test_fake
    try {
      const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 500, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "billing_misconfigured", "live+test-key → misconfigured");
    } finally {
      process.env.CREEM_MODE = savedMode;
    }
  });

  await test("mode=live missing a product env → 500 billing_misconfigured", async () => {
    const savedMode = process.env.CREEM_MODE;
    const savedKey = process.env.CREEM_API_KEY;
    const savedProd = process.env.CREEM_PRODUCT_PRO_MONTHLY;
    const savedSecret = process.env.CREEM_WEBHOOK_SECRET;
    process.env.CREEM_MODE = "live";
    process.env.CREEM_API_KEY = "creem_live_fake"; // non-test key
    process.env.CREEM_WEBHOOK_SECRET = "whsec_fake";
    delete process.env.CREEM_PRODUCT_PRO_MONTHLY; // incomplete live config
    try {
      const res = await route.POST(makeReq({ plan: "pro", interval: "month" }, "https://vibepin.co") as never);
      assertEq(res.status, 500, "status");
      const json = (await res.json()) as { error: string };
      assertEq(json.error, "billing_misconfigured", "live+missing product → misconfigured");
    } finally {
      process.env.CREEM_MODE = savedMode;
      process.env.CREEM_API_KEY = savedKey;
      if (savedProd === undefined) delete process.env.CREEM_PRODUCT_PRO_MONTHLY;
      else process.env.CREEM_PRODUCT_PRO_MONTHLY = savedProd;
      if (savedSecret === undefined) delete process.env.CREEM_WEBHOOK_SECRET;
      else process.env.CREEM_WEBHOOK_SECRET = savedSecret;
    }
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
