#!/usr/bin/env node
/**
 * predeploy-guard.mjs
 *
 * Gate for production deploys. Run from `web/`:
 *
 *   node scripts/predeploy-guard.mjs
 *   node scripts/predeploy-guard.mjs --override
 *
 * Checks (all must pass, unless --override is used):
 *   1. Working tree is clean (ignoring web/tmp, web/artifacts,
 *      web/playwright-report, web/test-results, and *.log files).
 *   2. HEAD is not detached.
 *   3. web/.vercel/project.json points at the expected Vercel project.
 *   4. E2E_TEST_MODE is not truthy.
 *   4b. ENABLE_LOCAL_ADMIN_BYPASS is not truthy (it grants no-auth super-admin).
 *   5. PINTEREST_API_ENV is not "sandbox".
 *   6. Billing is not in test mode for production. CREEM_MODE is never "test".
 *      The billing CREEM_API_KEY is policed ONLY when CREEM_MODE is "live" (then
 *      it must be a real live key, not a test key) — because only "live" opens
 *      real checkout. Under CREEM_MODE=disabled (the review/Demo posture) the
 *      billing key is expected to be EMPTY and is not checked, so a test-mode
 *      MODERATION key (a separate CREEM_MODERATION_API_KEY) can power Create Pins
 *      generation without tripping the deploy guard. This is the deploy-time half
 *      of the billingMode guard.
 *   7. The deploy would not drop another active branch's work. `vercel --prod`
 *      is a whole-tree replace, so a deploy that omits other sessions' merged-
 *      nowhere commits silently removes their shipped features from production.
 *   8. AI_COPY_TEXT_MODEL is set (non-blank) whenever an AI-copy provider
 *      credential (LINAPI_KEY or OPENAI_API_KEY) is configured — production must
 *      not run copy generation on an implicit, credential-dependent default.
 *   9. For a production target: usage-quota enforcement is actually wired on —
 *      USAGE_METERING_MODE=enforce, USAGE_ENFORCE_AI_IMAGES and
 *      USAGE_ENFORCE_AI_TEXT are truthy (runtime semantics: only "1"/"true"
 *      count — see usageEnforceFor in src/lib/server/usage/meterGeneration.ts),
 *      and GENERATION_INTENT_KEY_SALT is non-empty. Without all four, the "free
 *      10 AI images" launch would ship with no real cap on generation cost.
 *      USAGE_ENFORCE_SCHEDULED_POSTS is NOT required here (still printed as
 *      informational only).
 *  10. For a production target: the Supabase project actually has the usage RPCs
 *      the metering code calls (usage_ensure_account, usage_reserve,
 *      usage_reserve_generation_job_v2, usage_settle_reservation_item,
 *      usage_release_reservation, usage_expire_reservations). Verified live via
 *      PostgREST's OpenAPI listing — a missing RPC means every reservation call
 *      errors at runtime even though the switches above are all correctly set.
 *
 * Checks 9-10 are gated on "is this a production target?" using the same
 * VERCEL_ENV rule as the billing contract (check 6): VERCEL_ENV === "preview"
 * is exempt; anything else (including unset, e.g. a manual local run of
 * `npm run predeploy:guard`) is treated as production and fails closed.
 *
 * --override requires OVERRIDE_REASON to be set to a non-empty string. When
 * present, an override bypasses failed checks, appends an audit line to
 * scripts/deploy-overrides.log, prints a loud warning, and exits 0. Without
 * OVERRIDE_REASON, passing --override is itself a failure.
 *
 * Node built-ins only — no dependencies. All git/filesystem operations use
 * explicit paths (never a shell `cd`), so this works regardless of the
 * process's working directory and regardless of non-ASCII characters
 * anywhere in the repo path (Windows-safe).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PROJECT_ID = "prj_dhGFUEZmiktBHuwmCCP7uVNHLsdR";
const EXPECTED_ORG_ID = "team_6NHzK2v5iYmRl9Syvn8ulQW0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, ".."); // scripts/ -> web/

/**
 * Billing must not be in test mode for a production deploy: a test-mode Creem key
 * must never open real checkout on production. Pure (env in → problems out) and
 * exported at the top BEFORE any side effects, so a unit test can import and drive
 * it with fake env without the guard's git/filesystem body running.
 */
