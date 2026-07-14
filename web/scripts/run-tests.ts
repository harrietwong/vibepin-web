/**
 * Test runner that does NOT abort on the first failing script.
 *
 * Historically `npm test` was a single `npx tsx a.ts && npx tsx b.ts && ...`
 * chain — the first failure short-circuited the rest via `&&`, hiding every
 * later failure. This runner instead runs every script to completion in its
 * own child process (regardless of earlier failures), prints a per-script
 * PASS/FAIL summary at the end, and exits 1 if ANY script failed, 0 otherwise.
 *
 * Usage: npx tsx scripts/run-tests.ts scripts/test-a.ts scripts/test-b.ts ...
 */

import { spawnSync } from "node:child_process";

const scripts = process.argv.slice(2);

if (scripts.length === 0) {
  console.error("run-tests: no scripts provided");
  process.exit(1);
}

type Result = { script: string; passed: boolean; durationMs: number };

const results: Result[] = [];

for (const script of scripts) {
  const start = Date.now();
  console.log(`\n>>> RUNNING ${script}`);
  const isWindows = process.platform === "win32";
  const proc = spawnSync("npx", ["tsx", script], {
    stdio: "inherit",
    shell: isWindows,
  });
  const durationMs = Date.now() - start;
  const passed = proc.status === 0 && !proc.error;
  if (proc.error) {
    console.error(`run-tests: failed to start ${script}: ${proc.error.message}`);
  }
  results.push({ script, passed, durationMs });
}

const failed = results.filter((r) => !r.passed);
const passedCount = results.length - failed.length;

console.log("\n=== Test Summary ===");
for (const r of results) {
  const tag = r.passed ? "PASS" : "FAIL";
  console.log(`${tag}  ${r.script}  (${r.durationMs}ms)`);
}
console.log(`\n${passedCount}/${results.length} passed, ${failed.length} failed.`);

if (failed.length > 0) {
  console.log("\nFailed scripts:");
  for (const r of failed) {
    console.log(`  - ${r.script}`);
  }
  process.exit(1);
}

process.exit(0);
