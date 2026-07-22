/**
 * Canonical PlanEntitlements tests (task 1C-a).
 * Run: npx tsx scripts/test-plan-entitlements.ts
 *
 * Asserts:
 *   - every plan key carries every allowance with the exact v3.1 frozen numbers
 *   - null == unlimited (business scheduled posts)
 *   - the pricing DISPLAY strings derive to exactly today's published values
 *     (AI images with the 3,000 comma; scheduled posts with "Unlimited")
 *   - the unpublished text numbers (20/500/2000/10000) do NOT leak into ANY
 *     pricing display string
 *   - Shopify limits still match the pre-existing entitlements.ts values, and the
 *     SHOPIFY_PRODUCT_LIMIT_* env override still works after unification
 *
 * No network. tsx CJS cache note: `?query=` busters do NOT work under tsx —
 * re-import a module fresh via `delete require.cache[require.resolve(...)]`.
 */

// entitlements.ts pulls in supabase.ts, which reads these at import time.
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

// Frozen v3.1 contract. Any drift here is a product-contract change, not a refactor.
const FROZEN = {
  free: { img: 10, text: 20, sched: 5, accts: 1, stores: 0, products: 0 },
  starter: { img: 150, text: 500, sched: 150, accts: 1, stores: 1, products: 100 },
  pro: { img: 800, text: 2000, sched: 300, accts: 2, stores: 2, products: 500 },
  business: { img: 3000, text: 10000, sched: null, accts: 3, stores: 3, products: 1000 },
} as const;

type PK = keyof typeof FROZEN;
const PLANS: PK[] = ["free", "starter", "pro", "business"];