export function checkBillingModeForProd(env) {
  const problems = [];
  const mode = String(env.CREEM_MODE ?? "").trim().toLowerCase();
  const apiKey = String(env.CREEM_API_KEY ?? "").trim();
  if (mode === "test") {
    problems.push('CREEM_MODE is "test" — refusing a production deploy (a test-mode billing key must never open real checkout). Set CREEM_MODE=live or =disabled.');
  }
  // The billing key is only relevant when checkout is actually live. Under
  // CREEM_MODE=disabled (review/Demo) the billing key is expected empty and is
  // NOT policed — this lets a test MODERATION key (CREEM_MODERATION_API_KEY, a
  // separate var) power generation without blocking the deploy. Only "live"
  // requires a real billing key.
  if (mode === "live" && apiKey.startsWith("creem_test_")) {
    problems.push("CREEM_MODE=live but CREEM_API_KEY is a test key (creem_test_…) — refusing a production deploy with a sandbox billing key.");
  }
  return problems;
}

/**
 * Preview Test checkout has an explicit return-destination contract. The stable
 * alias must be both an exact env value and an audited manifest entry; a Vercel
 * hostname pattern would turn an Origin header into an open redirect primitive.
 * Production and Preview configurations without sandbox billing are intentionally
 * outside this gate.
 */
export function checkCreemPreviewTestConfig(env, stableOrigins) {
  const preview = String(env.VERCEL_ENV ?? "").trim().toLowerCase() === "preview";
  const mode = String(env.CREEM_MODE ?? "").trim().toLowerCase();
  if (!preview || mode !== "test") return [];

  const problems = [];
  const apiKey = String(env.CREEM_API_KEY ?? "").trim();
  if (!apiKey.startsWith("creem_test_")) {
    problems.push("Preview CREEM_MODE=test requires a creem_test_ CREEM_API_KEY — refusing an invalid sandbox billing configuration.");
  }

  const origin = String(env.CREEM_PREVIEW_SUCCESS_ORIGIN ?? "").trim();
  if (!origin) {
    problems.push("Preview CREEM_MODE=test requires CREEM_PREVIEW_SUCCESS_ORIGIN to be an exact audited stable alias from web/config/creem-preview-origin-manifest.json.");
  } else if (!stableOrigins.includes(origin)) {
    problems.push("CREEM_PREVIEW_SUCCESS_ORIGIN is not an exact audited stable alias from web/config/creem-preview-origin-manifest.json — refusing Preview Test checkout.");
  }
  return problems;
}

/**
 * The single billing environment selector used by both the manual predeploy
 * guard and Vercel's build-time Preview gate. A Preview sandbox must never be
 * evaluated by the production-only rule merely because Next builds with
 * NODE_ENV=production.
 */
export function checkDeploymentBillingContract(env, stableOrigins) {
  const vercelEnv = String(env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercelEnv === "preview") return checkCreemPreviewTestConfig(env, stableOrigins);
  // `npm run predeploy:guard` is the manual production-release gate. Its target
  // may be unset outside Vercel, so fail closed by preserving production checks.
  return checkBillingModeForProd(env);
}

/**
 * Unmerged-work check (2026-07-22, after four sessions serially clobbered each
 * other's production deploys in one morning).
 *
 * `vercel --prod` replaces the whole tree — it does not merge. So whichever
 * session deploys last makes production 100% its branch, and every other
 * session's shipped work silently disappears from production even though its
 * commits are safe in git. The old guard passed all four of those deploys:
 * each had a clean tree, a named branch and the right project. Cleanliness was
 * never the problem; *completeness* was.
 *
 * So: a production deploy must carry every other active branch's work. Given
 * the branches that exist and, for each, how many of its commits are missing
 * from the commit being deployed, report every branch that would be dropped.
 *
 * Pure (inputs in → problems out) so a unit test can drive it without git.
 *
 * Two filters keep this honest rather than noisy — a guard that cries wolf
 * teaches people to reach for --override, which is worse than no guard:
 *  - `unmergedFromMain`: work already merged into the integration branch is NOT
 *    pending. A finished feature branch left lying around must not block anyone.
 *  - `ageDays`: long-abandoned branches (and per-agent worktree scratch refs)
 *    are not another session's live work.
 *
 * @param branches {Array<{name: string, missing: number, unmergedFromMain: number, ageDays: number}>}
 *   `missing` = commits on that branch not contained in the deploy target;
 *   `unmergedFromMain` = commits on it not contained in the integration branch.
 * @param opts {{currentBranch: string, staleAfterDays?: number, ignorePatterns?: RegExp[]}}
 */
