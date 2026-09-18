/**
 * Four-plan social-account quota test entry point.
 *
 * Dry-run is credential-free.  --apply is intentionally explicit and requires an
 * exact Preview binding; it writes only run-scoped .test accounts and removes them
 * in a finally block through SupabaseAccountQuotaAdapter.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadTestDbConfig, TestDbConfigError } from "./lib/test-db-config";
import {
  applyAccountQuotaReport,
  assertAccountQuotaTestRef,
  dryRunAccountQuotaReport,
  reportAccountQuotaMarkdown,
} from "./lib/credit-account-quota-harness";
import { SupabaseAccountQuotaAdapter } from "./lib/credit-account-quota-supabase-adapter";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const value = (name: string) => process.argv.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);

async function main(): Promise<void> {
  const runId = value("--run-id") ?? `account-quota-${Date.now().toString(36)}`;
  const output = resolve(value("--output") ?? `artifacts/credit-account-quota/${runId}`);
  let report;
  if (!apply) {
    report = dryRunAccountQuotaReport(runId);
  } else {
    try {
      const config = loadTestDbConfig();
      assertAccountQuotaTestRef(config.projectRef);
      const baseUrl = value("--base-url");
      const expectedCommit = value("--expected-commit");
      const expectedDeployment = value("--expected-deployment");
      if (!baseUrl || !expectedCommit || !expectedDeployment) {
        throw new Error("apply preflight failed: --base-url, --expected-commit, and --expected-deployment are required");
      }
      const adapter = new SupabaseAccountQuotaAdapter({
        config,
        baseUrl,
        expectedCommit,
        expectedDeploymentId: expectedDeployment,
      });
      report = await applyAccountQuotaReport(adapter, runId);
    } catch (error) {
      const reason = error instanceof TestDbConfigError ? error.message : (error as Error).message;
      report = {
        ...dryRunAccountQuotaReport(runId),
        mode: "apply" as const,
        outcome: "FAIL" as const,
        externalWrites: false,
        failures: [`apply preflight failed: ${reason}`],
      };
    }
  }
  await mkdir(dirname(output), { recursive: true });
  await Promise.all([
    writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(`${output}.md`, reportAccountQuotaMarkdown(report), "utf8"),
  ]);
  console.log(`Credit account quota ${report.mode} report written: ${output}.{json,md}`);
  if (report.mode === "dry-run") console.log("No Auth, database, OAuth, provider, browser, payment, Production, or deployment call was made.");
  else if (report.outcome !== "FAIL") console.log(`Verified Test Supabase ${report.targetRef}; cleanup: ${report.cleanup.status}. Provider URLs were not followed.`);
  else process.exitCode = 1;
}

void main();
