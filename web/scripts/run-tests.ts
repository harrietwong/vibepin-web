/**
 * Test runner that does NOT abort on the first failing script.
 *
 * Historically `npm test` was a single `npx tsx a.ts && npx tsx b.ts && ...`
 * chain — the first failure short-circuited the rest via `&&`, hiding every
 * later failure. This runner instead runs every script to completion in its
 * own child process (regardless of earlier failures), prints a per-script
 * PASS/FAIL summary at the end, and exits 1 if ANY script failed, 0 otherwise.
 *
 * Usage:
 *   npx tsx scripts/run-tests.ts core studio plan     # group names from test-registry.ts
 *   npx tsx scripts/run-tests.ts scripts/test-a.ts    # or explicit paths
 *
 * Groups come from scripts/test-registry.ts, which is the single list of what exists.
 * check-test-registry.ts fails the build if a script on disk is missing from it, so a
 * new test cannot quietly end up running nowhere.
 */

import { spawnSync } from "node:child_process";
import { CORE, STUDIO, PLAN } from "./test-registry";

const GROUPS: Record<string, string[]> = { core: CORE, studio: STUDIO, plan: PLAN };

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("run-tests: no scripts or groups provided (groups: core, studio, plan)");
  process.exit(1);
}

const scripts = args.flatMap(a => {
  const group = GROUPS[a.toLowerCase()];
  if (group) return group.map(n => `scripts/${n}.ts`);
  if (a.startsWith("-")) {
    console.error(`run-tests: unknown option "${a}"`);
    process.exit(1);
  }
  return [a];
});

type Result = { script: string; passed: boolean; durationMs: number; tail?: string };

/** Lines of a failing script's output to reprint beside the summary. */
const FAILURE_TAIL_LINES = 25;

const results: Result[] = [];

for (const script of scripts) {
  const start = Date.now();
  console.log(`\n>>> RUNNING ${script}`);
  const isWindows = process.platform === "win32";
  // Capture (not "inherit") so a failure's output can be REPRINTED next to the
  // summary. With 73 scripts streaming live, a failure's cause scrolls thousands of
  // lines away from the summary line, which is how an ENOSPC ("no space left on
  // device") failure went undiagnosed across two review rounds — the summary named
  // the failing scripts but never showed why. Passing output is still streamed
  // through so a live run looks unchanged.
  const proc = spawnSync("npx", ["tsx", script], {
    encoding: "utf8",
    shell: isWindows,
  });
  const durationMs = Date.now() - start;
  const passed = proc.status === 0 && !proc.error;
  const combined = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  process.stdout.write(combined);
  if (proc.error) {
    console.error(`run-tests: failed to start ${script}: ${proc.error.message}`);
  }
  const tail = passed
    ? undefined
    : combined.split(/\r?\n/).filter(Boolean).slice(-FAILURE_TAIL_LINES).join("\n");
  results.push({ script, passed, durationMs, tail });
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
  // Reprint WHY each one failed, right here at the end. Without this the reason is
  // only discoverable by rerunning the script by hand — and a rerun can pass, which
  // makes an environmental failure look like flaky logic.
  console.log("\n=== Failure output (last " + FAILURE_TAIL_LINES + " lines each) ===");
  for (const r of failed) {
    console.log(`\n--- ${r.script} ---`);
    console.log(r.tail?.trim() || "(no output captured)");
  }
  process.exit(1);
}

process.exit(0);