export function checkUnmergedBranches(branches, opts) {
  const problems = [];
  const staleAfterDays = opts.staleAfterDays ?? 7;
  const ignorePatterns = opts.ignorePatterns ?? [/^worktree-agent-/];
  const dropped = branches.filter(b =>
    b.name !== opts.currentBranch &&
    b.missing > 0 &&
    b.unmergedFromMain > 0 &&
    b.ageDays <= staleAfterDays &&
    !ignorePatterns.some(re => re.test(b.name)),
  );
  if (dropped.length === 0) return problems;
  const list = dropped
    .sort((a, b) => b.missing - a.missing)
    .map(b => `      ${b.name} (${b.missing} commit${b.missing === 1 ? "" : "s"} not in this deploy, ${b.unmergedFromMain} not yet in the integration branch, last active ${b.ageDays}d ago)`)
    .join("\n");
  problems.push(
    `deploying ${opts.currentBranch} would drop work from ${dropped.length} other active branch(es) —\n` +
    `    production is a whole-tree replace, so their features would vanish from the live site:\n${list}\n` +
    "    Merge them first (or confirm each is intentionally not shipping) before deploying.",
  );
  return problems;
}

/**
 * The AI-copy fast text path falls back to a provider-dependent default model when
 * AI_COPY_TEXT_MODEL is unset (see providerConfig in src/lib/ai-copy/visionServer.ts).
 * That fallback is fine locally, but in production it means rotating or switching a
 * provider credential SILENTLY changes which model writes user-facing copy. So once an
 * AI-copy provider credential is configured at all, the model must be pinned explicitly.
 *
 * Deploy-time only — the runtime fallback in providerConfig() is deliberately kept for
 * local/test. Pure (env in → problems out) and exported at the top BEFORE any side
 * effects, so a unit test can drive it with fake env.
 */
// Mirror of web/src/lib/ai-copy/modelId.ts isPlausibleModelId — the guard is a
// dependency-free .mjs and cannot import the TS module, so the rule is duplicated
// here verbatim; modelId.ts is the source of truth and test-predeploy-guard pins both.
function isPlausibleModelId(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 120) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export function checkAiCopyTextModelForProd(env) {
  const problems = [];
  const hasProviderCredential =
    String(env.LINAPI_KEY ?? "").trim() !== "" || String(env.OPENAI_API_KEY ?? "").trim() !== "";
  if (!hasProviderCredential) return problems;
  const model = String(env.AI_COPY_TEXT_MODEL ?? "").trim();
  if (model === "") {
    problems.push(
      "an AI-copy provider credential is configured (LINAPI_KEY or OPENAI_API_KEY) but AI_COPY_TEXT_MODEL is unset/blank — " +
        "refusing a production deploy on an implicit default model (a credential change would silently change which model writes user copy). " +
        "Set AI_COPY_TEXT_MODEL explicitly.",
    );
  } else if (!isPlausibleModelId(model)) {
    problems.push(
      "AI_COPY_TEXT_MODEL is set but is not a plausible model id (" +
        "must be at most 120 chars, contain no whitespace, and match ^[A-Za-z0-9][A-Za-z0-9._:/-]*$) — " +
        "the runtime treats an implausible id exactly like an unset one and fails closed in production (PRD v3.2 §6.5). " +
        "Fix the value rather than deploying a model id the provider cannot resolve.",
    );
  }
  return problems;
}

/** Truthy = present and not "", "0" or "false" (case-insensitive). */
export function isTruthyEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Truthy exactly the way the RUNTIME reads a per-type usage-enforce flag (see
 * isTruthyFlag / usageEnforceFor in src/lib/server/usage/meterGeneration.ts):
 * ONLY "1" or "true" (case-insensitive) count. This is deliberately narrower
 * than isTruthyEnv() above — a value like "yes" would look "on" to isTruthyEnv
 * but is silently OFF at runtime, which is exactly the gap this guard exists
 * to catch. Exported so the informational print (below) and the blocking
 * check share one definition instead of drifting apart.
 */
