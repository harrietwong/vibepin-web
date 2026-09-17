/**
 * Four-plan Credit E2E harness entry point.
 *
 * Default: creates a local redacted two-round report only. It cannot contact a
 * database. `--apply` requires exact Test Supabase, Preview commit, and deployment
 * identity, provisions four synthetic accounts, runs two rounds, captures Billing
 * evidence, and always cleans every created row/account.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadTestDbConfig, TestDbConfigError } from "./lib/test-db-config";
import {
  assertStrictTestRef,
  applyReport,
  dryRunReport,
  failedApplyReport,
  newRunId,
  reportMarkdown,
} from "./lib/credit-e2e-harness";
import { SupabaseCreditE2eAdapter } from "./lib/credit-e2e-supabase-adapter";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const runIdArg = process.argv.find(v => v.startsWith("--run-id="))?.slice("--run-id=".length);
const outputArg = process.argv.find(v => v.startsWith("--output="))?.slice("--output=".length);
const baseUrlArg = process.argv.find(v => v.startsWith("--base-url="))?.slice("--base-url=".length);
const expectedCommitArg = process.argv.find(v => v.startsWith("--expected-commit="))?.slice("--expected-commit=".length);
const expectedDeploymentArg = process.argv.find(v => v.startsWith("--expected-deployment="))?.slice("--expected-deployment=".length);

async function main(): Promise<void> {
  const runId = runIdArg || newRunId();
  const outputBase = resolve(outputArg || `artifacts/credit-e2e/${runId}`);
  let report;
  if (apply) {
    try {
      const config = loadTestDbConfig();
      assertStrictTestRef(config.projectRef);
      if (!baseUrlArg || !expectedCommitArg || !expectedDeploymentArg) {
        throw new Error(
          "apply preflight failed: --base-url, --expected-commit, and --expected-deployment are required; " +
          "the harness will not guess which Preview build to test",
        );
      }
      const adapter = new SupabaseCreditE2eAdapter({
        config,
        baseUrl: baseUrlArg,
        expectedCommit: expectedCommitArg,
        expectedDeploymentId: expectedDeploymentArg,
        screenshotDir: `${outputBase}-screenshots`,
      });
      report = await applyReport(adapter, runId);
    } catch (error) {
      const failure = error instanceof TestDbConfigError
        ? new Error(`apply preflight failed: ${error.message}`)
        : error;
      report = failedApplyReport(runId, failure);
    }
  } else {
    report = dryRunReport(runId);
  }

  await mkdir(dirname(outputBase), { recursive: true });
  await Promise.all([
    writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(`${outputBase}.md`, reportMarkdown(report), "utf8"),
  ]);
  console.log(`Credit E2E ${report.mode} report written: ${outputBase}.{json,md}`);
  if (report.mode === "dry-run") {
    console.log("No browser, HTTP, database, Auth, checkout, payment, or AI provider was called.");
  } else if (report.outcome !== "FAIL") {
    console.log(`Verified isolated Test Supabase ${report.targetRef}; cleanup status: ${report.cleanup.status}.`);
    console.log("No checkout, payment, AI provider, social provider, Production, or deployment mutation was called.");
  } else {
    console.error(`Credit E2E apply failed; failure and cleanup receipts were written to ${outputBase}.{json,md}.`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`Credit E2E harness failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
