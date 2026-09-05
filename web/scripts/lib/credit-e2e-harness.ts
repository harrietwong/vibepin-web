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

export type CreditE2eScenario = "limit_minus_one" | "limit";
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

export type Evidence = {
  surface: "billing" | "usage" | "create_pin" | "http" | "database";
  status: "PASS" | "FAIL" | "NOT_OBSERVED";
  detail: string;
  screenshot?: string;
  json?: string;
};

export type CreditE2eReport = {
  schemaVersion: 1;
  mode: "dry-run" | "apply";
  runId: string;
  targetRef: string;
  externalWrites: boolean;
  rounds: Array<{ round: 1 | 2; scenarios: CreditE2eRun[]; evidence: Evidence[] }>;
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
  if (limit === null) return scenario === "limit" ? 10_000 : 9_999;
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
  assertTarget(ref: string): Promise<void>;
  provision(input: CreditE2eRun, password: string): Promise<{ userId: string }>;
  seedUsage(input: CreditE2eRun, userId: string): Promise<void>;
  collectEvidence(input: CreditE2eRun, userId: string): Promise<Evidence[]>;
  cleanup(runId: string, userIds: string[]): Promise<void>;
}

export function dryRunReport(runId = newRunId()): CreditE2eReport {
  const rounds = ([1, 2] as const).map(round => ({
    round,
    scenarios: CREDIT_E2E_PLANS.flatMap(plan => [
      buildScenario(plan, runId, "limit_minus_one"),
      buildScenario(plan, runId, "limit"),
    ]),
    evidence: [{
      surface: "http" as const,
      status: "NOT_OBSERVED" as const,
      detail: "dry-run only: no browser, HTTP, database, checkout, payment, or AI generation was invoked",
    }],
  }));
  return { schemaVersion: 1, mode: "dry-run", runId, targetRef: CREDIT_E2E_TEST_REF, externalWrites: false, rounds };
}

export function reportMarkdown(report: CreditE2eReport): string {
  const lines = [
    "# Credit E2E Report",
    "",
    `- Mode: ${report.mode}`,
    `- Test project ref: ${report.targetRef}`,
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
    for (const item of round.evidence) lines.push(`- [${item.status}] ${item.surface}: ${item.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}
