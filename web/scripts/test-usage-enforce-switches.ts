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
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
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

  // ── decideWhenLedgerUnavailable (decision 2026-09-25) ─────────────────────────
  // enforce on, ledger cannot answer: free / unknown / lookup-throws → block; paid → allow.
  const { decideWhenLedgerUnavailable, usageUnavailableResponseBody } = meter;
  for (const plan of ["free"] as const) {
    await test(`decideWhenLedgerUnavailable: plan=${plan} → block`, async () => {
      const d = await decideWhenLedgerUnavailable({ userId: "u1", type: "ai_image", reason: "error", deps: { resolvePlan: async () => plan } });
      assertEq(d.block, true, "free is refused");
      assertEq(d.plan, "free", "plan echoed");
    });
  }
  for (const plan of ["starter", "pro", "business"] as const) {
    await test(`decideWhenLedgerUnavailable: plan=${plan} → allow (unmetered)`, async () => {
      const d = await decideWhenLedgerUnavailable({ userId: "u1", type: "ai_text_generation", reason: "error", deps: { resolvePlan: async () => plan } });
      assertEq(d.block, false, `${plan} proceeds`);
      assertEq(d.plan, plan, "plan echoed");
    });
  }
  await test("decideWhenLedgerUnavailable: plan lookup THROWS → plan 'unknown', block", async () => {
    const d = await decideWhenLedgerUnavailable({
      userId: "u1", type: "ai_image", reason: "skipped",
      deps: { resolvePlan: async () => { throw new Error("down"); } },
    });
    assertEq(d.block, true, "unknown is treated as free");
    assertEq(d.plan, "unknown", "plan reported as unknown");
  });
  await test("decideWhenLedgerUnavailable: decision log carries type/reason/plan/decision and NO user id", async () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try {
      await decideWhenLedgerUnavailable({ userId: "user-secret-123", type: "ai_image", reason: "error", deps: { resolvePlan: async () => "free" } });
    } finally {
      console.warn = orig;
    }
    const line = seen.find(l => l.includes("usage_meter_unavailable_decision"));
    assert(!!line, "decision event logged");
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    assertEq(parsed.type, "ai_image", "type");
    assertEq(parsed.reason, "error", "reason");
    assertEq(parsed.plan, "free", "plan");
    assertEq(parsed.decision, "block", "decision");
    assert(!line!.includes("user-secret-123"), "no user id in the log");
  });
  await test("usageUnavailableResponseBody: image + text envelopes", () => {
    const img = usageUnavailableResponseBody("image", "gen_1");
    assertEq(img.code, "usage_unavailable", "image code");
    assertEq(img.generation_request_id, "gen_1", "image request id");
    assertEq((img.urls as unknown[]).length, 0, "image urls empty");
    const txt = usageUnavailableResponseBody("text", "req_1");
    assertEq(txt.code, "usage_unavailable", "text code");
    assertEq(txt.requestId, "req_1", "text request id");
    assert(typeof txt.userMessage === "string" && (txt.userMessage as string).length > 0, "text prose");
  });

  // ── warnIfEnforceDisabledInProduction (misconfiguration alarm, throttled) ─────
  const { warnIfEnforceDisabledInProduction, __resetEnforceDisabledWarningsForTests, ENFORCE_DISABLED_WARN_INTERVAL_MS } = meter;
  async function captureErrors(fn: () => void): Promise<string[]> {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try { fn(); } finally { console.error = orig; }
    return seen.filter(l => l.includes("usage_enforce_disabled_in_production"));
  }
  const savedVercelEnv = process.env.VERCEL_ENV;
  await test("warnIfEnforceDisabledInProduction: production + switch off → logs once with type/mode", async () => {
    clearEnv(); __resetEnforceDisabledWarningsForTests();
    process.env.VERCEL_ENV = "production";
    process.env.USAGE_METERING_MODE = "shadow";
    try {
      let ret = false;
      const lines = await captureErrors(() => { ret = warnIfEnforceDisabledInProduction("ai_image", { now: () => 1_000 }); });
      assertEq(ret, true, "reported logging");
      assertEq(lines.length, 1, "exactly one alarm line");
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      assertEq(parsed.type, "ai_image", "type");
      assertEq(parsed.mode, "shadow", "mode");
    } finally {
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedVercelEnv;
      clearEnv();
    }
  });
  await test("warnIfEnforceDisabledInProduction: second call inside the window is silent; after the window it logs again; other types are independent", async () => {
    clearEnv(); __resetEnforceDisabledWarningsForTests();
    process.env.VERCEL_ENV = "production";
    try {
      const first = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_text_generation", { now: () => 10_000 }); });
      const within = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_text_generation", { now: () => 10_000 + ENFORCE_DISABLED_WARN_INTERVAL_MS - 1 }); });
      const otherType = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_image", { now: () => 10_001 }); });
      const after = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_text_generation", { now: () => 10_000 + ENFORCE_DISABLED_WARN_INTERVAL_MS }); });
      assertEq(first.length, 1, "first call logs");
      assertEq(within.length, 0, "throttled inside the 10-minute window");
      assertEq(otherType.length, 1, "per-type throttle");
      assertEq(after.length, 1, "logs again once the window elapsed");
    } finally {
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedVercelEnv;
      clearEnv();
    }
  });
  await test("warnIfEnforceDisabledInProduction: non-production never logs; production with the switch ON never logs", async () => {
    clearEnv(); __resetEnforceDisabledWarningsForTests();
    try {
      process.env.VERCEL_ENV = "preview";
      const preview = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_image", { now: () => 1 }); });
      delete process.env.VERCEL_ENV;
      const unset = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_image", { now: () => 2 }); });
      process.env.VERCEL_ENV = "production";
      process.env.USAGE_METERING_MODE = "enforce";
      process.env.USAGE_ENFORCE_AI_IMAGES = "true";
      const enforced = await captureErrors(() => { warnIfEnforceDisabledInProduction("ai_image", { now: () => 3 }); });
      assertEq(preview.length, 0, "preview silent");
      assertEq(unset.length, 0, "local/unset silent");
      assertEq(enforced.length, 0, "production with enforce on is silent");
    } finally {
      if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedVercelEnv;
      clearEnv(); __resetEnforceDisabledWarningsForTests();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
