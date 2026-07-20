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
 *   5. PINTEREST_API_ENV is not "sandbox".
 *   6. Billing is not in test mode for production. CREEM_MODE is never "test".
 *      The billing CREEM_API_KEY is policed ONLY when CREEM_MODE is "live" (then
 *      it must be a real live key, not a test key) — because only "live" opens
 *      real checkout. Under CREEM_MODE=disabled (the review/Demo posture) the
 *      billing key is expected to be EMPTY and is not checked, so a test-mode
 *      MODERATION key (a separate CREEM_MODERATION_API_KEY) can power Create Pins
 *      generation without tripping the deploy guard. This is the deploy-time half
 *      of the billingMode guard.
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

// Only run the full guard (git + filesystem + process.exit) when invoked directly
// as the entrypoint — importing this module for its pure export must be side-effect
// free.
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (!isMainModule) {
  // Imported (e.g. by the unit test) — expose the pure check and stop here.
  // eslint-disable-next-line no-undef
} else {
  runGuard();
}

function runGuard() {

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

// --- Check 4: E2E_TEST_MODE must not be truthy ---
function isTruthyEnv(value) {
  if (value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

if (isTruthyEnv(process.env.E2E_TEST_MODE)) {
  failures.push(`E2E_TEST_MODE is set (${process.env.E2E_TEST_MODE}) — refusing a production deploy in test mode`);
}

// --- Check 5: PINTEREST_API_ENV must not be "sandbox" ---
if (process.env.PINTEREST_API_ENV === "sandbox") {
  failures.push('PINTEREST_API_ENV is "sandbox" — refusing a production deploy against the sandbox Pinterest environment');
}

// --- Check 6: billing must not be in test mode for a production deploy ---
// See checkBillingModeForProd (top of file) — a test-mode Creem key must never
// open real checkout on production.
for (const problem of checkBillingModeForProd(process.env)) {
  failures.push(problem);
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
