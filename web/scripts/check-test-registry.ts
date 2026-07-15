/**
 * Test-registry gate.
 *
 * Fails when the GIT-TRACKED `scripts/test-*.ts` files and `test-registry.ts` disagree,
 * in either direction:
 *
 *   UNREGISTERED — a tracked test exists but is in no group and on no exclusion list.
 *     This is the failure that matters. 48 scripts had drifted into this state; they
 *     ran nowhere, so 8 of them had been failing silently for who knows how long. A
 *     test nobody runs is worse than no test: it looks like coverage and isn't.
 *
 *   MISSING — the registry names a script that is not git-tracked (renamed, deleted, or
 *     still an uncommitted draft), which would otherwise blow up mid-run.
 *
 *   DUPLICATE — listed in more than one group, so it would run twice.
 *
 * "On disk" means GIT-TRACKED, not whatever readdirSync finds: an untracked draft
 * test-*.ts in someone's working tree is not part of the release, so it must be
 * invisible to this gate. From a clean checkout the tracked set and the registry must
 * agree exactly — that is the whole point of a reproducible release gate. We enumerate
 * via `git ls-files -- "scripts/test-*.ts"` (cwd = web/). If git is unavailable (e.g. a
 * non-git tarball) we fall back to readdirSync with a printed warning.
 *
 * Run: npx tsx scripts/check-test-registry.ts   (also runs as part of `npm test`)
 */

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CORE, STUDIO, PLAN, EXCLUDED, ALL_REGISTERED } from "./test-registry";

const dir = join(process.cwd(), "scripts");

/** Git-tracked `scripts/test-*.ts`, sans extension, excluding the registry itself. */
function trackedTests(): string[] {
  const out = execFileSync("git", ["ls-files", "--", "scripts/test-*.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map(p => p.replace(/^scripts[\\/]/, "").replace(/\.ts$/, ""))
    .filter(t => t !== "test-registry")
    .sort();
}

/** Disk fallback for a non-git tarball. */
function diskTests(): string[] {
  return readdirSync(dir)
    .filter(f => /^test-.*\.ts$/.test(f) && f !== "test-registry.ts")
    .map(f => f.replace(/\.ts$/, ""))
    .sort();
}

let onDisk: string[];
try {
  onDisk = trackedTests();
} catch {
  console.warn(
    "Test registry: git unavailable — falling back to readdirSync (untracked drafts " +
    "may leak into the gate).",
  );
  onDisk = diskTests();
}

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
    `Test registry: OK — ${onDisk.length} tracked scripts, ` +
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
  console.error(`  ${missing.length} registered script(s) are not git-tracked (renamed, deleted, or uncommitted draft?):`);
  for (const t of missing) console.error(`    scripts/${t}.ts`);
  console.error("\n  Update scripts/test-registry.ts to match.\n");
}

if (duplicates.length) {
  console.error(`  ${duplicates.length} script(s) registered more than once (they would run twice):`);
  for (const t of duplicates) console.error(`    ${t}`);
  console.error("");
}

process.exit(1);
