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

import { spawn } from "node:child_process";
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

/**
 * Run one script with async spawn, teeing its output live AND retaining only the
 * last N non-empty lines in a bounded ring buffer.
 *
 * Why not spawnSync with capture: spawnSync buffers each pipe into memory with a
 * 1 MiB default maxBuffer. A chatty but PASSING script that exceeds it is killed
 * with SIGTERM (status null, error.code ENOBUFS) and would be reported as FAILED —
 * turning "verbose test" into "spurious failure". Raising maxBuffer only moves the
 * cliff. Streaming with a ring buffer has no ceiling: we tee every chunk to our own
 * stdout as it arrives (so a live run still scrolls in real time) and keep just the
 * tail we need for the end-of-run diagnostic.
 */
function runOne(script: string): Promise<Result> {
  const start = Date.now();
  const isWindows = process.platform === "win32";
  const child = spawn("npx", ["tsx", script], { shell: isWindows });

  const ring: string[] = []; // last FAILURE_TAIL_LINES non-empty lines
  let carry = ""; // partial line spanning chunk boundaries
  const absorb = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text); // live tee — unchanged real-time experience
    const lines = (carry + text).split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      ring.push(line);
      if (ring.length > FAILURE_TAIL_LINES) ring.shift();
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  return new Promise<Result>(resolve => {
    const finish = (passed: boolean) => {
      if (carry) { ring.push(carry); if (ring.length > FAILURE_TAIL_LINES) ring.shift(); }
      resolve({
        script,
        passed,
        durationMs: Date.now() - start,
        tail: passed ? undefined : ring.join("\n"),
      });
    };
    child.on("error", err => {
      process.stderr.write(`run-tests: failed to start ${script}: ${err.message}\n`);
      finish(false);
    });
    child.on("close", code => finish(code === 0));
  });
}

async function main(): Promise<void> {
  const results: Result[] = [];

  // Sequential (await in a loop), preserving the previous one-at-a-time ordering so
  // interleaving of live output stays readable and resource use is bounded.
  for (const script of scripts) {
    console.log(`\n>>> RUNNING ${script}`);
    results.push(await runOne(script));
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
}

void main();
