/**
 * Pure orchestration contract for a four-plan social-account quota test.
 *
 * This module has no database, OAuth, browser, or provider dependency.  Its live
 * adapter is deliberately separate so a report can be generated and reviewed
 * without granting this script accidental write capability.
 */
import { createHash, randomUUID } from "node:crypto";
import { PLAN_ENTITLEMENTS, type PlanKey } from "../../src/lib/server/planEntitlements";

export const ACCOUNT_QUOTA_TEST_REF = "snulmwprsahzqvdbyenc";
export const ACCOUNT_QUOTA_PRODUCTION_REF = "jaxteelkecvlozdrdoog";
export const ACCOUNT_QUOTA_PLANS: readonly PlanKey[] = ["free", "starter", "pro", "business"];

export type SyntheticConnection = {
  provider: "pinterest";
  providerAccountId: string;
  status: "connected" | "disconnected";
};

export type AccountQuotaScenario = {
  runId: string;
  plan: PlanKey;
  email: string;
  emailFingerprint: string;
  limit: number;
  connections: SyntheticConnection[];
};

export type AccountQuotaReportScenario = Omit<AccountQuotaScenario, "email">;

export type AccountQuotaEvidence = {
  surface: "binding" | "database" | "http" | "oauth" | "cleanup" | "ui";
  status: "PASS" | "FAIL" | "NOT_EXECUTED" | "BLOCKED";
  detail: string;
  caseId?: string;
  screenshot?: string;
};

export type AccountQuotaBinding = {
  previewOrigin: string | null;
  candidateCommit: string | null;
  deploymentId: string | null;
  testSupabaseOrigin: string | null;
  testSupabaseRef: string;
  verified: boolean;
};

export type AccountQuotaCleanup = {
  status: "PASS" | "FAIL";
  actions: Array<{ resource: string; status: "PASS" | "FAIL"; detail: string }>;
};

export type AccountQuotaReport = {
  schemaVersion: 1;
  mode: "dry-run" | "apply";
  outcome: "PASS" | "FAIL" | "PARTIAL" | "NOT_EXECUTED";
  runId: string;
  targetRef: string;
  externalWrites: boolean;
  binding: AccountQuotaBinding;
  rounds: Array<{ round: 1 | 2; scenarios: AccountQuotaReportScenario[]; evidence: AccountQuotaEvidence[] }>;
  cleanup: AccountQuotaCleanup;
  failures: string[];
};

export interface AccountQuotaApplyAdapter {
  assertTarget(ref: string): Promise<AccountQuotaBinding>;
  provision(scenario: AccountQuotaScenario): Promise<{ userId: string }>;
  seedConnections(scenario: AccountQuotaScenario, userId: string, context: { round: 1 | 2 }): Promise<void>;
  verifyConnectGate(scenario: AccountQuotaScenario, userId: string, context: { round: 1 | 2 }): Promise<AccountQuotaEvidence[]>;
  cleanup(runId: string, userIds: string[]): Promise<AccountQuotaCleanup>;
}

export function assertAccountQuotaTestRef(ref: string): void {
  if (ref === ACCOUNT_QUOTA_PRODUCTION_REF) throw new Error("REFUSING: Production project ref is forbidden");
  if (ref !== ACCOUNT_QUOTA_TEST_REF) {
    throw new Error(`REFUSING: expected isolated test ref ${ACCOUNT_QUOTA_TEST_REF}, received ${ref || "(empty)"}`);
  }
}

export function syntheticAccountQuotaEmail(plan: PlanKey, runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(runId)) throw new Error("runId must be 3–64 URL-safe characters");
  return `e2e-account-quota-${plan}-${runId}@vibepin.test`;
}

