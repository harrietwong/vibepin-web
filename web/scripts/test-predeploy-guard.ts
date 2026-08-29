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

  // ── AI-copy text model pinning ───────────────────────────────────────────────
  // Without an explicit AI_COPY_TEXT_MODEL, providerConfig() falls back to a
  // provider-DEPENDENT default — so swapping a credential silently swaps the model
  // that writes user-facing copy. Deploy-time guard only; the runtime fallback stays.
  const checkModel = (guard as unknown as {
    checkAiCopyTextModelForProd: (env: Record<string, string | undefined>) => string[];
  }).checkAiCopyTextModelForProd;

  await test("exports the pure AI-copy text-model check", () => {
    assert(typeof checkModel === "function", "checkAiCopyTextModelForProd exported");
  });

  await test("no provider credential → not policed (nothing can run)", () => {
    assertEq(checkModel({}).length, 0, "empty env is clean");
    assertEq(checkModel({ AI_COPY_TEXT_MODEL: "" }).length, 0, "blank model without a credential is clean");
    assertEq(checkModel({ LINAPI_KEY: "   " }).length, 0, "whitespace-only credential does not count as configured");
  });

  await test("LINAPI_KEY set + AI_COPY_TEXT_MODEL unset → refused", () => {
    const problems = checkModel({ LINAPI_KEY: "lin-abc" });
    assertEq(problems.length, 1, "one problem");
    assert(/AI_COPY_TEXT_MODEL/.test(problems[0]), "message names the variable");
  });

  await test("OPENAI_API_KEY set + AI_COPY_TEXT_MODEL unset → refused", () => {
    assertEq(checkModel({ OPENAI_API_KEY: "sk-abc" }).length, 1, "openai credential is policed too");
  });

  await test("credential + blank/whitespace AI_COPY_TEXT_MODEL → refused", () => {
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "" }).length, 1, "empty string");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "   " }).length, 1, "whitespace only");
  });

  await test("credential + explicit AI_COPY_TEXT_MODEL → no problem", () => {
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "gemini-2.5-flash" }).length, 0, "linapi pinned");
    assertEq(checkModel({ OPENAI_API_KEY: "sk-abc", AI_COPY_TEXT_MODEL: "gpt-4o-mini" }).length, 0, "openai pinned");
  });

  await test("credential + IMPLAUSIBLE AI_COPY_TEXT_MODEL → refused (Codex round 5: nonblank is not enough)", () => {
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "not a model" }).length, 1, "embedded whitespace");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "a".repeat(121) }).length, 1, "121 chars");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "-leading-dash" }).length, 1, "illegal first char");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "gemini 2.5" }).length, 1, "space");
    assert(/plausible/.test(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "not a model" })[0]), "message says why");
  });

  await test("credential + plausible-but-unusual ids → accepted (no allow-list by design)", () => {
    assertEq(checkModel({ OPENAI_API_KEY: "sk-abc", AI_COPY_TEXT_MODEL: "openai/gpt-4o-mini:latest" }).length, 0, "slash + colon");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "gemini-3.1-flash-image-preview" }).length, 0, "dots + dashes");
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "a".repeat(120) }).length, 0, "exactly 120 chars");
  });

  await test("AI_COPY_VISION_MODEL is NOT required by this check", () => {
    // Only the text model is pinned at deploy time; the vision fallback chain is
    // deliberately left intact and unpoliced.
    assertEq(checkModel({ LINAPI_KEY: "lin-abc", AI_COPY_TEXT_MODEL: "m" }).length, 0, "vision model absent is fine");
  });

  await test("billing check and AI-copy check are independent", () => {
    // The billing guard must not react to AI-copy env, and vice versa.
    assertEq(check({ LINAPI_KEY: "lin-abc" }).length, 0, "billing check ignores provider credentials");
    assertEq(checkModel({ CREEM_MODE: "test" }).length, 0, "AI-copy check ignores billing mode");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
