/**
 * Four-plan Credit E2E harness entry point.
 *
 * Default: creates a local redacted two-round report only. It cannot contact a
 * database. `--apply` validates only TEST_SUPABASE_* and the exact isolated ref,
 * then refuses because no live-write adapter is installed in this change.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadTestDbConfig, TestDbConfigError } from "./lib/test-db-config";
import {
  assertStrictTestRef,
  dryRunReport,
  newRunId,
  reportMarkdown,
} from "./lib/credit-e2e-harness";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const runIdArg = process.argv.find(v => v.startsWith("--run-id="))?.slice("--run-id=".length);
const outputArg = process.argv.find(v => v.startsWith("--output="))?.slice("--output=".length);

async function main(): Promise<void> {
  if (apply) {
    let config;
    try {
      config = loadTestDbConfig();
    } catch (error) {
      if (error instanceof TestDbConfigError) throw new Error(`apply preflight failed: ${error.message}`);
      throw error;
    }
    assertStrictTestRef(config.projectRef);
    throw new Error(
      "--apply is intentionally blocked: this revision has no live-write adapter. " +
      "It cannot provision Auth users or seed/cleanup database rows until an adapter is independently reviewed.",
    );
  }

  const report = dryRunReport(runIdArg || newRunId());
  const outputBase = resolve(outputArg || `artifacts/credit-e2e/${report.runId}`);
  await mkdir(dirname(outputBase), { recursive: true });
  await Promise.all([
    writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(`${outputBase}.md`, reportMarkdown(report), "utf8"),
  ]);
  console.log(`Credit E2E dry-run report written: ${outputBase}.{json,md}`);
  console.log("No browser, HTTP, database, Auth, checkout, payment, or AI provider was called.");
}

main().catch(error => {
  console.error(`Credit E2E harness failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
