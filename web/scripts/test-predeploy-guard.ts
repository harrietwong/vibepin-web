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
    checkCreemPreviewTestConfig: (
      env: Record<string, string | undefined>,
      stableOrigins: readonly string[],
    ) => string[];
    checkDeploymentBillingContract: (
      env: Record<string, string | undefined>,
      stableOrigins: readonly string[],
    ) => string[];
    isProductionDeployTarget: (env: Record<string, string | undefined>) => boolean;
    isTruthyUsageEnforceFlag: (value: string | undefined) => boolean;
    checkUsageEnforceForProd: (env: Record<string, string | undefined>) => string[];
    checkUsageRpcsPresent: (opts: {
      supabaseUrl?: string;
      serviceKey?: string;
      fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
    }) => Promise<string[]>;
  };
  const check = guard.checkBillingModeForProd;
  const checkPreview = guard.checkCreemPreviewTestConfig;
  const checkDeployment = guard.checkDeploymentBillingContract;

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

  console.log("\npredeploy-guard Preview Creem return-origin tests\n");
  const manifest = (await import("../config/creem-preview-origin-manifest.json")).default as {
    stableOrigins: string[];
  };
  const stableOrigins = manifest.stableOrigins;

  await test("manifest records the exact stable Preview alias", () => {
    assertEq(stableOrigins.length, 1, "one audited stable alias");
    assertEq(stableOrigins[0], "https://vibepin-fb-preview.vercel.app", "exact alias");
  });

  await test("exports the pure Preview Test config check", () => {
    assert(typeof checkPreview === "function", "checkCreemPreviewTestConfig exported");
  });

  await test("Preview Test billing requires the manifest stable alias", () => {
    const problems = checkPreview(
      { VERCEL_ENV: "preview", CREEM_MODE: "test", CREEM_API_KEY: "creem_test_fake" },
      stableOrigins,
    );
    assertEq(problems.length, 1, "missing stable origin is refused");
    assert(/CREEM_PREVIEW_SUCCESS_ORIGIN/.test(problems[0]), "names the missing variable");
  });

  await test("Preview Test billing accepts the exact manifest stable alias", () => {
    assertEq(
      checkPreview(
        {
          VERCEL_ENV: "preview",
          CREEM_MODE: "test",
          CREEM_API_KEY: "creem_test_fake",
          CREEM_PREVIEW_SUCCESS_ORIGIN: "https://vibepin-fb-preview.vercel.app",
        },
        stableOrigins,
      ).length,
      0,
      "exact stable alias accepted",
    );
  });

  await test("Preview Test billing rejects an unlisted or malformed stable alias", () => {
    for (const origin of [
      "https://attacker.vercel.app",
      "http://vibepin-fb-preview.vercel.app",
      "https://vibepin-fb-preview.vercel.app/",
      "https://vibepin-fb-preview.vercel.app?next=evil",
    ]) {
      assertEq(
        checkPreview(
          {
            VERCEL_ENV: "preview",
            CREEM_MODE: "test",
            CREEM_API_KEY: "creem_test_fake",
            CREEM_PREVIEW_SUCCESS_ORIGIN: origin,
          },
          stableOrigins,
        ).length,
        1,
        `${origin} refused`,
      );
    }
  });

  await test("Preview Test billing rejects a non-test billing key", () => {
    assertEq(
      checkPreview(
        {
          VERCEL_ENV: "preview",
          CREEM_MODE: "test",
          CREEM_API_KEY: "creem_live_fake",
          CREEM_PREVIEW_SUCCESS_ORIGIN: stableOrigins[0],
        },
        stableOrigins,
      ).length,
      1,
      "wrong key refused",
    );
  });

  await test("Production and non-Test Preview configs do not require a Preview alias", () => {
    assertEq(checkPreview({ VERCEL_ENV: "production", CREEM_MODE: "live" }, stableOrigins).length, 0, "production ignored");
    assertEq(checkPreview({ VERCEL_ENV: "preview", CREEM_MODE: "disabled" }, stableOrigins).length, 0, "disabled Preview ignored");
  });

  console.log("\npredeploy-guard deployment aggregation tests\n");

  await test("exports the environment-targeted deployment billing contract", () => {
    assert(typeof checkDeployment === "function", "checkDeploymentBillingContract exported");
  });

  await test("production + test billing is refused by the production check", () => {
    const problems = checkDeployment({ VERCEL_ENV: "production", CREEM_MODE: "test" }, stableOrigins);
    assertEq(problems.length, 1, "one production problem");
    assert(/CREEM_MODE is "test"/.test(problems[0]), "production check is selected");
  });

  await test("manual predeploy guard defaults an unset target to production and refuses test billing", () => {
    const problems = checkDeployment({ CREEM_MODE: "test" }, stableOrigins);
    assertEq(problems.length, 1, "one default-production problem");
    assert(/CREEM_MODE is "test"/.test(problems[0]), "unset target uses production billing guard");
  });

  await test("Preview + complete test billing is accepted by the Preview check", () => {
    assertEq(
      checkDeployment(
        {
          VERCEL_ENV: "preview",
          CREEM_MODE: "test",
          CREEM_API_KEY: "creem_test_fake",
          CREEM_PREVIEW_SUCCESS_ORIGIN: stableOrigins[0],
        },
        stableOrigins,
      ).length,
      0,
      "Preview sandbox config is not treated as production",
    );
  });

  await test("Preview + incomplete test billing is refused by the Preview check", () => {
    const problems = checkDeployment(
      { VERCEL_ENV: "preview", CREEM_MODE: "test", CREEM_API_KEY: "creem_test_fake" },
      stableOrigins,
    );
    assertEq(problems.length, 1, "missing Preview alias is refused");
    assert(/CREEM_PREVIEW_SUCCESS_ORIGIN/.test(problems[0]), "Preview problem is selected");
  });

  await test("Preview live and disabled retain their explicit no-alias semantics", () => {
    assertEq(checkDeployment({ VERCEL_ENV: "preview", CREEM_MODE: "live" }, stableOrigins).length, 0, "Preview live is not a sandbox-alias gate");
    assertEq(checkDeployment({ VERCEL_ENV: "preview", CREEM_MODE: "disabled" }, stableOrigins).length, 0, "Preview disabled is not a sandbox-alias gate");
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

  // ── Usage-quota enforcement must actually be wired on (free "10 AI images" launch) ──
  const checkEnforce = guard.checkUsageEnforceForProd;
  const isTruthyUsageFlag = guard.isTruthyUsageEnforceFlag;
  const isProdTarget = guard.isProductionDeployTarget;

  console.log("\npredeploy-guard usage-enforce tests\n");

  await test("exports the pure usage-enforce check and its helpers", () => {
    assert(typeof checkEnforce === "function", "checkUsageEnforceForProd exported");
    assert(typeof isTruthyUsageFlag === "function", "isTruthyUsageEnforceFlag exported");
    assert(typeof isProdTarget === "function", "isProductionDeployTarget exported");
  });

  const FULLY_ENFORCED_ENV = {
    USAGE_METERING_MODE: "enforce",
    USAGE_ENFORCE_AI_IMAGES: "1",
    USAGE_ENFORCE_AI_TEXT: "1",
    GENERATION_INTENT_KEY_SALT: "a-real-secret",
  };

  await test("all four requirements met on a production target → no problem", () => {
    assertEq(checkEnforce(FULLY_ENFORCED_ENV).length, 0, "clean");
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, VERCEL_ENV: "production" }).length, 0, "explicit production is also clean");
  });

  await test("USAGE_METERING_MODE missing/off → refused", () => {
    const { USAGE_METERING_MODE, ...rest } = FULLY_ENFORCED_ENV;
    const problems = checkEnforce(rest);
    assertEq(problems.length, 1, "one problem");
    assert(/USAGE_METERING_MODE/.test(problems[0]), "names the variable");
    assert(/enforce/.test(problems[0]), "mentions the required value");
  });

  await test("USAGE_METERING_MODE=shadow → refused with a message distinguishing shadow from off", () => {
    const problems = checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_METERING_MODE: "shadow" });
    assertEq(problems.length, 1, "one problem");
    assert(/shadow/.test(problems[0]), "names shadow specifically");
    assert(/records|blocks nothing/.test(problems[0]), "explains shadow only records");
  });

  await test("USAGE_ENFORCE_AI_IMAGES missing → refused", () => {
    const { USAGE_ENFORCE_AI_IMAGES, ...rest } = FULLY_ENFORCED_ENV;
    const problems = checkEnforce(rest);
    assertEq(problems.length, 1, "one problem");
    assert(/USAGE_ENFORCE_AI_IMAGES/.test(problems[0]), "names the variable");
  });

  await test("USAGE_ENFORCE_AI_TEXT missing → refused", () => {
    const { USAGE_ENFORCE_AI_TEXT, ...rest } = FULLY_ENFORCED_ENV;
    const problems = checkEnforce(rest);
    assertEq(problems.length, 1, "one problem");
    assert(/USAGE_ENFORCE_AI_TEXT/.test(problems[0]), "names the variable");
  });

  await test("GENERATION_INTENT_KEY_SALT missing/blank → refused", () => {
    const { GENERATION_INTENT_KEY_SALT, ...rest } = FULLY_ENFORCED_ENV;
    assertEq(checkEnforce(rest).length, 1, "unset refused");
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, GENERATION_INTENT_KEY_SALT: "   " }).length, 1, "whitespace-only refused");
  });

  await test("runtime truthiness is mirrored exactly: only \"1\"/\"true\" count, not \"yes\"", () => {
    // meterGeneration.isTruthyFlag (runtime) accepts ONLY "1"/"true". A value like
    // "yes" must still be refused here even though it would look "on" to the
    // guard's OTHER (looser) isTruthyEnv helper used elsewhere in this file.
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_ENFORCE_AI_IMAGES: "yes" }).length, 1, "\"yes\" is not truthy at runtime");
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_ENFORCE_AI_TEXT: "on" }).length, 1, "\"on\" is not truthy at runtime");
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_ENFORCE_AI_IMAGES: "TRUE" }).length, 0, "case-insensitive true is accepted");
    assertEq(checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_ENFORCE_AI_TEXT: "1" }).length, 0, "\"1\" is accepted");
  });

  await test("USAGE_ENFORCE_SCHEDULED_POSTS is never required by this check", () => {
    assertEq(checkEnforce(FULLY_ENFORCED_ENV).length, 0, "absent scheduled-posts flag does not block");
    assertEq(
      checkEnforce({ ...FULLY_ENFORCED_ENV, USAGE_ENFORCE_SCHEDULED_POSTS: "0" }).length,
      0,
      "explicitly-off scheduled-posts flag does not block",
    );
  });

  await test("non-production target (Preview) → not checked at all, even with everything missing", () => {
    assertEq(checkEnforce({ VERCEL_ENV: "preview" }).length, 0, "Preview is exempt");
    assertEq(isProdTarget({ VERCEL_ENV: "preview" }), false, "isProductionDeployTarget agrees");
  });

  await test("unset VERCEL_ENV is treated as production (fail closed), same as check 6's billing rule", () => {
    assertEq(isProdTarget({}), true, "unset target is production");
    const { USAGE_METERING_MODE, ...rest } = FULLY_ENFORCED_ENV;
    assertEq(checkEnforce(rest).length, 1, "unset VERCEL_ENV still enforces the check");
  });

  await test("multiple missing requirements are all reported, not just the first", () => {
    assertEq(checkEnforce({}).length, 4, "all four problems reported");
  });

  // ── Usage RPC presence (PostgREST OpenAPI probe) ─────────────────────────────
  const checkRpcs = guard.checkUsageRpcsPresent;
  const FAKE_URL = "https://fake-project.supabase.co";
  const FAKE_KEY = "FAKE-SERVICE-ROLE-KEY-8f3a";
  const ALL_RPC_NAMES = [
    "usage_ensure_account",
    "usage_reserve",
    "usage_reserve_generation_job_v2",
    "usage_settle_reservation_item",
    "usage_release_reservation",
    "usage_expire_reservations",
  ];
  function specWith(names: string[]): { paths: Record<string, unknown> } {
    const paths: Record<string, unknown> = {};
    for (const n of names) paths[`/rpc/${n}`] = {};
    return { paths };
  }
  function neverCalledFetch() {
    return async () => {
      throw new Error("fetchImpl must not be called");
    };
  }

  console.log("\npredeploy-guard usage-RPC-presence tests\n");

  await test("exports the async RPC-presence check", () => {
    assert(typeof checkRpcs === "function", "checkUsageRpcsPresent exported");
  });

  await test("missing supabaseUrl/serviceKey → problem, fetch never called", async () => {
    const problems = await checkRpcs({ fetchImpl: neverCalledFetch() as never });
    assertEq(problems.length, 1, "one problem");
    assert(/NEXT_PUBLIC_SUPABASE_URL/.test(problems[0]), "names missing URL var");
    assert(/SUPABASE_SERVICE_ROLE_KEY/.test(problems[0]), "names missing key var");
  });

  await test("missing only the service key → problem, fetch never called", async () => {
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, fetchImpl: neverCalledFetch() as never });
    assertEq(problems.length, 1, "one problem");
    assert(/SUPABASE_SERVICE_ROLE_KEY/.test(problems[0]), "names missing key var");
  });

  await test("all RPCs present → no problem, and the request contract is correct", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init?.headers ?? {};
      return { ok: true, status: 200, json: async () => specWith(ALL_RPC_NAMES) };
    };
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 0, "clean");
    assertEq(seenUrl, `${FAKE_URL}/rest/v1/`, "hits the PostgREST OpenAPI root");
    assertEq(seenHeaders.apikey, FAKE_KEY, "sends apikey header");
    assertEq(seenHeaders.Authorization, `Bearer ${FAKE_KEY}`, "sends Bearer auth header");
  });

  await test("missing usage_reserve_generation_job_v2 → problem naming it and migration v71", async () => {
    const names = ALL_RPC_NAMES.filter((n) => n !== "usage_reserve_generation_job_v2");
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => specWith(names) });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
    assert(/usage_reserve_generation_job_v2/.test(problems[0]), "names the missing RPC");
    assert(/v71/.test(problems[0]), "names migration v71");
  });

  await test("exact-key membership: having ONLY _v2 does not satisfy plain usage_reserve", async () => {
    // Regression guard for a substring-matching bug: /rpc/usage_reserve must not be
    // considered present merely because /rpc/usage_reserve_generation_job_v2 exists.
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => specWith(ALL_RPC_NAMES.filter((n) => n !== "usage_reserve")),
    });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
    assert(/\/rpc\/usage_reserve(?!_)/.test(problems[0].replace(/usage_reserve_generation_job_v2/g, "")), "still flags plain usage_reserve as missing");
  });

  await test("multiple missing RPCs are all listed in one problem", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => specWith([]) });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "single aggregated problem");
    for (const name of ALL_RPC_NAMES) {
      assert(problems[0].includes(name), `mentions ${name}`);
    }
  });

  await test("non-2xx response → problem, not a silent pass", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
    assert(/500/.test(problems[0]), "mentions the status code");
  });

  await test("fetch throws (network failure) → problem, not a silent pass", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
    assert(/ECONNREFUSED|could not verify/.test(problems[0]), "surfaces the failure");
  });

  await test("malformed body (no usable paths object) → problem, not a silent pass", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ notPaths: true }) });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
  });

  await test("json() itself throwing (unparseable body) → problem, not a silent pass", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token in JSON");
      },
    });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    assertEq(problems.length, 1, "one problem");
  });

  await test("invalid supabaseUrl → problem, fetch never called", async () => {
    const problems = await checkRpcs({
      supabaseUrl: "not a url",
      serviceKey: FAKE_KEY,
      fetchImpl: neverCalledFetch() as never,
    });
    assertEq(problems.length, 1, "one problem");
  });

  await test("the service key is never leaked into any problem message or the target host", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const problems = await checkRpcs({ supabaseUrl: FAKE_URL, serviceKey: FAKE_KEY, fetchImpl: fetchImpl as never });
    const joined = problems.join("\n");
    assert(!joined.includes(FAKE_KEY), "problem text excludes the raw key");
    assert(joined.includes("fake-project.supabase.co"), "problem text includes only the host");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
