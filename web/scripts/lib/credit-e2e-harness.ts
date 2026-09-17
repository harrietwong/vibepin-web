/**
 * Pure contracts for the four-plan credit E2E channel.
 *
 * This module deliberately has no Supabase or browser import.  The CLI may create
 * a manifest and a redacted report without credentials; a future live adapter must
 * implement the explicit interfaces below and pass the same target guard first.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PLAN_ENTITLEMENTS, type PlanKey } from "../../src/lib/server/planEntitlements";

export const CREDIT_E2E_TEST_REF = "snulmwprsahzqvdbyenc";
export const CREDIT_E2E_PRODUCTION_REF = "jaxteelkecvlozdrdoog";
export const CREDIT_E2E_PLANS: readonly PlanKey[] = ["free", "starter", "pro", "business"];

export type CreditE2eScenario = "default" | "limit_minus_one" | "limit";
export type CreditE2eRun = {
  runId: string;
  plan: PlanKey;
  email: string;
  emailFingerprint: string;
  scenario: CreditE2eScenario;
  aiImages: { used: number; limit: number };
  scheduledPosts: { used: number; limit: number | null };
  accountsPerPlatform: number;
};

export type CreditE2eReportScenario = Omit<CreditE2eRun, "email">;

export type Evidence = {
  surface: "binding" | "session" | "billing" | "usage" | "http" | "database" | "rpc" | "product_path" | "job" | "provider" | "cleanup";
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_EXECUTED";
  detail: string;
  caseId?: string;
  screenshot?: string;
  json?: string;
};

export type TargetBinding = {
  previewOrigin: string | null;
  candidateCommit: string | null;
  deploymentId: string | null;
  testSupabaseOrigin: string | null;
  testSupabaseRef: string;
  verified: boolean;
};

export type CleanupActionReceipt = {
  resource: string;
  status: "PASS" | "FAIL";
  detail: string;
};

export type CleanupReceipt = {
  status: "PASS" | "FAIL";
  actions: CleanupActionReceipt[];
};

export type CreditE2eReport = {
  schemaVersion: 2;
  mode: "dry-run" | "apply";
  outcome: "PASS" | "FAIL" | "PARTIAL" | "NOT_EXECUTED";
  runId: string;
  targetRef: string;
  binding: TargetBinding;
  externalWrites: boolean;
  rounds: Array<{ round: 1 | 2; scenarios: CreditE2eReportScenario[]; evidence: Evidence[] }>;
  cleanup: CleanupReceipt;
  failures: string[];
};

/** Synthetic-only identities. `runId` is constrained so account names never escape the test namespace. */
export function syntheticEmail(plan: PlanKey, runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(runId)) throw new Error("runId must be 3–64 URL-safe characters");
  return `e2e-credit-${plan}-${runId}@vibepin.test`;
}

export function redactEmail(email: string): string {
  return `sha256:${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

/** Never log, return in reports, or persist this value. It is only for a live Auth adapter. */
export function ephemeralPassword(): string {
  return randomBytes(32).toString("base64url");
}

export function newRunId(): string {
  return `credit-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function assertStrictTestRef(ref: string): void {
  if (ref === CREDIT_E2E_PRODUCTION_REF) throw new Error("REFUSING: Production project ref is forbidden");
  if (ref !== CREDIT_E2E_TEST_REF) {
    throw new Error(`REFUSING: expected isolated test ref ${CREDIT_E2E_TEST_REF}, received ${ref || "(empty)"}`);
  }
}

function usedAt(limit: number | null, scenario: CreditE2eScenario): number {
  if (scenario === "default") return 0;
  if (limit === null) return scenario === "limit" ? 2 : 1;
  return scenario === "limit" ? limit : Math.max(0, limit - 1);
}

export function buildScenario(plan: PlanKey, runId: string, scenario: CreditE2eScenario): CreditE2eRun {
  const entitlement = PLAN_ENTITLEMENTS[plan];
  const aiLimit = entitlement.monthlyAiImages;
  if (aiLimit === null) throw new Error(`${plan} must have a finite AI image allowance`);
  const postLimit = entitlement.monthlyScheduledPosts;
  const email = syntheticEmail(plan, runId);
  return {
    runId,
    plan,
    email,
    emailFingerprint: redactEmail(email),
    scenario,
    aiImages: { used: usedAt(aiLimit, scenario), limit: aiLimit },
    scheduledPosts: { used: usedAt(postLimit, scenario), limit: postLimit },
    accountsPerPlatform: entitlement.connectedAccountsPerPlatform ?? 0,
  };
}

/**
 * All state-changing integrations must implement this. The CLI intentionally
 * ships without an implementation, preventing accidental DB writes until a
 * separately reviewed adapter is added.
 */
export interface CreditE2eApplyAdapter {
  assertTarget(ref: string): Promise<TargetBinding>;
  provision(input: CreditE2eRun, password: string): Promise<{ userId: string }>;
  seedUsage(input: CreditE2eRun, userId: string, context?: { round: 1 | 2 }): Promise<void>;
  collectEvidence(input: CreditE2eRun, userId: string, context?: { round: 1 | 2 }): Promise<Evidence[]>;
  cleanup(runId: string, userIds: string[]): Promise<CleanupReceipt>;
}

/** Strip apply-only identity material before anything can enter a persisted report. */
export function reportScenario(input: CreditE2eRun): CreditE2eReportScenario {
  const { email: _email, ...safe } = input;
  void _email;
  return safe;
}

function redactEvidenceText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]");
}

