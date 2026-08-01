/**
 * planEntitlements consistency tests.
 * Run: npx tsx scripts/test-plan-entitlements.ts
 *
 * Asserts the metered quota numbers in web/src/lib/planEntitlements.ts match the
 * DISPLAY values shown on the pricing page (pricingPlans.ts COMPARISON_SECTIONS),
 * so enforcement and marketing never drift. No network.
 */

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
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

/** Parse a COMPARISON_SECTIONS display cell into a number, or null for "Unlimited". */
function parseDisplayLimit(cell: string): number | null {
  const s = cell.trim().toLowerCase();
  if (s.includes("unlimited")) return null;
  // "10 / month", "3,000 / month", "150 / month"
  const m = /([\d,]+)/.exec(s);
  if (!m) throw new Error(`unparseable display cell: "${cell}"`);
  return Number(m[1].replace(/,/g, ""));
}

async function main() {
  const { PLAN_ENTITLEMENTS, limitForUsageType } = await import("../src/lib/planEntitlements");
  const { COMPARISON_SECTIONS } = await import("../src/lib/pricingPlans");

  console.log("\nplanEntitlements consistency tests\n");

  // Locate the display rows.
  const allRows = COMPARISON_SECTIONS.flatMap((s) => s.rows);
  const imageRow = allRows.find((r) => r.label === "AI image credits");
  const scheduledRow = allRows.find((r) => r.label === "Scheduled posts");
  const platformsRow = allRows.find((r) => r.label === "Connected platforms");
  const accountsRow = allRows.find((r) => r.label === "Accounts per platform");

  await test("pricingPlans still exposes the rows this test depends on", () => {
    if (!imageRow) throw new Error("AI image credits row missing");
    if (!scheduledRow) throw new Error("Scheduled posts row missing");
    if (!platformsRow) throw new Error("Connected platforms row missing");
    if (!accountsRow) throw new Error("Accounts per platform row missing");
  });

  const planOrder = ["free", "starter", "pro", "business"] as const;

  await test("monthlyAiImages matches the AI image credits display cells", () => {
    planOrder.forEach((plan, i) => {
      assertEq(
        PLAN_ENTITLEMENTS[plan].monthlyAiImages,
        parseDisplayLimit(imageRow!.values[i]),
        `${plan} AI images`,
      );
    });
  });

  await test("monthlyScheduledPosts matches the Scheduled posts display cells (Business = Unlimited/null)", () => {
    planOrder.forEach((plan, i) => {
      assertEq(
        PLAN_ENTITLEMENTS[plan].monthlyScheduledPosts,
        parseDisplayLimit(scheduledRow!.values[i]),
        `${plan} scheduled posts`,
      );
    });
    assertEq(PLAN_ENTITLEMENTS.business.monthlyScheduledPosts, null, "business scheduled = unlimited");
  });

  await test("connectedPlatforms matches the Connected platforms display cells (1/4/4/4)", () => {
    planOrder.forEach((plan, i) => {
      assertEq(
        PLAN_ENTITLEMENTS[plan].connectedPlatforms,
        parseDisplayLimit(platformsRow!.values[i]),
        `${plan} connected platforms`,
      );
    });
  });

  await test("accountsPerPlatform matches the Accounts per platform display cells (1/1/2/3)", () => {
    planOrder.forEach((plan, i) => {
      assertEq(
        PLAN_ENTITLEMENTS[plan].accountsPerPlatform,
        parseDisplayLimit(accountsRow!.values[i]),
        `${plan} accounts per platform`,
      );
    });
  });

  await test("monthlyAiTextGenerations is null for every plan (metered, never limited)", () => {
    planOrder.forEach((plan) => {
      assertEq(PLAN_ENTITLEMENTS[plan].monthlyAiTextGenerations, null, `${plan} ai text`);
    });
  });

  await test("limitForUsageType maps each usage type to the right field", () => {
    assertEq(limitForUsageType("free", "ai_image"), 10, "free ai_image");
    assertEq(limitForUsageType("business", "ai_image"), 3000, "business ai_image");
    assertEq(limitForUsageType("pro", "scheduled_post"), 300, "pro scheduled_post");
    assertEq(limitForUsageType("business", "scheduled_post"), null, "business scheduled_post unlimited");
    assertEq(limitForUsageType("starter", "ai_text_generation"), null, "starter ai_text null");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
