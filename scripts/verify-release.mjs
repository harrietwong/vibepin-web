#!/usr/bin/env node
/**
 * Release-gate aggregator — the ONE command that decides "is this releasable?".
 *
 * Runs every gate in order, WITHOUT short-circuiting: a failing step does not stop the
 * ones after it. Every step's real outcome is printed, and the process exits non-zero
 * if ANY required step failed. This exists because the previous gate reported
 * "102/102 passing" from a dirty tree while several steps were silently skipped or
 * hidden behind `&&`. A gate that stops at the first failure hides everything past it.
 *
 * Required steps (each runs regardless of earlier failures):
 *   1. web typecheck — `npm run typecheck` in web/ (tsc --noEmit)
 *   2. web tests     — `npm test` in web/ (registry check + all node tests)
 *   3. web build     — `npm run build` in web/ (next build)
 *   4. backend tests — `npm run test:backend` (pytest, wired in root package.json)
 *   5. secret scan   — node scripts/scan-secrets.mjs
 *
 * Optional step:
 *   6. browser QA    — `npm run test:browser`; needs a live dev server, so it is SKIPPED
 *                      by default (labelled, NEVER counted as passed). Set
 *                      VERIFY_RELEASE_BROWSER=1 to run it. When it is skipped the final
 *                      verdict is "core gates passed / browser QA pending", never "fully
 *                      releasable"; VERIFY_RELEASE_STRICT=1 makes a skip exit non-zero.
 *
 * Cross-platform (Windows dev, Linux deploy): pure node + spawnSync, no shell chaining.
 * CI wiring is intentionally out of scope.
 *
 * Run: node scripts/verify-release.mjs
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "web");
const isWin = process.platform === "win32";

/**
 * Run a command, streaming its output. Returns "pass" | "fail".
 * A non-zero exit, a failure to launch (r.error), or death by signal (r.status is null
 * with r.signal set) all count as fail — otherwise a step that never really ran could be
 * mistaken for a pass.
 */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (r.error) {
    console.error(`  (failed to launch: ${r.error.message})`);
    return "fail";
  }
  if (r.signal) {
    console.error(`  (terminated by signal ${r.signal})`);
    return "fail";
  }
  return r.status === 0 ? "pass" : "fail";
}

const results = [];
function record(name, status) {
  results.push({ name, status });
  console.log(`\n>>> ${name}: ${status.toUpperCase()}\n`);
}

console.log("=== verify:release — running all gates (no short-circuit) ===");

console.log("\n[1/6] web typecheck (npm run typecheck in web/)");
record("web typecheck", run("npm", ["run", "typecheck"], webDir));

console.log("\n[2/6] web tests (npm test in web/)");
record("web tests", run("npm", ["test"], webDir));

console.log("\n[3/6] web build (npm run build in web/)");
record("web build", run("npm", ["run", "build"], webDir));

console.log("\n[4/6] backend tests (npm run test:backend)");
record("backend tests", run("npm", ["run", "test:backend"], repoRoot));

console.log("\n[5/6] secret scan (scripts/scan-secrets.mjs)");
record("secret scan", run("node", [join("scripts", "scan-secrets.mjs")], repoRoot));

console.log("\n[6/6] browser QA (test:browser)");
let browserSkipped = false;
if (process.env.VERIFY_RELEASE_BROWSER === "1") {
  record("browser QA", run("npm", ["run", "test:browser"], webDir));
} else {
  browserSkipped = true;
  results.push({ name: "browser QA", status: "skipped" });
  console.log("\n>>> browser QA: SKIPPED (needs a live dev server; set VERIFY_RELEASE_BROWSER=1 to run)\n");
}

console.log("\n=== verify:release summary ===");
for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(8)} ${r.name}`);

const failed = results.filter(r => r.status === "fail");
if (failed.length) {
  console.error(`\nRelease gate FAILED — ${failed.length} step(s): ${failed.map(f => f.name).join(", ")}`);
  process.exit(1);
}

if (browserSkipped) {
  // Core gates passed, but browser QA never ran — do NOT imply the release is certified.
  const strict = process.env.VERIFY_RELEASE_STRICT === "1";
  console.log("\nCore release gates PASSED. Browser QA is PENDING (skipped — needs a live dev server).");
  if (strict) {
    console.error("Strict release mode: browser QA is required. Run with VERIFY_RELEASE_BROWSER=1.");
    process.exit(1);
  }
  console.log("NOT certified fully releasable until browser QA runs (VERIFY_RELEASE_BROWSER=1),");
  console.log("or enforce it with VERIFY_RELEASE_STRICT=1.");
  process.exit(0);
}

console.log("\nAll release gates PASSED — releasable.");
process.exit(0);
