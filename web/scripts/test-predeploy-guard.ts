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

  await test("CREEM_MODE=live + creem_test_ billing key → refused", () => {
    const problems = check({ CREEM_MODE: "live", CREEM_API_KEY: "creem_test_abc123" });
    assertEq(problems.length, 1, "one problem");
    assert(/test key/.test(problems[0]), "message mentions a test key");
  });

  await test("test billing key WITHOUT live mode → NOT policed (Demo posture)", () => {
    // Only CREEM_MODE=live requires a live billing key. Under disabled/unset the
    // billing key is not checked — a separate test MODERATION key powers the Demo.
    assertEq(check({ CREEM_API_KEY: "creem_test_abc123" }).length, 0, "test billing key alone is not a deploy blocker");
    assertEq(check({ CREEM_MODE: "disabled", CREEM_API_KEY: "creem_test_abc123" }).length, 0, "disabled + test billing key is fine");
  });

  await test("live mode + live key → no problem", () => {
    assertEq(check({ CREEM_MODE: "live", CREEM_API_KEY: "creem_live_x" }).length, 0, "clean");
  });

  await test("test mode is still refused regardless of key", () => {
    assertEq(check({ CREEM_MODE: "test", CREEM_API_KEY: "creem_test_x" }).length, 1, "only the mode problem");
  });

  await test("disabled mode + no key → no problem", () => {
    assertEq(check({ CREEM_MODE: "disabled" }).length, 0, "clean");
  });

  await test("moderation key is never policed by the deploy guard", () => {
    // The guard only knows about billing. A test moderation key must not block deploy.
    assertEq(check({ CREEM_MODE: "disabled", CREEM_MODERATION_API_KEY: "creem_test_mod" }).length, 0, "moderation key ignored");
  });

  await test("empty env → no problem (nothing to flag)", () => {
    assertEq(check({}).length, 0, "clean");
  });

  // ── Unmerged-branch check (2026-07-22 multi-session clobbering) ─────────────
  type Branch = { name: string; missing: number; unmergedFromMain: number; ageDays: number };
  const guard2 = (await import("./predeploy-guard.mjs")) as unknown as {
    checkUnmergedBranches: (
      branches: Branch[],
      opts: { currentBranch: string; staleAfterDays?: number; ignorePatterns?: RegExp[] },
    ) => string[];
  };
  const unmerged = guard2.checkUnmergedBranches;
  const OPTS = { currentBranch: "deploy-me" };
  const b = (over: Partial<Branch> & { name: string }): Branch =>
    ({ missing: 5, unmergedFromMain: 5, ageDays: 0, ...over });

  console.log("\npredeploy-guard unmerged-branch tests\n");

  await test("exports the pure unmerged check", () => {
    assert(typeof unmerged === "function", "checkUnmergedBranches exported");
  });

  await test("another session's active unmerged branch → refused", () => {
    const problems = unmerged([b({ name: "feat/other-session" })], OPTS);
    assertEq(problems.length, 1, "one problem");
    assert(/feat\/other-session/.test(problems[0]), "names the branch that would be dropped");
    assert(/whole-tree replace/.test(problems[0]), "explains why it matters");
  });

  await test("the branch being deployed never blocks itself", () => {
    assertEq(unmerged([b({ name: "deploy-me" })], OPTS).length, 0, "self is excluded");
  });

  await test("branch fully contained in this deploy → not flagged", () => {
    assertEq(unmerged([b({ name: "already-in", missing: 0 })], OPTS).length, 0, "nothing would be dropped");
  });

  await test("finished branch already merged to the integration branch → not flagged", () => {
    // The core noise filter: work that landed in master is accounted for even
    // though this deploy branch predates the merge. Without this the guard would
    // flag every stale-but-merged branch and train people to --override.
    assertEq(unmerged([b({ name: "shipped", unmergedFromMain: 0 })], OPTS).length, 0, "merged work is not pending");
  });

  await test("long-abandoned branch → not flagged", () => {
    assertEq(unmerged([b({ name: "old-experiment", ageDays: 99 })], OPTS).length, 0, "stale branch is not active work");
    assertEq(unmerged([b({ name: "edge", ageDays: 7 })], OPTS).length, 1, "exactly at the threshold still counts");
  });

  await test("per-agent worktree scratch refs are ignored by default", () => {
    assertEq(unmerged([b({ name: "worktree-agent-abc123" })], OPTS).length, 0, "scratch refs ignored");
  });

  await test("multiple dropped branches → one problem listing all, worst first", () => {
    const problems = unmerged([
      b({ name: "small", missing: 2 }),
      b({ name: "big", missing: 40 }),
      b({ name: "deploy-me" }),
      b({ name: "merged", unmergedFromMain: 0 }),
    ], OPTS);
    assertEq(problems.length, 1, "single aggregated problem");
    assert(/2 other active branch/.test(problems[0]), "counts only the real drops");
    assert(problems[0].indexOf("big") < problems[0].indexOf("small"), "most-affected branch listed first");
    assert(!/merged/.test(problems[0]), "merged branch excluded");
  });

  await test("no branches at all → no problem", () => {
    assertEq(unmerged([], OPTS).length, 0, "clean");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