function safeEvidence(items: Evidence[]): Evidence[] {
  return items.map(item => ({
    ...item,
    detail: redactEvidenceText(item.detail),
    ...(item.json ? { json: redactEvidenceText(item.json) } : {}),
  }));
}

/**
 * Execute the state-changing channel through an independently reviewed adapter.
 * Exactly four identities are provisioned, then reused for near-limit and exhausted
 * scenarios in two rounds. Cleanup is unconditional and runs after partial failure.
 */
export async function applyReport(
  adapter: CreditE2eApplyAdapter,
  runId = newRunId(),
): Promise<CreditE2eReport> {
  assertStrictTestRef(CREDIT_E2E_TEST_REF);
  const users = new Map<PlanKey, string>();
  const createdUserIds: string[] = [];
  const rounds: CreditE2eReport["rounds"] = [];
  const failures: string[] = [];
  let binding: TargetBinding = {
    previewOrigin: null,
    candidateCommit: null,
    deploymentId: null,
    testSupabaseOrigin: null,
    testSupabaseRef: CREDIT_E2E_TEST_REF,
    verified: false,
  };
  let cleanup: CleanupReceipt = { status: "FAIL", actions: [] };
  try {
    binding = await adapter.assertTarget(CREDIT_E2E_TEST_REF);
    if (!binding.verified || binding.testSupabaseRef !== CREDIT_E2E_TEST_REF) {
      throw new Error("Target binding was not independently verified");
    }
    for (const plan of CREDIT_E2E_PLANS) {
      const identity = buildScenario(plan, runId, "limit_minus_one");
      const { userId } = await adapter.provision(identity, ephemeralPassword());
      if (!userId) throw new Error(`provision(${plan}) returned no user id`);
      users.set(plan, userId);
      createdUserIds.push(userId);
    }

    for (const round of [1, 2] as const) {
      const roundReport: CreditE2eReport["rounds"][number] = { round, scenarios: [], evidence: [] };
      rounds.push(roundReport);
      for (const plan of CREDIT_E2E_PLANS) {
        const userId = users.get(plan);
        if (!userId) throw new Error(`missing provisioned identity for ${plan}`);
        for (const scenarioName of ["default", "limit_minus_one", "limit"] as const) {
          const scenario = buildScenario(plan, runId, scenarioName);
          await adapter.seedUsage(scenario, userId, { round });
          roundReport.evidence.push(...safeEvidence(await adapter.collectEvidence(scenario, userId, { round })));
          roundReport.scenarios.push(reportScenario(scenario));
        }
      }
    }
  } catch (error) {
    const message = redactEvidenceText((error as Error)?.message ?? String(error));
    failures.push(message);
    const activeRound = rounds.at(-1);
    if (activeRound) activeRound.evidence.push({ surface: "http", status: "FAIL", detail: `run stopped: ${message}` });
  } finally {
    try {
      cleanup = await adapter.cleanup(runId, createdUserIds);
    } catch (error) {
      cleanup = {
        status: "FAIL",
        actions: [{ resource: "cleanup orchestration", status: "FAIL", detail: "adapter cleanup threw before returning a complete receipt" }],
      };
      failures.push(redactEvidenceText((error as Error)?.message ?? String(error)));
    }
  }

  const failedEvidenceCount = rounds.reduce(
    (count, round) => count + round.evidence.filter(item => item.status === "FAIL").length,
    0,
  );
  if (failedEvidenceCount > 0) failures.push(`${failedEvidenceCount} evidence item(s) failed`);
  if (cleanup.status === "FAIL") failures.push("cleanup did not verify zero residual synthetic state");
  const hasNotExecuted = rounds.some(round => round.evidence.some(item => item.status === "NOT_EXECUTED" || item.status === "BLOCKED"));
  return {
    schemaVersion: 2,
    mode: "apply",
    outcome: failures.length > 0 ? "FAIL" : hasNotExecuted ? "PARTIAL" : "PASS",
    runId,
    targetRef: CREDIT_E2E_TEST_REF,
    binding,
    externalWrites: true,
    rounds,
    cleanup,
    failures,
  };
}