export function isTruthyUsageEnforceFlag(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Whether the current invocation targets a production deploy. Mirrors check 6's
 * (checkDeploymentBillingContract) VERCEL_ENV rule exactly: VERCEL_ENV=preview is
 * exempt, everything else — including unset, e.g. a manual local run of
 * `npm run predeploy:guard` — is treated as production and fails closed.
 */
export function isProductionDeployTarget(env) {
  return String(env.VERCEL_ENV ?? "").trim().toLowerCase() !== "preview";
}

/**
 * Free-tier launch guard (2026-09-25): the site is about to open a free "10 AI
 * images" tier. Quota enforcement only actually blocks a request when ALL of the
 * following are true at once (see usageEnforceFor in
 * src/lib/server/usage/meterGeneration.ts):
 *   - USAGE_METERING_MODE=enforce (shadow only records; it blocks nothing)
 *   - the per-type flag for that usage type is truthy (runtime semantics: only
 *     "1"/"true" — see isTruthyUsageEnforceFlag above)
 * The worker (durable Create Pin intent) path additionally requires
 * GENERATION_INTENT_KEY_SALT to be non-empty, or every reservation throws
 * GenerationIntentSaltUnavailableError and generation fails with 503 — which is a
 * different, equally bad, failure to ship on launch day (outage, not cost blowout).
 *
 * Scoped to AI images and AI text only, because those are the two costed
 * generation types opening to a free tier. USAGE_ENFORCE_SCHEDULED_POSTS is
 * deliberately NOT required — it stays informational-only (an operator may
 * legitimately ship without it).
 *
 * Pure (env in → problems out), gated on isProductionDeployTarget so a Preview
 * deploy is never blocked by this. Exported before any side effects so a unit
 * test can drive it with fake env.
 */
export function checkUsageEnforceForProd(env) {
  if (!isProductionDeployTarget(env)) return [];
  const problems = [];

  const mode = String(env.USAGE_METERING_MODE ?? "off").trim().toLowerCase();
  if (mode !== "enforce") {
    problems.push(
      `USAGE_METERING_MODE is "${mode || "off"}", not "enforce" — refusing a production deploy of the free-tier launch with usage quota NOT enforced ` +
        "(shadow mode only records usage, it blocks nothing; a free account could generate unlimited paid AI images/text). Set USAGE_METERING_MODE=enforce.",
    );
  }

  if (!isTruthyUsageEnforceFlag(env.USAGE_ENFORCE_AI_IMAGES)) {
    problems.push(
      `USAGE_ENFORCE_AI_IMAGES is not enabled (runtime requires exactly "1" or "true"; got ${JSON.stringify(env.USAGE_ENFORCE_AI_IMAGES ?? "<unset>")}) — ` +
        "refusing a production deploy that would let free-tier AI image generation run with no quota cap (unbounded generation cost). Set USAGE_ENFORCE_AI_IMAGES=1.",
    );
  }

  if (!isTruthyUsageEnforceFlag(env.USAGE_ENFORCE_AI_TEXT)) {
    problems.push(
      `USAGE_ENFORCE_AI_TEXT is not enabled (runtime requires exactly "1" or "true"; got ${JSON.stringify(env.USAGE_ENFORCE_AI_TEXT ?? "<unset>")}) — ` +
        "refusing a production deploy that would let free-tier AI text generation run with no quota cap (unbounded generation cost). Set USAGE_ENFORCE_AI_TEXT=1.",
    );
  }

  const salt = String(env.GENERATION_INTENT_KEY_SALT ?? "").trim();
  if (!salt) {
    problems.push(
      "GENERATION_INTENT_KEY_SALT is unset/blank — refusing a production deploy: the durable Create Pin intent path throws " +
        "GenerationIntentSaltUnavailableError on every reservation without it, so generation would fail with 503 for every user, " +
        "not just free-tier ones. Set GENERATION_INTENT_KEY_SALT to a non-empty secret.",
    );
  }

  return problems;
}

/**
 * The exact set of usage RPCs the metering code calls at runtime, and the
 * migration that introduces each — surfaced in the failure message so whoever
 * is unblocking a deploy knows which migration to apply, not just which name
 * is missing. `_v2` is the newest (idempotent generation-intent) primitive; the
 * plain `usage_reserve` name is intentionally kept in the required set even
 * though `_v2` is what the durable Create Pin intent path actually calls,
 * because `usage_reserve` is still used by the legacy metering call sites.
 */
const REQUIRED_USAGE_RPCS = [
  { name: "usage_ensure_account", migration: "v56 (backend/db/migrate_v56_usage_account_lifecycle.sql)" },
  { name: "usage_reserve", migration: "v55 (backend/db/migrate_v55_usage_primitives.sql)" },
  { name: "usage_reserve_generation_job_v2", migration: "v71 (backend/db/migrate_v71_generation_intent_idempotency.sql)" },
  { name: "usage_settle_reservation_item", migration: "v55 (backend/db/migrate_v55_usage_primitives.sql)" },
  { name: "usage_release_reservation", migration: "v55 (backend/db/migrate_v55_usage_primitives.sql)" },
  { name: "usage_expire_reservations", migration: "v55 (backend/db/migrate_v55_usage_primitives.sql)" },
];

/**
 * Verifies the target Supabase project actually exposes the usage RPCs the
 * metering code calls, by reading PostgREST's OpenAPI root (`/rest/v1/`) and
 * checking its `paths` object for each `/rpc/<name>` key. A missing RPC means
 * every reservation call errors at runtime even when checkUsageEnforceForProd
 * above is fully green — the enforce switches and the database schema are two
 * independent things that must both be true.
 *
 * Exact-key membership only (never startsWith/includes): `/rpc/usage_reserve`
 * must NOT be considered present merely because `/rpc/usage_reserve_generation_job_v2`
 * exists in the same paths object.
 *
 * Any inability to positively confirm an RPC is present — network failure, non-2xx
 * response, unparseable body, missing/malformed `paths` — is itself a problem
 * ("could not verify"), never treated as a silent pass.
 *
 * Never logs or includes the service key in any problem message; only the
 * target host is surfaced, so a deploy log stays safe to paste.
 *
 * `fetchImpl` is injectable so a unit test never performs a real network call.
 *
 * @param opts {{ supabaseUrl?: string, serviceKey?: string, fetchImpl?: typeof fetch }}
 * @returns {Promise<string[]>}
 */
export async function checkUsageRpcsPresent({ supabaseUrl, serviceKey, fetchImpl } = {}) {
  const problems = [];
  const url = String(supabaseUrl ?? "").trim();
  const key = String(serviceKey ?? "").trim();

  if (!url || !key) {
    const missingNames = [!url && "NEXT_PUBLIC_SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
    problems.push(
      `cannot verify usage RPCs are present: ${missingNames.join(" and ")} not provided to the deploy session — ` +
        "the deploy session must export the production Supabase URL and service-role key before running the guard.",
    );
    return problems;
  }

  let host;
  try {
    host = new URL(url).host;
  } catch {
    problems.push(`cannot verify usage RPCs are present: NEXT_PUBLIC_SUPABASE_URL (${JSON.stringify(url)}) is not a valid URL.`);
    return problems;
  }

  const doFetch = fetchImpl ?? fetch;
  const restRoot = `${url.replace(/\/+$/, "")}/rest/v1/`;

  let spec;
  try {
    const res = await doFetch(restRoot, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/openapi+json",
      },
    });
    if (!res.ok) {
      problems.push(`could not verify usage RPCs are present on ${host}: PostgREST returned HTTP ${res.status}.`);
      return problems;
    }
    spec = await res.json();
  } catch (err) {
    problems.push(`could not verify usage RPCs are present on ${host}: request failed (${err?.message ?? "unknown error"}).`);
    return problems;
  }

  const paths = spec && typeof spec === "object" ? spec.paths : undefined;
  if (!paths || typeof paths !== "object") {
    problems.push(`could not verify usage RPCs are present on ${host}: PostgREST's OpenAPI response has no usable "paths" object.`);
    return problems;
  }

  const missing = REQUIRED_USAGE_RPCS.filter((rpc) => !Object.prototype.hasOwnProperty.call(paths, `/rpc/${rpc.name}`));
  if (missing.length > 0) {
    problems.push(
      `${host} is missing ${missing.length} required usage RPC(s) — reservation calls will error at runtime even with quota enforcement switches on:\n` +
        missing.map((rpc) => `      /rpc/${rpc.name} (apply migration ${rpc.migration})`).join("\n"),
    );
  }

  return problems;
}

