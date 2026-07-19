/**
 * predeploy-guard billing-mode check unit test (WP-Billing, Fix 1).
 * Run: npx tsx scripts/test-predeploy-guard.ts
 *
 * Drives the pure `checkBillingModeForProd(env)` export from predeploy-guard.mjs
 * with fake env — proving a production deploy is refused when billing is in test
 * mode (CREEM_MODE=test) or configured with a test key (creem_test_…). Importing
 * the guard module must be side-effect free (no git/filesystem/process.exit); the
 * guard body only runs when invoked directly as the entrypoint.
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
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // Importing the guard for its pure export must NOT run the git/fs body.
  const guard = (await import("./predeploy-guard.mjs")) as {
    checkBillingModeForProd: (env: Record<string, string | undefined>) => string[];
  };
  const check = guard.checkBillingModeForProd;

  console.log("\npredeploy-guard billing-mode tests\n");

  await test("import is side-effect free and exports the pure check", () => {
    assert(typeof check === "function", "checkBillingModeForProd exported");
  });

  await test("CREEM_MODE=test → refused", () => {
    const problems = check({ CREEM_MODE: "test" });
    assertEq(problems.length, 1, "one problem");
    assert(/CREEM_MODE is "test"/.test(problems[0]), "message mentions CREEM_MODE=test");
  });

  await test("CREEM_MODE=TEST (case-insensitive) → refused", () => {
    assertEq(check({ CREEM_MODE: "TEST" }).length, 1, "case-insensitive test mode");
  });

  await test("CREEM_API_KEY=creem_test_… → refused", () => {
    const problems = check({ CREEM_API_KEY: "creem_test_abc123" });
    assertEq(problems.length, 1, "one problem");
    assert(/test key/.test(problems[0]), "message mentions a test key");
  });

  await test("both a test mode AND a test key → two problems", () => {
    assertEq(check({ CREEM_MODE: "test", CREEM_API_KEY: "creem_test_x" }).length, 2, "both flagged");
  });

  await test("live mode + live key → no problem", () => {
    assertEq(check({ CREEM_MODE: "live", CREEM_API_KEY: "creem_live_x" }).length, 0, "clean");
  });

  await test("disabled mode + no key → no problem", () => {
    assertEq(check({ CREEM_MODE: "disabled" }).length, 0, "clean");
  });

  await test("empty env → no problem (nothing to flag)", () => {
    assertEq(check({}).length, 0, "clean");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