export function dryRunReport(runId = newRunId()): CreditE2eReport {
  const rounds = ([1, 2] as const).map(round => ({
    round,
    scenarios: CREDIT_E2E_PLANS.flatMap(plan => [
      buildScenario(plan, runId, "default"),
      buildScenario(plan, runId, "limit_minus_one"),
      buildScenario(plan, runId, "limit"),
    ]).map(reportScenario),
    evidence: [{
      surface: "http" as const,
      status: "NOT_EXECUTED" as const,
      detail: "dry-run only: no browser, HTTP, database, checkout, payment, or AI generation was invoked",
    }],
  }));
  return {
    schemaVersion: 2,
    mode: "dry-run",
    outcome: "NOT_EXECUTED",
    runId,
    targetRef: CREDIT_E2E_TEST_REF,
    binding: {
      previewOrigin: null,
      candidateCommit: null,
      deploymentId: null,
      testSupabaseOrigin: null,
      testSupabaseRef: CREDIT_E2E_TEST_REF,
      verified: false,
    },
    externalWrites: false,
    rounds,
    cleanup: { status: "PASS", actions: [{ resource: "dry-run", status: "PASS", detail: "no synthetic state was created" }] },
    failures: [],
  };
}

export function failedApplyReport(runId: string, error: unknown): CreditE2eReport {
  const failure = redactEvidenceText((error as Error)?.message ?? String(error));
  return {
    schemaVersion: 2,
    mode: "apply",
    outcome: "FAIL",
    runId,
    targetRef: CREDIT_E2E_TEST_REF,
    binding: {
      previewOrigin: null,
      candidateCommit: null,
      deploymentId: null,
      testSupabaseOrigin: null,
      testSupabaseRef: CREDIT_E2E_TEST_REF,
      verified: false,
    },
    externalWrites: false,
    rounds: [],
    cleanup: {
      status: "PASS",
      actions: [{ resource: "preflight", status: "PASS", detail: "failed before adapter writes were enabled" }],
    },
    failures: [failure],
  };
}

export function reportMarkdown(report: CreditE2eReport): string {
  const lines = [
    "# Credit E2E Report",
    "",
    `- Mode: ${report.mode}`,
    `- Outcome: ${report.outcome}`,
    `- Test project ref: ${report.targetRef}`,
    `- Binding verified: ${report.binding.verified ? "yes" : "no"}`,
    `- Preview origin: ${report.binding.previewOrigin ?? "NOT_EXECUTED"}`,
    `- Candidate commit: ${report.binding.candidateCommit ?? "NOT_EXECUTED"}`,
    `- Deployment: ${report.binding.deploymentId ?? "NOT_EXECUTED"}`,
    `- Test Supabase origin: ${report.binding.testSupabaseOrigin ?? "NOT_EXECUTED"}`,
    `- External writes: ${report.externalWrites ? "yes" : "no"}`,
    `- Run: ${report.runId}`,
    "- Credentials, passwords, bearer tokens, and raw synthetic emails are deliberately omitted.",
    "",
  ];
  for (const round of report.rounds) {
    lines.push(`## Round ${round.round}`, "", "| Plan | AI images | Scheduled posts | Accounts/platform | Identity |", "| --- | --- | --- | --- | --- |");
    for (const scenario of round.scenarios) {
      const posts = scenario.scheduledPosts.limit === null
        ? `${scenario.scheduledPosts.used}/Unlimited`
        : `${scenario.scheduledPosts.used}/${scenario.scheduledPosts.limit}`;
      lines.push(`| ${scenario.plan} (${scenario.scenario}) | ${scenario.aiImages.used}/${scenario.aiImages.limit} | ${posts} | ${scenario.accountsPerPlatform} | ${scenario.emailFingerprint} |`);
    }
    lines.push("", "### Evidence", "");
    for (const item of round.evidence) {
      const caseLabel = item.caseId ? ` ${item.caseId}` : "";
      const screenshot = item.screenshot ? `; screenshot: ${item.screenshot}` : "";
      const json = item.json ? `; response: ${item.json}` : "";
      lines.push(`- [${item.status}]${caseLabel} ${item.surface}: ${item.detail}${screenshot}${json}`);
    }
    lines.push("");
  }
  lines.push("## Cleanup", "", `- Cleanup: ${report.cleanup.status}`);
  for (const action of report.cleanup.actions) lines.push(`- [${action.status}] ${action.resource}: ${action.detail}`);
  if (report.failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of report.failures) lines.push(`- ${failure}`);
  }
  return lines.join("\n");
}