async function main() {
  const pe = await import("../src/lib/server/planEntitlements");

  console.log("\nCanonical PlanEntitlements tests\n");

  // ── Frozen numbers, every plan, every allowance ────────────────────────────
  await test("every plan carries every allowance with the exact frozen v3.1 numbers", () => {
    for (const p of PLANS) {
      const e = pe.getPlanEntitlements(p);
      const f = FROZEN[p];
      assertEq(e.planKey, p, `${p} planKey`);
      assertEq(e.monthlyAiImages, f.img, `${p} monthlyAiImages`);
      assertEq(e.monthlyAiTextGenerations, f.text, `${p} monthlyAiTextGenerations`);
      assertEq(e.monthlyScheduledPosts, f.sched, `${p} monthlyScheduledPosts`);
      assertEq(e.connectedAccountsPerPlatform, f.accts, `${p} connectedAccountsPerPlatform`);
      assertEq(e.maxStores, f.stores, `${p} maxStores`);
      assertEq(e.maxSyncedProducts, f.products, `${p} maxSyncedProducts`);
    }
  });

  await test("rank ordering is free 0 < starter 1 < pro 2 < business 3", () => {
    assertEq(pe.getPlanEntitlements("free").rank, 0, "free rank");
    assertEq(pe.getPlanEntitlements("starter").rank, 1, "starter rank");
    assertEq(pe.getPlanEntitlements("pro").rank, 2, "pro rank");
    assertEq(pe.getPlanEntitlements("business").rank, 3, "business rank");
  });

  await test("null == unlimited only for business scheduled posts", () => {
    assert(pe.isUnlimited(pe.getPlanEntitlements("business").monthlyScheduledPosts), "business sched unlimited");
    assert(!pe.isUnlimited(pe.getPlanEntitlements("pro").monthlyScheduledPosts), "pro sched capped");
    assert(!pe.isUnlimited(pe.getPlanEntitlements("free").monthlyScheduledPosts), "free sched capped");
    // No other allowance is unlimited anywhere in the frozen table.
    for (const p of PLANS) {
      const e = pe.getPlanEntitlements(p);
      assert(!pe.isUnlimited(e.monthlyAiImages), `${p} images not unlimited`);
      assert(!pe.isUnlimited(e.monthlyAiTextGenerations), `${p} text not unlimited`);
      assert(!pe.isUnlimited(e.connectedAccountsPerPlatform), `${p} accts not unlimited`);
    }
  });

  await test("getAllowance typed accessor returns the same values as the lookup", () => {
    assertEq(pe.getAllowance("business", "monthlyScheduledPosts"), null, "business sched via accessor");
    assertEq(pe.getAllowance("pro", "monthlyAiImages"), 800, "pro images via accessor");
    assertEq(pe.getAllowance("starter", "maxSyncedProducts"), 100, "starter products via accessor");
  });

  // ── Formatters → exact published pricing strings ───────────────────────────
  await test("AI image credits row derives EXACTLY to today's published values (3,000 keeps its comma)", () => {
    const row = pe.allowanceRowValues("monthlyAiImages", pe.formatMonthlyAllowance);
    assertEq(
      JSON.stringify(row),
      JSON.stringify(["10 / month", "150 / month", "800 / month", "3,000 / month"]),
      "AI image credits values",
    );
  });

  await test("Scheduled posts row derives EXACTLY to today's published values (business = Unlimited)", () => {
    const row = pe.allowanceRowValues("monthlyScheduledPosts", pe.formatMonthlyAllowance);
    assertEq(
      JSON.stringify(row),
      JSON.stringify(["5 / month", "150 / month", "300 / month", "Unlimited"]),
      "Scheduled posts values",
    );
  });

  await test("Accounts per platform row derives EXACTLY to today's published values", () => {
    const row = pe.allowanceRowValues("connectedAccountsPerPlatform", pe.formatPlainCount);
    assertEq(JSON.stringify(row), JSON.stringify(["1", "1", "2", "3"]), "Accounts per platform values");
  });

  await test("formatCount inserts the en-US thousands comma", () => {
    assertEq(pe.formatCount(3000), "3,000", "3000 → 3,000");
    assertEq(pe.formatCount(10000), "10,000", "10000 → 10,000");
    assertEq(pe.formatCount(150), "150", "150 stays 150");
  });

  // ── The actual published pricingPlans.ts wiring ────────────────────────────
  await test("pricingPlans COMPARISON_SECTIONS renders the four allowance rows byte-identical to before", async () => {
    const pp = await import("../src/lib/pricingPlans");
    const rows = pp.COMPARISON_SECTIONS.flatMap((s) => s.rows);
    const byLabel = (label: string) => rows.find((r) => r.label === label);

    assertEq(
      JSON.stringify(byLabel("AI image credits")?.values),
      JSON.stringify(["10 / month", "150 / month", "800 / month", "3,000 / month"]),
      "AI image credits (published)",
    );
    assertEq(
      JSON.stringify(byLabel("Scheduled posts")?.values),
      JSON.stringify(["5 / month", "150 / month", "300 / month", "Unlimited"]),
      "Scheduled posts (published)",
    );
    assertEq(
      JSON.stringify(byLabel("Accounts per platform")?.values),
      JSON.stringify(["1", "1", "2", "3"]),
      "Accounts per platform (published)",
    );
    // "Connected platforms" (1/4/4/4) is NOT one of the four canonical allowances
    // and stays hardcoded — assert it is unchanged so we know we didn't touch it.
    assertEq(
      JSON.stringify(byLabel("Connected platforms")?.values),
      JSON.stringify(["1", "4", "4", "4"]),
      "Connected platforms (unchanged)",
    );
  });

  // ── Text numbers must not leak anywhere user-visible ───────────────────────
  await test("unpublished text-generation numbers (20/500/2000/10000) appear in NO pricing display string", async () => {
    const pp = await import("../src/lib/pricingPlans");
    // Collect every user-visible string the pricing surfaces render.
    const visible: string[] = [];
    for (const t of pp.PRICING_TIERS) {
      visible.push(t.name, t.description, t.cta, ...t.bullets, ...t.previewBullets);
    }
    for (const s of pp.COMPARISON_SECTIONS) {
      visible.push(s.title);
      for (const r of s.rows) {
        visible.push(r.label, ...(r.note ? [r.note] : []), ...r.values);
      }
    }
    for (const f of pp.PRICING_FAQ) visible.push(f.question, f.answer);
    visible.push(pp.ACCOUNTS_HELPER_TEXT, ...pp.ENTERPRISE_PLAN.bullets, ...pp.PRICING_REASSURANCE);

    const haystack = visible.join("\n");
    // Whole-number match (word boundaries so "150" ⊄ a check for "50" etc.).
    for (const n of ["500", "2000", "2,000", "10000", "10,000"]) {
      assert(
        !new RegExp(`\\b${n.replace(/,/g, ",?")}\\b`).test(haystack),
        `text-limit number "${n}" leaked into a pricing display string`,
      );
    }
    // "20" is a common substring (e.g. "Save 20%" is elsewhere) — assert the
    // text value itself is not published as a standalone allowance figure.
    assert(!/\b20 (AI|text|monthly)/i.test(haystack), `"20" text allowance leaked`);
    // Sanity: the number DOES live in the config.
    assertEq(pe.getPlanEntitlements("free").monthlyAiTextGenerations, 20, "text limit is in the config");
    assertEq(pe.getPlanEntitlements("business").monthlyAiTextGenerations, 10000, "biz text in config");
  });

  // ── Shopify limits unchanged after unification + env override still works ───
  await test("entitlements.ts Shopify limits still match the pre-existing values (derived from the config)", async () => {
    const ent = await import("../src/lib/server/entitlements");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.free), '{"maxStores":0,"maxSyncedProducts":0}', "free");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.starter), '{"maxStores":1,"maxSyncedProducts":100}', "starter");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.pro), '{"maxStores":2,"maxSyncedProducts":500}', "pro");
    assertEq(JSON.stringify(ent.DEFAULT_PLAN_ENTITLEMENTS.business), '{"maxStores":3,"maxSyncedProducts":1000}', "business");
    assertEq(ent.getEntitlements("business").maxStores, 3, "getEntitlements business maxStores");
    assertEq(ent.getEntitlements("business").maxSyncedProducts, 1000, "getEntitlements business maxSyncedProducts");
  });

  await test("SHOPIFY_PRODUCT_LIMIT_* env override still overrides maxSyncedProducts after unification", async () => {
    // Fresh import so entitlements.ts re-reads env (it reads on every call, but
    // re-import proves no module-level cache captured the pre-override value).
    delete require.cache[require.resolve("../src/lib/server/entitlements")];
    const ent = await import("../src/lib/server/entitlements");
    process.env.SHOPIFY_PRODUCT_LIMIT_STARTER = "250";
    try {
      assertEq(ent.getEntitlements("starter").maxSyncedProducts, 250, "override applied");
      assertEq(ent.getEntitlements("starter").maxStores, 1, "maxStores untouched by override");
      assertEq(ent.getEntitlements("pro").maxSyncedProducts, 500, "other plans keep config defaults");
    } finally {
      delete process.env.SHOPIFY_PRODUCT_LIMIT_STARTER;
    }
    assertEq(ent.getEntitlements("starter").maxSyncedProducts, 100, "default restored after cleanup");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
