/**
 * Test-registry gate.
 *
 * Fails when `scripts/test-*.ts` and `test-registry.ts` disagree, in either direction:
 *
 *   UNREGISTERED — a test exists on disk but is in no group and on no exclusion list.
 *     This is the failure that matters. 48 scripts had drifted into this state; they
 *     ran nowhere, so 8 of them had been failing silently for who knows how long. A
 *     test nobody runs is worse than no test: it looks like coverage and isn't.
 *
 *   MISSING — the registry names a script that is not on disk (renamed or deleted),
 *     which would otherwise blow up mid-run.
 *
 *   DUPLICATE — listed in more than one group, so it would run twice.
 *
 * Run: npx tsx scripts/check-test-registry.ts   (also runs as part of `npm test`)
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CORE, STUDIO, PLAN, EXCLUDED, ALL_REGISTERED } from "./test-registry";

const dir = join(process.cwd(), "scripts");
const onDisk = readdirSync(dir)
  .filter(f => /^test-.*\.ts$/.test(f) && f !== "test-registry.ts")
  .map(f => f.replace(/\.ts$/, ""))
  .sort();

const registered = new Set(ALL_REGISTERED);
const unregistered = onDisk.filter(t => !registered.has(t));
const missing = ALL_REGISTERED.filter(t => !onDisk.includes(t));

const seen = new Set<string>();
const duplicates: string[] = [];
for (const t of [...CORE, ...STUDIO, ...PLAN, ...Object.keys(EXCLUDED)]) {
  if (seen.has(t)) duplicates.push(t);
  seen.add(t);
}

const problems = unregistered.length + missing.length + duplicates.length;
if (problems === 0) {
  console.log(
    `Test registry: OK — ${onDisk.length} scripts on disk, ` +
    `${CORE.length + STUDIO.length + PLAN.length} run by \`npm test\`, ` +
    `${Object.keys(EXCLUDED).length} excluded with a reason.`,
  );
  process.exit(0);
}

console.error("Test registry FAILED\n");

if (unregistered.length) {
  console.error(`  ${unregistered.length} test script(s) exist but are NOT registered — they run nowhere:`);
  for (const t of unregistered) console.error(`    scripts/${t}.ts`);
  console.error("\n  Add each to CORE / STUDIO / PLAN in scripts/test-registry.ts so `npm test` runs it.");
  console.error("  If it genuinely must not run, add it to EXCLUDED with a reason — never leave it dangling.\n");
}

if (missing.length) {
  console.error(`  ${missing.length} registered script(s) do not exist on disk (renamed or deleted?):`);
  for (const t of missing) console.error(`    scripts/${t}.ts`);
  console.error("\n  Update scripts/test-registry.ts to match.\n");
}

if (duplicates.length) {
  console.error(`  ${duplicates.length} script(s) registered more than once (they would run twice):`);
  for (const t of duplicates) console.error(`    ${t}`);
  console.error("");
}

process.exit(1);