function redactEmail(email: string): string {
  return `sha256:${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

/**
 * A capacity fixture always contains one disconnected account.  It is deliberate:
 * disconnect does not free a plan slot, while reconnect repairs that held row.
 */
export function buildAccountQuotaScenario(plan: PlanKey, runId: string): AccountQuotaScenario {
  const included = PLAN_ENTITLEMENTS[plan].connectedAccountsPerPlatform;
  if (included === null || included < 1) throw new Error(`${plan} must have a finite positive account cap for this test`);
  const email = syntheticAccountQuotaEmail(plan, runId);
  return {
    runId,
    plan,
    email,
    emailFingerprint: redactEmail(email),
    limit: included,
    connections: Array.from({ length: included }, (_, index) => ({
      provider: "pinterest" as const,
      providerAccountId: `synthetic-${plan}-${index + 1}`,
      status: index === included - 1 ? "disconnected" as const : "connected" as const,
    })),
  };
}

function reportScenario(scenario: AccountQuotaScenario): AccountQuotaReportScenario {
  const { email: _email, ...safe } = scenario;
  void _email;
  return safe;
}

function redact(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:password|access[_ -]?token|service[_ -]?role)\s*[:=]\s*\S+/gi, "[redacted-credential]");
}

function safeEvidence(items: AccountQuotaEvidence[]): AccountQuotaEvidence[] {
  return items.map(item => ({ ...item, detail: redact(item.detail) }));
}

const unverifiedBinding = (): AccountQuotaBinding => ({
  previewOrigin: null,
  candidateCommit: null,
  deploymentId: null,
  testSupabaseOrigin: null,
  testSupabaseRef: ACCOUNT_QUOTA_TEST_REF,
  verified: false,
});

export function dryRunAccountQuotaReport(runId = `account-quota-${randomUUID().slice(0, 8)}`): AccountQuotaReport {
  return {
    schemaVersion: 1,
    mode: "dry-run",
    outcome: "NOT_EXECUTED",
    runId,
    targetRef: ACCOUNT_QUOTA_TEST_REF,
    externalWrites: false,
    binding: unverifiedBinding(),
    rounds: ([1, 2] as const).map(round => ({
      round,
      scenarios: ACCOUNT_QUOTA_PLANS.map(plan => reportScenario(buildAccountQuotaScenario(plan, runId))),
      evidence: [{
        surface: "http",
        status: "NOT_EXECUTED",
        caseId: "AQ-01..AQ-04",
        detail: "dry-run only: no Auth, database, route, OAuth state, provider, browser, or deployment call was made",
      }],
    })),
    cleanup: { status: "PASS", actions: [{ resource: "dry-run", status: "PASS", detail: "no synthetic resources were created" }] },
    failures: [],
  };
}

/** Run two safe rounds, and always call cleanup even after a partial failure. */
export async function applyAccountQuotaReport(
  adapter: AccountQuotaApplyAdapter,
  runId = `account-quota-${randomUUID().slice(0, 8)}`,
): Promise<AccountQuotaReport> {
  assertAccountQuotaTestRef(ACCOUNT_QUOTA_TEST_REF);
  const users = new Map<PlanKey, string>();
  const rounds: AccountQuotaReport["rounds"] = [];
  const failures: string[] = [];
  let binding = unverifiedBinding();
  let cleanup: AccountQuotaCleanup = { status: "FAIL", actions: [] };
  try {
    binding = await adapter.assertTarget(ACCOUNT_QUOTA_TEST_REF);
    if (!binding.verified || binding.testSupabaseRef !== ACCOUNT_QUOTA_TEST_REF) {
      throw new Error("Target binding was not independently verified");
    }
    for (const plan of ACCOUNT_QUOTA_PLANS) {
      const scenario = buildAccountQuotaScenario(plan, runId);
      const { userId } = await adapter.provision(scenario);
      if (!userId) throw new Error(`provision(${plan}) returned no user id`);
      users.set(plan, userId);
    }
    for (const round of [1, 2] as const) {
      const record: AccountQuotaReport["rounds"][number] = { round, scenarios: [], evidence: [] };
      rounds.push(record);
      for (const plan of ACCOUNT_QUOTA_PLANS) {
        const scenario = buildAccountQuotaScenario(plan, runId);
        const userId = users.get(plan);
        if (!userId) throw new Error(`missing provisioned ${plan} user`);
        await adapter.seedConnections(scenario, userId, { round });
        record.evidence.push(...safeEvidence(await adapter.verifyConnectGate(scenario, userId, { round })));
        record.scenarios.push(reportScenario(scenario));
      }
    }
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : String(error));
    failures.push(detail);
    const activeRound = rounds.at(-1);
    if (activeRound) activeRound.evidence.push({ surface: "http", status: "FAIL", detail: `run stopped: ${detail}` });
  } finally {
    try {
      cleanup = await adapter.cleanup(runId, [...users.values()]);
    } catch (error) {
      failures.push(redact(error instanceof Error ? error.message : String(error)));
      cleanup = { status: "FAIL", actions: [{ resource: "cleanup orchestration", status: "FAIL", detail: "adapter cleanup threw before returning a complete receipt" }] };
    }
  }
  const failedEvidence = rounds.some(round => round.evidence.some(item => item.status === "FAIL"));
  if (failedEvidence) failures.push("one or more evidence items failed");
  if (cleanup.status === "FAIL") failures.push("cleanup did not verify zero residual synthetic state");
  const partial = rounds.some(round => round.evidence.some(item => item.status === "NOT_EXECUTED" || item.status === "BLOCKED"));
  return {
    schemaVersion: 1,
    mode: "apply",
    outcome: failures.length > 0 ? "FAIL" : partial ? "PARTIAL" : "PASS",
    runId,
    targetRef: ACCOUNT_QUOTA_TEST_REF,
    externalWrites: true,
    binding,
    rounds,
    cleanup,
    failures,
  };
}

export function reportAccountQuotaMarkdown(report: AccountQuotaReport): string {
  const lines = [
    "# Credit Account Quota Report",
    "",
    `- Mode: ${report.mode}`,
    `- Outcome: ${report.outcome}`,
    `- Test project ref: ${report.targetRef}`,
    `- Binding verified: ${report.binding.verified ? "yes" : "no"}`,
    `- Preview origin: ${report.binding.previewOrigin ?? "NOT_EXECUTED"}`,
    `- Candidate commit: ${report.binding.candidateCommit ?? "NOT_EXECUTED"}`,
    `- Deployment: ${report.binding.deploymentId ?? "NOT_EXECUTED"}`,
    `- External writes: ${report.externalWrites ? "yes" : "no"}`,
    "- Raw synthetic emails, passwords, bearer tokens, and OAuth-state values are omitted.",
    "",
  ];
  for (const round of report.rounds) {
    lines.push(`## Round ${round.round}`, "", "| Plan | Limit | Held rows | Identity |", "| --- | --- | --- | --- |");
    for (const scenario of round.scenarios) {
      lines.push(`| ${scenario.plan} | ${scenario.limit} | ${scenario.connections.length} (includes disconnected) | ${scenario.emailFingerprint} |`);
    }
    lines.push("", "### Evidence", "");
    for (const item of round.evidence) {
      const caseId = item.caseId ? ` ${item.caseId}` : "";
      const screenshot = item.screenshot ? `; screenshot: ${item.screenshot}` : "";
      lines.push(`- [${item.status}]${caseId} ${item.surface}: ${item.detail}${screenshot}`);
    }
    lines.push("");
  }
  lines.push("## Cleanup", "", `- Cleanup: ${report.cleanup.status}`);
  for (const action of report.cleanup.actions) lines.push(`- [${action.status}] ${action.resource}: ${action.detail}`);
  if (report.failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }
  return lines.join("\n");
}
