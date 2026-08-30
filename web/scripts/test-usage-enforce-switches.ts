/**
 * Per-type enforce switches (product decision #8, 2026-08-28).
 * Run: npx tsx scripts/test-usage-enforce-switches.ts   (registered in CORE)
 *
 * The three usage types (AI images, AI text generation, scheduled posts) must be
 * switchable independently. USAGE_METERING_MODE stays the single global ON/OFF for
 * the ledger itself (off = no ledger call at all; shadow/enforce both record). Whether
 * an `insufficient` outcome actually BLOCKS the request is a SEPARATE, per-type
 * decision layered on top via usageEnforceFor(type):
 *
 *   usageEnforceFor(type) === true  iff  USAGE_METERING_MODE === "enforce"
 *                                    AND the matching per-type flag is truthy:
 *                                      USAGE_ENFORCE_AI_IMAGES       (ai_image)
 *                                      USAGE_ENFORCE_AI_TEXT         (ai_text_generation)
 *                                      USAGE_ENFORCE_SCHEDULED_POSTS (scheduled_post)
 *
 * Setting the global mode to "enforce" ALONE blocks NOTHING until the matching
 * per-type flag is also turned on — that is the whole point: enforcement rolls out
 * type by type, not as one global cutover.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}\n      ${(e as Error).message}`);
  }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const MODE_KEY = "USAGE_METERING_MODE";
const FLAG_KEYS = ["USAGE_ENFORCE_AI_IMAGES", "USAGE_ENFORCE_AI_TEXT", "USAGE_ENFORCE_SCHEDULED_POSTS"] as const;
const ALL_ENV_KEYS = [MODE_KEY, ...FLAG_KEYS] as const;

function clearEnv() {
  for (const k of ALL_ENV_KEYS) delete process.env[k];
}

async function main() {
  console.log("\nPer-type usage enforce switches (decision #8)\n");

  const meter = await import("../src/lib/server/usage/meterGeneration");
  const { usageEnforceFor, USAGE_ENFORCE_ENV_VAR } = meter;

  await test("UNIT: the three env var names are exactly as documented", () => {
    assertEq(USAGE_ENFORCE_ENV_VAR.ai_image, "USAGE_ENFORCE_AI_IMAGES", "ai_image flag name");
    assertEq(USAGE_ENFORCE_ENV_VAR.ai_text_generation, "USAGE_ENFORCE_AI_TEXT", "ai_text_generation flag name");
    assertEq(USAGE_ENFORCE_ENV_VAR.scheduled_post, "USAGE_ENFORCE_SCHEDULED_POSTS", "scheduled_post flag name");
  });

  await test("mode=off: all three types are false, regardless of flags", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "off";
    process.env.USAGE_ENFORCE_AI_IMAGES = "true";
    process.env.USAGE_ENFORCE_AI_TEXT = "true";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    assertEq(usageEnforceFor("ai_image"), false, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), false, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), false, "scheduled_post");
    clearEnv();
  });

  await test("mode=shadow + all flags on: all three types are STILL false (shadow never blocks)", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "shadow";
    process.env.USAGE_ENFORCE_AI_IMAGES = "1";
    process.env.USAGE_ENFORCE_AI_TEXT = "1";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "1";
    assertEq(usageEnforceFor("ai_image"), false, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), false, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), false, "scheduled_post");
    clearEnv();
  });

  await test("mode=enforce + no flags set: all three types are false (global mode alone blocks nothing)", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    assertEq(usageEnforceFor("ai_image"), false, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), false, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), false, "scheduled_post");
    clearEnv();
  });

  await test("mode=enforce + exactly USAGE_ENFORCE_AI_IMAGES on: ONLY ai_image is true", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_AI_IMAGES = "true";
    assertEq(usageEnforceFor("ai_image"), true, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), false, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), false, "scheduled_post");
    clearEnv();
  });

  await test("mode=enforce + exactly USAGE_ENFORCE_AI_TEXT on: ONLY ai_text_generation is true", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_AI_TEXT = "true";
    assertEq(usageEnforceFor("ai_image"), false, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), true, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), false, "scheduled_post");
    clearEnv();
  });

  await test("mode=enforce + exactly USAGE_ENFORCE_SCHEDULED_POSTS on: ONLY scheduled_post is true", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    assertEq(usageEnforceFor("ai_image"), false, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), false, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), true, "scheduled_post");
    clearEnv();
  });

  await test("mode=enforce + all three flags on: all three types are true", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    process.env.USAGE_ENFORCE_AI_IMAGES = "true";
    process.env.USAGE_ENFORCE_AI_TEXT = "true";
    process.env.USAGE_ENFORCE_SCHEDULED_POSTS = "true";
    assertEq(usageEnforceFor("ai_image"), true, "ai_image");
    assertEq(usageEnforceFor("ai_text_generation"), true, "ai_text_generation");
    assertEq(usageEnforceFor("scheduled_post"), true, "scheduled_post");
    clearEnv();
  });

  // -- Flag value parsing: "1"/"true" accepted case-insensitively, everything else rejected --
  const ACCEPTED = ["true", "1", "TRUE", "True", "tRuE"];
  const REJECTED = ["0", "false", "FALSE", "", "yes", "on", "  ", "2"];

  for (const v of ACCEPTED) {
    await test(`flag value "${v}" is accepted (mode=enforce, USAGE_ENFORCE_AI_IMAGES="${v}")`, () => {
      clearEnv();
      process.env.USAGE_METERING_MODE = "enforce";
      process.env.USAGE_ENFORCE_AI_IMAGES = v;
      assertEq(usageEnforceFor("ai_image"), true, `"${v}" should be truthy`);
      clearEnv();
    });
  }

  for (const v of REJECTED) {
    await test(`flag value "${v}" is rejected (mode=enforce, USAGE_ENFORCE_AI_IMAGES="${v}")`, () => {
      clearEnv();
      process.env.USAGE_METERING_MODE = "enforce";
      process.env.USAGE_ENFORCE_AI_IMAGES = v;
      assertEq(usageEnforceFor("ai_image"), false, `"${v}" should be falsy`);
      clearEnv();
    });
  }

  await test("an unset flag (never assigned) defaults to false, same as an empty string", () => {
    clearEnv();
    process.env.USAGE_METERING_MODE = "enforce";
    // USAGE_ENFORCE_AI_TEXT intentionally never set.
    assertEq(usageEnforceFor("ai_text_generation"), false, "unset defaults to false");
    clearEnv();
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