/**
 * Auth bypasses must never reach a production deploy.
 *
 * Both flags hand out privileged access without authentication:
 *   • E2E_TEST_MODE — a request header (x-e2e-super-admin) becomes super_admin,
 *     and src/proxy.ts stops guarding /app/** entirely.
 *   • ENABLE_LOCAL_ADMIN_BYPASS — every /admin/** request is treated as super_admin.
 *
 * Both are ALSO hard-gated at runtime on NODE_ENV !== "production" (see
 * e2eTestModeEnabled / localAdminBypassEnabled in src/lib/server/superAdmin.ts).
 * This is the deploy-time half: defence in depth, so the flag never even ships.
 *
 * Pure (env in → problems out) and exported BEFORE any side effects so a unit
 * test can drive it with fake env.
 */
export function checkAuthBypassesForProd(env) {
  const problems = [];
  if (isTruthyEnv(env.E2E_TEST_MODE)) {
    problems.push(`E2E_TEST_MODE is set (${env.E2E_TEST_MODE}) — refusing a production deploy in test mode`);
  }
  if (isTruthyEnv(env.ENABLE_LOCAL_ADMIN_BYPASS)) {
    problems.push(
      `ENABLE_LOCAL_ADMIN_BYPASS is set (${env.ENABLE_LOCAL_ADMIN_BYPASS}) — refusing a production deploy with the no-auth local super-admin bypass enabled`,
    );
  }
  return problems;
}

