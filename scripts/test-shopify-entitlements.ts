/**
 * Shopify entitlements unit tests (WP1).
 * Run: npx tsx scripts/test-shopify-entitlements.ts
 *
 * Mocks the auth-admin lookup via resolvePlan's deps parameter. No network.
 */

// Env must be set BEFORE the server modules load (supabase.ts reads env at import).
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
for (const k of [
  "SHOPIFY_PRODUCT_LIMIT_FREE",
  "SHOPIFY_PRODUCT_LIMIT_STARTER",
  "SHOPIFY_PRODUCT_LIMIT_PRO",
  "SHOPIFY_PRODUCT_LIMIT_BUSINESS",
]) {
  delete process.env[k];
}

export {};

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

type MockUser = { email: string | null; plan: unknown };
function deps(user: MockUser | null) {
  return { getUserById: async (_userId: string) => user };
}

async function main() {
  const ent = await import("../src/lib/server/entitlements");

  console.log("\nShopify entitlements tests\n");

  // ── Entitlement numbers ─────────────────────────────────────────────────────
  await test("default entitlement table: free 0/0, starter 1/100, pro 2/500, business 3/1000", () => {
    assertEq(ent.getEntitlements("free").maxStores, 0, "free maxStores");
    assertEq(ent.getEntitlements("free").maxSyncedProducts, 0, "free maxSyncedProducts");
    assertEq(ent.getEntitlements("starter").maxStores, 1, "starter maxStores");
    assertEq(ent.getEntitlements("starter").maxSyncedProducts, 100, "starter maxSyncedProducts");
    assertEq(ent.getEntitlements("pro").maxStores, 2, "pro maxStores");
    assertEq(ent.getEntitlements("pro").maxSyncedProducts, 500, "pro maxSyncedProducts");
    assertEq(ent.getEntitlements("business").maxStores, 3, "business maxStores");
    assertEq(ent.getEntitlements("business").maxSyncedProducts, 1000, "business maxSyncedProducts");
  });

  await test("DEFAULT_PLAN_ENTITLEMENTS constant table matches the spec numbers", () => {
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.free), '{"maxStores":0,"maxSyncedProducts":0}', "free");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.starter), '{"maxStores":1,"maxSyncedProducts":100}', "starter");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.pro), '{"maxStores":2,"maxSyncedProducts":500}', "pro");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.business), '{"maxStores":3,"maxSyncedProducts":1000}', "business");
  });

  // ── Env overrides for maxSyncedProducts ────────────────────────────────────
  await test("SHOPIFY_PRODUCT_LIMIT_* env overrides maxSyncedProducts (valid value)", () => {
    process.env.SHOPIFY_PRODUCT_LIMIT_STARTER = "250";
    try {
      assertEq(ent.getEntitlements("starter").maxSyncedProducts, 250, "starter overridden");
      assertEq(ent.getEntitlements("starter").maxStores, 1, "maxStores untouched by override");
      assertEq(ent.getEntitlements("pro").maxSyncedProducts, 500, "other plans keep defaults");
    } finally {
      delete process.env.SHOPIFY_PRODUCT_LIMIT_STARTER;
    }
  });

  await test("env override: zero is a valid explicit limit", () => {
    process.env.SHOPIFY_PRODUCT_LIMIT_PRO = "0";
    try {
      assertEq(ent.getEntitlements("pro").maxSyncedProducts, 0, "pro overridden to 0");
    } finally {
      delete process.env.SHOPIFY_PRODUCT_LIMIT_PRO;
    }
  });

  await test("env override: invalid / negative / empty values fall back to defaults", () => {
    process.env.SHOPIFY_PRODUCT_LIMIT_STARTER = "abc";
    process.env.SHOPIFY_PRODUCT_LIMIT_PRO = "-5";
    process.env.SHOPIFY_PRODUCT_LIMIT_BUSINESS = "   ";
    try {
      assertEq(ent.getEntitlements("starter").maxSyncedProducts, 100, "non-numeric → default");
      assertEq(ent.getEntitlements("pro").maxSyncedProducts, 500, "negative → default");
      assertEq(ent.getEntitlements("business").maxSyncedProducts, 1000, "blank → default");
    } finally {
      delete process.env.SHOPIFY_PRODUCT_LIMIT_STARTER;
      delete process.env.SHOPIFY_PRODUCT_LIMIT_PRO;
      delete process.env.SHOPIFY_PRODUCT_LIMIT_BUSINESS;
    }
  });

  await test("env override cleanup restores defaults (no cached leakage)", () => {
    assertEq(ent.getEntitlements("starter").maxSyncedProducts, 100, "starter default restored");
    assertEq(ent.getEntitlements("pro").maxSyncedProducts, 500, "pro default restored");
  });

  // ── normalizePlanKey ────────────────────────────────────────────────────────
  await test("normalizePlanKey accepts the four plans (case/space tolerant), rejects everything else", () => {
    assertEq(ent.normalizePlanKey("free"), "free", "free");
    assertEq(ent.normalizePlanKey("Starter "), "starter", "trims + lowercases");
    assertEq(ent.normalizePlanKey("PRO"), "pro", "uppercase");
    assertEq(ent.normalizePlanKey("business"), "business", "business");
    assertEq(ent.normalizePlanKey("enterprise"), null, "unknown plan");
    assertEq(ent.normalizePlanKey(""), null, "empty");
    assertEq(ent.normalizePlanKey(42), null, "non-string");
    assertEq(ent.normalizePlanKey(undefined), null, "undefined");
  });

  // ── resolvePlan: metadata plan ─────────────────────────────────────────────
  await test("resolvePlan reads user_metadata.plan for all four plans", async () => {
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: "free" })), "free", "free");
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: "starter" })), "starter", "starter");
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: "pro" })), "pro", "pro");
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: "business" })), "business", "business");
  });

  await test("resolvePlan: unknown metadata plan falls back to free", async () => {
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: "enterprise" })), "free", "unknown → free");
    assertEq(await ent.resolvePlan("u1", deps({ email: "a@example.com", plan: 7 })), "free", "non-string → free");
  });

  // ── resolvePlan: whitelist mapping (aligned with useUserTier.ts) ───────────
  await test("resolvePlan maps the useUserTier email whitelist to pro", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "zhihuihuang321@gmail.com", plan: undefined })),
      "pro",
      "whitelisted email → pro",
    );
  });

  await test("resolvePlan whitelist match is case/space-insensitive", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: " ZhiHuiHuang321@Gmail.com ", plan: undefined })),
      "pro",
      "case-insensitive whitelist",
    );
  });

  await test("resolvePlan: whitelist floors the plan at pro but never downgrades", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "zhihuihuang321@gmail.com", plan: "starter" })),
      "pro",
      "starter + whitelist → pro",
    );
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "zhihuihuang321@gmail.com", plan: "business" })),
      "business",
      "business + whitelist stays business",
    );
  });

  // ── resolvePlan: defaults ──────────────────────────────────────────────────
  await test("resolvePlan defaults to free (no metadata, not whitelisted)", async () => {
    assertEq(await ent.resolvePlan("u1", deps({ email: "nobody@example.com", plan: undefined })), "free", "default free");
    assertEq(await ent.resolvePlan("u1", deps({ email: null, plan: undefined })), "free", "no email");
  });

  await test("resolvePlan: missing user or lookup failure → free", async () => {
    assertEq(await ent.resolvePlan("u1", deps(null)), "free", "user not found → free");
    assertEq(
      await ent.resolvePlan("u1", {
        getUserById: async () => {
          throw new Error("admin API down");
        },
      }),
      "free",
      "lookup throws → free",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
