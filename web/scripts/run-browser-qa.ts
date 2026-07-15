/**
 * Browser QA runner.
 *
 * Runs BOTH real-browser QA scripts and reports both outcomes, then exits non-zero if
 * EITHER failed. The old `test:browser` chained them with `&&`, so a failure in the
 * first (ai-copy-context) silently skipped the second (generating-visibility) and hid
 * its result — the exact "looks green, isn't" trap this WP is about.
 *
 * Both scripts drive a live dev server (E2E_TEST_MODE=true npm run dev). Run:
 *   npx tsx scripts/run-browser-qa.ts
 */

import { spawnSync } from "node:child_process";

const STEPS = [
  { name: "ai-copy-context",       script: "scripts/test-ai-copy-context.ts" },
  { name: "generating-visibility", script: "scripts/qa-generating-visibility.ts" },
];

const results: { name: string; ok: boolean }[] = [];

for (const step of STEPS) {
  console.log(`\n=== browser QA: ${step.name} (${step.script}) ===`);
  const r = spawnSync("npx", ["tsx", step.script], { stdio: "inherit", shell: process.platform === "win32" });
  const ok = r.status === 0;
  results.push({ name: step.name, ok });
  console.log(`=== browser QA: ${step.name} → ${ok ? "PASS" : "FAIL"} ===`);
}

console.log("\nBrowser QA summary:");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);

const failed = results.filter(r => !r.ok);
process.exit(failed.length ? 1 : 0);