// Only run the full guard (git + filesystem + process.exit) when invoked directly
// as the entrypoint — importing this module for its pure export must be side-effect
// free.
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (!isMainModule) {
  // Imported (e.g. by the unit test) — expose the pure check and stop here.
} else {
  runGuard().catch((err) => {
    console.error(`predeploy-guard: unexpected error: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

async function runGuard() {

const args = process.argv.slice(2);
const overrideRequested = args.includes("--override");

const failures = [];
const infoLines = [];

function runGit(gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: webDir,
    encoding: "utf8",
    windowsHide: true,
  }).toString();
}

// Resolve the repo root via git itself rather than assuming "one level up",
// so this remains correct even if the script is invoked in an unusual layout.
let repoRoot;
try {
  repoRoot = runGit(["rev-parse", "--show-toplevel"]).trim();
} catch (err) {
  failures.push(`could not determine git repo root: ${err.message}`);
  repoRoot = path.resolve(webDir, "..");
}

// --- Check 1: clean working tree (scoped to web/, with exclusions) ---
const IGNORED_PATTERNS = [
  /^web\/tmp\//,
  /^web\/artifacts\//,
  /^web\/playwright-report\//,
  /^web\/test-results\//,
];

function isIgnoredPath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.endsWith(".log")) return true;
  return IGNORED_PATTERNS.some((re) => re.test(normalized));
}

let dirtyEntries = [];
try {
  const statusOut = runGit(["-C", repoRoot, "status", "--porcelain"]);
  const lines = statusOut.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
  for (const line of lines) {
    // porcelain format: XY <path> (renames use "old -> new")
    const rawPath = line.slice(3);
    const relPath = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
    const normalized = relPath.replace(/\\/g, "/").replace(/^"|"$/g, "");
    if (!normalized.startsWith("web/")) continue;
    if (isIgnoredPath(normalized)) continue;
    dirtyEntries.push(line);
  }
} catch (err) {
  failures.push(`git status failed: ${err.message}`);
}

if (dirtyEntries.length > 0) {
  failures.push(
    [
      "dirty working tree — commit or stash before a production deploy:",
      ...dirtyEntries.map((e) => `    ${e}`),
    ].join("\n"),
  );
}

// --- Check 2: not detached HEAD ---
let branch = null;
let sha = null;
try {
  branch = runGit(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
  sha = runGit(["-C", repoRoot, "rev-parse", "HEAD"]).trim();
  if (branch === "HEAD") {
    failures.push(`detached HEAD (at ${sha}) — check out a branch before a production deploy`);
  } else {
    infoLines.push(`branch: ${branch}`);
    infoLines.push(`sha: ${sha}`);
  }
} catch (err) {
  failures.push(`git rev-parse failed: ${err.message}`);
}

// --- Check 3: Vercel project identity ---
try {
  const projectJsonPath = path.join(repoRoot, "web", ".vercel", "project.json");
  const raw = fs.readFileSync(projectJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.projectId !== EXPECTED_PROJECT_ID || parsed.orgId !== EXPECTED_ORG_ID) {
    failures.push(
      `web/.vercel/project.json does not match the expected Vercel project ` +
        `(got projectId=${parsed.projectId ?? "<missing>"}, orgId=${parsed.orgId ?? "<missing>"})`,
    );
  } else {
    infoLines.push("vercel project: ok");
  }
} catch (err) {
  failures.push(`could not read/parse web/.vercel/project.json: ${err.message}`);
}

// --- Check 4 (+4b): auth bypasses (E2E_TEST_MODE, ENABLE_LOCAL_ADMIN_BYPASS) ---
// See checkAuthBypassesForProd (top of file) — neither no-auth bypass may ship.
for (const problem of checkAuthBypassesForProd(process.env)) {
  failures.push(problem);
}

// --- Check 5: PINTEREST_API_ENV must not be "sandbox" ---
if (process.env.PINTEREST_API_ENV === "sandbox") {
  failures.push('PINTEREST_API_ENV is "sandbox" — refusing a production deploy against the sandbox Pinterest environment');
}

// --- Check 6: environment-targeted billing contract ---
// Production rejects test billing. Preview sandbox checkout requires its audited
// return alias. The two modes are deliberately mutually exclusive.
let stableOrigins = [];
if (String(process.env.VERCEL_ENV ?? "").trim().toLowerCase() === "preview") {
  try {
    const manifestPath = path.join(repoRoot, "web", "config", "creem-preview-origin-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    stableOrigins = manifest?.stableOrigins;
    if (!Array.isArray(stableOrigins) || stableOrigins.length === 0 || !stableOrigins.every((value) => typeof value === "string")) {
      failures.push("web/config/creem-preview-origin-manifest.json must contain a non-empty stableOrigins string array.");
      stableOrigins = [];
    } else {
      infoLines.push("Preview Creem stable-origin manifest: ok");
    }
  } catch (err) {
    failures.push(`could not read/parse web/config/creem-preview-origin-manifest.json: ${err.message}`);
  }
}
for (const problem of checkDeploymentBillingContract(process.env, stableOrigins)) {
  failures.push(problem);
}

// --- Check 7: no other active branch's work would be dropped ---
// See checkUnmergedBranches (top of file). Gathers, for every local branch, how
// many of its commits are NOT contained in HEAD, plus how recently it was
// touched; the pure checker decides what counts as a blocking drop.
try {
  const raw = runGit([
    "-C", repoRoot, "for-each-ref",
    "--format=%(refname:short)%09%(committerdate:unix)",
    "refs/heads",
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  // Work already merged here counts as accounted-for, so a finished branch left
  // lying around never blocks a deploy. `master` is this repo's integration
  // branch; override with DEPLOY_INTEGRATION_BRANCH if that ever changes.
  const mainBranch = String(process.env.DEPLOY_INTEGRATION_BRANCH ?? "master").trim() || "master";
  const branches = [];
  for (const line of raw.split("\n").map(l => l.replace(/\r$/, "")).filter(Boolean)) {
    const [name, ts] = line.split("\t");
    if (!name) continue;
    // `rev-list --count A..<branch>` = commits on the branch that A lacks.
    let missing = 0;
    let unmergedFromMain = 0;
    try {
      missing = parseInt(runGit(["-C", repoRoot, "rev-list", "--count", `HEAD..${name}`]).trim(), 10) || 0;
      unmergedFromMain = name === mainBranch
        ? missing
        : parseInt(runGit(["-C", repoRoot, "rev-list", "--count", `${mainBranch}..${name}`]).trim(), 10) || 0;
    } catch { continue; }
    branches.push({
      name,
      missing,
      unmergedFromMain,
      ageDays: Math.max(0, Math.floor((nowSec - (parseInt(ts, 10) || nowSec)) / 86400)),
    });
  }
  for (const problem of checkUnmergedBranches(branches, { currentBranch: branch ?? "HEAD" })) {
    failures.push(problem);
  }
} catch (err) {
  failures.push(`could not enumerate branches for the unmerged-work check: ${err.message}`);
}

// --- Check 8: AI-copy text model must be pinned when a provider credential exists ---
// See checkAiCopyTextModelForProd (top of file) — production must never run copy
// generation on an implicit, credential-dependent default model.
for (const problem of checkAiCopyTextModelForProd(process.env)) {
  failures.push(problem);
}

// --- Check 9: usage-quota enforcement must actually be wired on for production ---
// See checkUsageEnforceForProd (top of file) — the free "10 AI images" launch
// must not ship with a metering mode/flag combination that blocks nothing.
for (const problem of checkUsageEnforceForProd(process.env)) {
  failures.push(problem);
}

// --- Check 10: the target Supabase project must actually expose the usage RPCs ---
// See checkUsageRpcsPresent (top of file). Only meaningful for a production
// target — Preview/local databases are not policed here.
if (isProductionDeployTarget(process.env)) {
  try {
    const rpcProblems = await checkUsageRpcsPresent({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    if (rpcProblems.length === 0) {
      infoLines.push("usage RPCs: present on target Supabase project");
    }
    for (const problem of rpcProblems) failures.push(problem);
  } catch (err) {
    failures.push(`usage RPC presence check threw unexpectedly: ${err?.message ?? err}`);
  }
}

// --- Informational only: per-type usage enforce switches (decision #8, 2026-08-28) ---
// USAGE_METERING_MODE=enforce alone blocks nothing — each usage type only actually
// enforces when its own flag is also truthy (see usageEnforceFor in
// src/lib/server/usage/meterGeneration.ts). This is NOT a blocking check for
// USAGE_ENFORCE_SCHEDULED_POSTS: an operator may deliberately ship enforce mode
// without that one type flag on. (AI images/text ARE blocking as of check 9 above;
// this line still prints all three so a deploy log always shows the full picture.)
{
  const enforceFlagNames = ["USAGE_ENFORCE_AI_IMAGES", "USAGE_ENFORCE_AI_TEXT", "USAGE_ENFORCE_SCHEDULED_POSTS"];
  const meteringMode = String(process.env.USAGE_METERING_MODE ?? "off").trim().toLowerCase();
  const flagStates = enforceFlagNames.map((name) => `${name}=${isTruthyUsageEnforceFlag(process.env[name]) ? "on" : "off"}`);
  const saltState = String(process.env.GENERATION_INTENT_KEY_SALT ?? "").trim() ? "set" : "unset";
  infoLines.push(`usage metering mode: ${meteringMode || "off"} | enforce switches: ${flagStates.join(", ")} | GENERATION_INTENT_KEY_SALT: ${saltState}`);
}

// --- Resolve outcome ---
function logOverrideAndExit() {
  const reason = process.env.OVERRIDE_REASON;
  if (!reason || String(reason).trim() === "") {
    console.error("FAIL: --override requires a non-empty OVERRIDE_REASON environment variable.");
    process.exit(1);
  }

  const logPath = path.join(__dirname, "deploy-overrides.log");
  const timestamp = new Date().toISOString();
  const shaForLog = sha ?? "<unknown-sha>";
  const line = `${timestamp} | ${shaForLog} | ${reason}\n`;
  try {
    fs.appendFileSync(logPath, line, "utf8");
  } catch (err) {
    console.error(`WARNING: failed to write override audit log: ${err.message}`);
  }

  console.warn("========================================================");
  console.warn("  WARNING: predeploy-guard checks FAILED but were OVERRIDDEN.");
  console.warn(`  reason: ${reason}`);
  console.warn(`  sha: ${shaForLog}`);
  console.warn("  This deploy is proceeding WITHOUT passing all safety checks.");
  console.warn("========================================================");
  if (failures.length > 0) {
    console.warn("Bypassed failures:");
    for (const f of failures) console.warn(`  - ${f}`);
  }
  process.exit(0);
}

if (failures.length === 0) {
  console.log("predeploy-guard: all checks passed");
  for (const line of infoLines) console.log(`  ✓ ${line}`);
  process.exit(0);
}

console.error("predeploy-guard: FAILED");
for (const f of failures) {
  console.error(`  ✗ ${f}`);
}

if (overrideRequested) {
  logOverrideAndExit();
} else {
  process.exit(1);
}

} // end runGuard()
