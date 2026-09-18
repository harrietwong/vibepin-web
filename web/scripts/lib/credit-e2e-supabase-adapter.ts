import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLAN_ENTITLEMENTS } from "../../src/lib/server/planEntitlements";
import {
  CREDIT_E2E_PLANS,
  CREDIT_E2E_TEST_REF,
  assertStrictTestRef,
  syntheticEmail,
  type CleanupReceipt,
  type CreditE2eApplyAdapter,
  type CreditE2eRun,
  type Evidence,
  type TargetBinding,
} from "./credit-e2e-harness";
import { assertNotProduction, type TestDbConfig } from "./test-db-config";

export type PreviewIdentity = {
  vercelEnv?: unknown;
  deploymentId?: unknown;
  host?: unknown;
  forwardedHost?: unknown;
  forwardedProto?: unknown;
  vercelUrl?: unknown;
  origin?: unknown;
};

export type BuildIdentity = {
  environment?: unknown;
  buildSha?: unknown;
  deploymentId?: unknown;
};

export type PreviewExpectation = {
  baseUrl: string;
  expectedCommit: string;
  expectedDeploymentId: string;
};

function exactHttpsOrigin(value: string, label: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an exact HTTPS origin without path, query, credentials, or fragment`);
  }
  return parsed;
}

type PreviewProcessEnv = {
  readonly [key: string]: string | undefined;
  readonly VERCEL_AUTOMATION_BYPASS_SECRET?: string;
};

function isVercelPreviewOrigin(value: URL): boolean {
  return value.hostname === "vercel.app" || value.hostname.endsWith(".vercel.app");
}

/**
 * Returns the optional Vercel SSO bypass header for a Vercel Preview origin.
 * The secret is deliberately read only at the call site and is never included
 * in evidence, reports, or Supabase client configuration.
 */
export function buildPreviewRequestHeaders(
  baseUrl: string,
  env: PreviewProcessEnv = process.env,
): Record<string, string> {
  const origin = exactHttpsOrigin(baseUrl, "Preview base URL");
  if (!isVercelPreviewOrigin(origin)) return {};
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

export function buildPreviewBrowserContextOptions(
  baseUrl: string,
  env: PreviewProcessEnv = process.env,
): { extraHTTPHeaders?: Record<string, string> } {
  const headers = buildPreviewRequestHeaders(baseUrl, env);
  return Object.keys(headers).length > 0 ? { extraHTTPHeaders: headers } : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing`);
  return value.trim();
}

export function validatePreviewIdentity(identity: PreviewIdentity, expected: PreviewExpectation): void {
  const base = exactHttpsOrigin(expected.baseUrl, "Preview base URL");
  if (identity.vercelEnv !== "preview") throw new Error(`Expected Vercel preview, received ${String(identity.vercelEnv)}`);
  const actualDeployment = requiredString(identity.deploymentId, "Preview deployment id");
  if (actualDeployment !== expected.expectedDeploymentId) {
    throw new Error(`Preview deployment mismatch: expected ${expected.expectedDeploymentId}, received ${actualDeployment}`);
  }
  const identityHosts = [identity.host, identity.forwardedHost, identity.vercelUrl]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(value => value.toLowerCase());
  if (!identityHosts.includes(base.host.toLowerCase())) {
    throw new Error(`Preview host mismatch for ${base.host}`);
  }
  const actualOrigin = requiredString(identity.origin, "Preview origin");
  if (actualOrigin !== base.origin) throw new Error(`Preview origin mismatch: expected ${base.origin}`);
  if (identity.forwardedProto !== "https") throw new Error("Preview origin was not forwarded over HTTPS");
}

export function validateBuildIdentity(identity: BuildIdentity, expected: PreviewExpectation): void {
  exactHttpsOrigin(expected.baseUrl, "Preview base URL");
  if (identity.environment !== "preview") throw new Error(`Expected preview build, received ${String(identity.environment)}`);
  const wanted = requiredString(expected.expectedCommit, "Expected full commit").toLowerCase();
  const actual = requiredString(identity.buildSha, "Build full commit").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(wanted) || !/^[a-f0-9]{40}$/.test(actual)) {
    throw new Error("Exact full commit verification requires 40 hexadecimal characters on both sides");
  }
  if (actual !== wanted) throw new Error(`Build commit mismatch: expected ${wanted.slice(0, 12)}, received ${actual.slice(0, 12)}`);
  const deployment = requiredString(identity.deploymentId, "Build deployment id");
  if (deployment !== expected.expectedDeploymentId) throw new Error("Build deployment mismatch");
}

export function validateTestSupabaseBinding(config: TestDbConfig): { origin: string; projectRef: string } {
  assertNotProduction(config);
  assertStrictTestRef(config.projectRef);
  requiredString(config.anonKey, "Test Supabase anon key");
  requiredString(config.serviceRoleKey, "Test Supabase service-role key");
  const parsed = exactHttpsOrigin(config.url, "Test Supabase URL");
  const expectedOrigin = `https://${config.projectRef}.supabase.co`;
  const originRef = parsed.hostname.split(".")[0] ?? "";
  if (originRef !== config.projectRef) throw new Error("Test Supabase origin and declared ref disagree");
  if (parsed.origin !== expectedOrigin) {
    throw new Error("Test Supabase origin is not the exact project HTTPS origin");
  }
  return { origin: parsed.origin, projectRef: config.projectRef };
}

export type UsageAccountSeed = {
  user_id: string;
  plan_key: string;
  period_start: string;
  period_end: string;
  period_anchor: string;
  review_required: boolean;
  ai_images_limit: number | null;
  ai_text_generations_limit: number | null;
  scheduled_posts_limit: number | null;
  ai_images_used: number;
  ai_images_reserved: number;
  ai_text_generations_used: number;
  ai_text_generations_reserved: number;
  scheduled_posts_used: number;
  scheduled_posts_reserved: number;
  bonus_images_balance: number;
  bonus_images_reserved: number;
  bonus_images_used: number;
};

export function buildUsageAccountRow(input: CreditE2eRun, userId: string, now = new Date()): UsageAccountSeed {
  const end = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
  const entitlement = PLAN_ENTITLEMENTS[input.plan];
  return {
    user_id: userId,
    plan_key: input.plan,
    period_start: now.toISOString(),
    period_end: end.toISOString(),
    period_anchor: now.toISOString(),
    review_required: false,
    ai_images_limit: input.aiImages.limit,
    ai_text_generations_limit: entitlement.monthlyAiTextGenerations,
    scheduled_posts_limit: input.scheduledPosts.limit,
    ai_images_used: input.aiImages.used,
    ai_images_reserved: 0,
    ai_text_generations_used: 0,
    ai_text_generations_reserved: 0,
    scheduled_posts_used: input.scheduledPosts.used,
    scheduled_posts_reserved: 0,
    bonus_images_balance: 0,
    bonus_images_reserved: 0,
    bonus_images_used: 0,
  };
}

type UsageSnapshot = {
  plan?: unknown;
  state?: unknown;
  metered?: unknown;
  aiImages?: { used?: unknown; limit?: unknown; included?: unknown };
  scheduledPosts?: { used?: unknown; limit?: unknown; included?: unknown };
};

export function validateUsageSnapshot(value: UsageSnapshot, input: CreditE2eRun): void {
  if (value.plan !== input.plan) throw new Error(`Plan mismatch: expected ${input.plan}, received ${String(value.plan)}`);
  if (value.state !== "metered" || value.metered !== true) throw new Error("Usage snapshot is not metered");
  if (value.aiImages?.used !== input.aiImages.used) {
    throw new Error(`AI image used mismatch: expected ${input.aiImages.used}, received ${String(value.aiImages?.used)}`);
  }
  if (value.aiImages?.limit !== input.aiImages.limit || value.aiImages?.included !== input.aiImages.limit) {
    throw new Error("AI image limit/included mismatch");
  }
  if (value.scheduledPosts?.used !== input.scheduledPosts.used) {
    throw new Error(`Scheduled-post used mismatch: expected ${input.scheduledPosts.used}, received ${String(value.scheduledPosts?.used)}`);
  }
  if (value.scheduledPosts?.limit !== input.scheduledPosts.limit || value.scheduledPosts?.included !== input.scheduledPosts.limit) {
    throw new Error("Scheduled-post limit/included mismatch");
  }
}

export type BillingFixtureRows = {
  customer: {
    creem_customer_id: string;
    email: string;
    user_id: string;
    last_event_at: string;
    updated_at: string;
  };
  subscription: {
    creem_subscription_id: string;
    provider: "creem";
    creem_customer_id: string;
    user_id: string;
    status: "active";
    creem_product_id: string;
    plan: CreditE2eRun["plan"];
    billing_interval: "month";
    current_period_end: string;
    scheduled_cancel: false;
    last_event_at: string;
    updated_at: string;
  };
};

export function buildBillingFixtureRows(input: CreditE2eRun, userId: string, now = new Date()): BillingFixtureRows | null {
  if (input.plan === "free") return null;
  const at = now.toISOString();
  const currentPeriodEnd = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString();
  const customerId = `credit-e2e:${input.runId}:${input.plan}:customer`;
  return {
    customer: {
      creem_customer_id: customerId,
      email: input.email,
      user_id: userId,
      last_event_at: at,
      updated_at: at,
    },
    subscription: {
      creem_subscription_id: `credit-e2e:${input.runId}:${input.plan}:subscription`,
      provider: "creem",
      creem_customer_id: customerId,
      user_id: userId,
      status: "active",
      creem_product_id: `credit-e2e:${input.plan}:fixture`,
      plan: input.plan,
      billing_interval: "month",
      current_period_end: currentPeriodEnd,
      scheduled_cancel: false,
      last_event_at: at,
      updated_at: at,
    },
  };
}

export function buildSyntheticAppMetadata(input: CreditE2eRun): Record<string, unknown> {
  return {
    plan: input.plan,
    credit_e2e_run_id: input.runId,
    credit_e2e_synthetic: true,
  };
}

function planLabel(plan: CreditE2eRun["plan"]): string {
  return plan[0].toUpperCase() + plan.slice(1);
}

export function expectedBillingUi(input: CreditE2eRun): {
  plan: string;
  aiImages: string[];
  scheduledPosts: string[];
} {
  const aiRemaining = Math.max(0, input.aiImages.limit - input.aiImages.used);
  const scheduledPosts = input.scheduledPosts.limit === null
    ? ["Scheduled posts", `${input.scheduledPosts.used} used`, "No monthly limit"]
    : [
        "Scheduled posts",
        `${input.scheduledPosts.used} / ${input.scheduledPosts.limit} used`,
        `${Math.max(0, input.scheduledPosts.limit - input.scheduledPosts.used)} remaining`,
      ];
  return {
    plan: planLabel(input.plan),
    aiImages: ["AI images", `${input.aiImages.used} / ${input.aiImages.limit} used`, `${aiRemaining} remaining`],
    scheduledPosts,
  };
}

type BillingUiSections = string | { currentPlanText: string; usageText: string };

function semanticLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function lineAfterLabel(lines: string[], label: string): string[] {
  const wanted = label.toLowerCase();
  const bucketLabels = ["ai images", "ai text generations", "scheduled posts"];
  const index = lines.findIndex(line => {
    const lower = line.toLowerCase();
    return lower === wanted || lower.startsWith(`${wanted} `);
  });
  if (index < 0) throw new Error(`Billing UI is missing usage bucket: ${label}`);

  const firstLine = lines[index];
  const values = firstLine.length === label.length ? [] : [firstLine.slice(label.length).trim()];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const lower = lines[cursor].toLowerCase();
    if (bucketLabels.some(bucket => lower === bucket || lower.startsWith(`${bucket} `))) break;
    values.push(lines[cursor]);
  }
  return values;
}

function assertCappedBucket(
  lines: string[],
  label: string,
  expectedUsed: number,
  expectedLimit: number,
): void {
  const values = lineAfterLabel(lines, label);
  const summary = values.map(value => value.match(/^(\d+)\s*\/\s*(\d+)\s+used$/i)).find(Boolean);
  if (!summary || Number(summary[1]) !== expectedUsed || Number(summary[2]) !== expectedLimit) {
    throw new Error(`${label} used/limit semantic mismatch`);
  }
  const expectedRemaining = Math.max(0, expectedLimit - expectedUsed);
  const remaining = values.map(value => value.match(/^(\d+)\s+remaining$/i)).find(Boolean);
  if (!remaining || Number(remaining[1]) !== expectedRemaining) {
    throw new Error(`${label} remaining semantic mismatch`);
  }
}

function assertUnlimitedBucket(lines: string[], label: string, expectedUsed: number): void {
  const values = lineAfterLabel(lines, label);
  const summary = values.map(value => value.match(/^(\d+)\s+used$/i)).find(Boolean);
  if (!summary || Number(summary[1]) !== expectedUsed) throw new Error(`${label} used semantic mismatch`);
  if (!values.some(value => /^No monthly limit$/i.test(value))) {
    throw new Error(`${label} unlimited semantic mismatch`);
  }
}

function isExpectedPlanHeading(observed: string, expectedPlan: string): boolean {
  const actual = observed.replace(/\s+/g, " ").trim().toLowerCase();
  const plan = expectedPlan.toLowerCase();
  return new Set([
    plan,
    `${plan}monthly`,
    `${plan} monthly`,
    `${plan}yearly`,
    `${plan} yearly`,
  ]).has(actual);
}

export function validateBillingUiText(sections: BillingUiSections, input: CreditE2eRun): void {
  const currentPlanText = typeof sections === "string" ? sections : sections.currentPlanText;
  const usageText = typeof sections === "string" ? sections : sections.usageText;
  if (/Couldn't sync billing data|Could not load usage|usage unavailable/i.test(`${currentPlanText}\n${usageText}`)) {
    throw new Error("Billing UI displayed sync error instead of verified usage truth");
  }

  const planLines = semanticLines(currentPlanText);
  const planLabelIndex = planLines.findIndex(line => /^current\s+plan$/i.test(line));
  const inlinePlan = planLines
    .map(line => line.match(/^current\s+plan\s*[:—-]?\s+(.+)$/i)?.[1])
    .find(Boolean);
  const observedPlan = planLabelIndex >= 0 ? planLines[planLabelIndex + 1] : inlinePlan;
  const expectedPlan = planLabel(input.plan);
  if (!observedPlan || !isExpectedPlanHeading(observedPlan, expectedPlan)) {
    throw new Error(`Billing UI is missing expected semantic: current plan ${expectedPlan}`);
  }

  const usageLines = semanticLines(usageText);
  if (!usageLines.some(line => /^Usage this period(?:\s|$)/i.test(line))) {
    throw new Error("Billing UI is missing expected semantic: Usage this period");
  }
  assertCappedBucket(usageLines, "AI images", input.aiImages.used, input.aiImages.limit);
  if (input.scheduledPosts.limit === null) {
    assertUnlimitedBucket(usageLines, "Scheduled posts", input.scheduledPosts.used);
  } else {
    assertCappedBucket(usageLines, "Scheduled posts", input.scheduledPosts.used, input.scheduledPosts.limit);
  }
}

export function assertNoPrivateEvidence(text: string): void {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) throw new Error("Evidence contains a raw email");
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) {
    throw new Error("Evidence contains a raw owner identifier");
  }
  if (/\bBearer\s+\S+/i.test(text) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text)) {
    throw new Error("Evidence contains a raw token");
  }
}

export async function assertScreenshotDomSafe(
  readVisibleText: () => Promise<string>,
  syntheticEmail: string,
): Promise<void> {
  // Deliberately let DOM-read failures reject. An empty fallback would turn an
  // unreadable page into a false privacy PASS and could export uninspected pixels.
  const visibleText = await readVisibleText();
  const escapedEmail = syntheticEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assertNoPrivateEvidence(visibleText.replace(new RegExp(escapedEmail, "gi"), "[redacted-email]"));
}

export function buildScreenshotMaskLocators(page: Page, syntheticEmail: string): Locator[] {
  return [
    page.getByTestId("account-menu-trigger"),
    // The account address can be embedded in surrounding copy (for example,
    // "Signed in as user@…"), so exact matching would leave it unmasked.
    page.getByText(syntheticEmail, { exact: false }),
  ];
}

export type CleanupStep = { resource: string; run: () => Promise<void> };

export async function runCleanupSteps(steps: CleanupStep[]): Promise<CleanupReceipt> {
  const actions: CleanupReceipt["actions"] = [];
  for (const step of steps) {
    try {
      await step.run();
      actions.push({ resource: step.resource, status: "PASS", detail: "completed" });
    } catch {
      actions.push({ resource: step.resource, status: "FAIL", detail: "failed; see restricted runner logs" });
    }
  }
  return { status: actions.some(action => action.status === "FAIL") ? "FAIL" : "PASS", actions };
}

type ServiceClientFactory = (
  url: string,
  key: string,
  options: {
    auth: { persistSession: boolean; autoRefreshToken: boolean };
    global?: { fetch?: typeof fetch };
  },
) => SupabaseClient;

type AdapterOptions = PreviewExpectation & {
  config: TestDbConfig;
  screenshotDir?: string;
  fetchImpl?: typeof fetch;
  supabaseFetchImpl?: typeof fetch;
  serviceClientFactory?: ServiceClientFactory;
};

type Credential = { email: string; password: string };
type FixtureIdentity = { customerId?: string; subscriptionId?: string };
type DiscoveredSyntheticUser = { id: string; email: string; plan: CreditE2eRun["plan"] };

export class SupabaseCreditE2eAdapter implements CreditE2eApplyAdapter {
  private readonly service: SupabaseClient;
  private readonly credentials = new Map<string, Credential>();
  private readonly fixtureIdentities = new Map<string, FixtureIdentity>();
  private browser: Browser | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private bindingVerified = false;
  private resourceCreationAttempted = false;

  constructor(private readonly options: AdapterOptions) {
    // Validate every immutable target coordinate before a Supabase client can be
    // constructed. Creating the client first makes an invalid target harder to
    // distinguish from a client/configuration failure.
    validateTestSupabaseBinding(options.config);
    this.baseUrl = exactHttpsOrigin(options.baseUrl, "Preview base URL").origin;
    const expectedCommit = requiredString(options.expectedCommit, "Expected full commit");
    if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) throw new Error("Expected full commit must be 40 hexadecimal characters");
    requiredString(options.expectedDeploymentId, "Expected deployment id");
    this.fetchImpl = options.fetchImpl ?? fetch;
    const clientFactory: ServiceClientFactory = options.serviceClientFactory
      ?? ((url, key, clientOptions) => createClient(url, key, clientOptions));
    this.service = clientFactory(options.config.url, options.config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: options.supabaseFetchImpl },
    });
  }

  async assertTarget(ref: string): Promise<TargetBinding> {
    const testBinding = validateTestSupabaseBinding(this.options.config);
    assertStrictTestRef(ref);
    if (ref !== this.options.config.projectRef || ref !== CREDIT_E2E_TEST_REF) {
      throw new Error("Test project identity disagreement");
    }
    const previewHeaders = buildPreviewRequestHeaders(this.baseUrl);
    const response = await this.fetchImpl(`${this.baseUrl}/api/debug/deployment`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json", ...previewHeaders },
    });
    if (!response.ok) throw new Error(`Preview identity endpoint failed with HTTP ${response.status}`);
    const previewIdentity = await response.json() as PreviewIdentity;
    validatePreviewIdentity(previewIdentity, this.options);
    const versionResponse = await this.fetchImpl(`${this.baseUrl}/api/version`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json", ...previewHeaders },
    });
    if (!versionResponse.ok) throw new Error(`Build identity endpoint failed with HTTP ${versionResponse.status}`);
    const buildIdentity = await versionResponse.json() as BuildIdentity;
    validateBuildIdentity(buildIdentity, this.options);
    if (previewIdentity.deploymentId !== buildIdentity.deploymentId) throw new Error("Identity endpoints disagree on deployment id");
    const { error } = await this.service.from("usage_accounts").select("id").limit(0);
    if (error) throw new Error(`Test usage ledger preflight failed (${error.code ?? "unknown"})`);
    this.bindingVerified = true;
    return {
      previewOrigin: new URL(this.options.baseUrl).origin,
      candidateCommit: this.options.expectedCommit.toLowerCase(),
      deploymentId: this.options.expectedDeploymentId,
      testSupabaseOrigin: testBinding.origin,
      testSupabaseRef: testBinding.projectRef,
      verified: true,
    };
  }

  async provision(input: CreditE2eRun, password: string): Promise<{ userId: string }> {
    // Mark the attempt before awaiting createUser. A timeout or lost response can
    // still mean the Auth user was committed and must be discovered during cleanup.
    this.resourceCreationAttempted = true;
    const { data, error } = await this.service.auth.admin.createUser({
      email: input.email,
      password,
      email_confirm: true,
      app_metadata: buildSyntheticAppMetadata(input),
    });
    if (error || !data.user?.id) throw new Error(`Could not provision ${input.plan} synthetic account`);
    this.credentials.set(data.user.id, { email: input.email, password });
    return { userId: data.user.id };
  }

  private async discoverSyntheticRunUsers(runId: string): Promise<DiscoveredSyntheticUser[]> {
    const expectedByEmail = new Map(
      CREDIT_E2E_PLANS.map(plan => [syntheticEmail(plan, runId).toLowerCase(), plan] as const),
    );
    const matches: DiscoveredSyntheticUser[] = [];
    const perPage = 1000;
    for (let page = 1; page <= 100; page += 1) {
      const { data, error } = await this.service.auth.admin.listUsers({ page, perPage });
      if (error) throw new Error("Run-scoped Auth discovery failed");
      const users = data?.users ?? [];
      for (const user of users) {
        const email = user.email?.toLowerCase() ?? "";
        const plan = expectedByEmail.get(email);
        const metadata = user.app_metadata ?? {};
        if (
          plan
          && metadata.credit_e2e_synthetic === true
          && metadata.credit_e2e_run_id === runId
          && metadata.plan === plan
        ) {
          matches.push({ id: user.id, email, plan });
        }
      }
      if (users.length < perPage) return matches;
    }
    throw new Error("Run-scoped Auth discovery exceeded the bounded 100-page scan");
  }

  async seedUsage(input: CreditE2eRun, userId: string): Promise<void> {
    const row = buildUsageAccountRow(input, userId);
    const { error } = await this.service.from("usage_accounts").upsert(row, { onConflict: "user_id" });
    if (error) throw new Error(`Could not seed ${input.plan} usage (${error.code ?? "unknown"})`);
    const billing = buildBillingFixtureRows(input, userId);
    if (billing) {
      // Register both deterministic ids before the first write so cleanup can
      // remove a customer even when the following subscription write fails.
      this.fixtureIdentities.set(userId, {
        customerId: billing.customer.creem_customer_id,
        subscriptionId: billing.subscription.creem_subscription_id,
      });
      const { error: customerError } = await this.service.from("creem_customers").upsert(billing.customer, { onConflict: "creem_customer_id" });
      if (customerError) throw new Error(`Could not seed ${input.plan} billing customer (${customerError.code ?? "unknown"})`);
      const { error: subscriptionError } = await this.service.from("creem_subscriptions").upsert(billing.subscription, { onConflict: "creem_subscription_id" });
      if (subscriptionError) throw new Error(`Could not seed ${input.plan} billing subscription (${subscriptionError.code ?? "unknown"})`);
    }
  }

  private async accessToken(userId: string): Promise<string> {
    const credential = this.credentials.get(userId);
    if (!credential) throw new Error("Synthetic credential is missing");
    const client = createClient(this.options.config.url, this.options.config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.signInWithPassword(credential);
    if (error || !data.session?.access_token) throw new Error("Synthetic account sign-in failed");
    return data.session.access_token;
  }

  private async maskedScreenshot(
    page: Page,
    input: CreditE2eRun,
    round: 1 | 2,
    credential: Credential,
    suffix: "pass" | "fail",
  ): Promise<string> {
    if (!this.options.screenshotDir) throw new Error("Screenshot directory is required for apply evidence");
    await assertScreenshotDomSafe(() => page.locator("body").innerText(), credential.email);
    const masks = buildScreenshotMaskLocators(page, credential.email);
    await mkdir(resolve(this.options.screenshotDir), { recursive: true });
    const path = resolve(this.options.screenshotDir, `round-${round}-${input.plan}-${input.scenario}-billing-${suffix}.png`);
    await page.screenshot({ path, fullPage: true, mask: masks, maskColor: "#111827" });
    return path;
  }

  private async collectBillingUiEvidence(input: CreditE2eRun, userId: string, round: 1 | 2): Promise<Evidence[]> {
    if (!this.options.screenshotDir) {
      return [{
        surface: "billing",
        status: "NOT_EXECUTED",
        caseId: "CRED-01",
        detail: `${input.plan} ${input.scenario}: screenshot directory absent; browser UI assertions were not executed`,
      }];
    }
    const credential = this.credentials.get(userId);
    if (!credential) throw new Error("Synthetic browser credential is missing");
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    const browserContext = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
      locale: "en-US",
      ...buildPreviewBrowserContextOptions(this.baseUrl),
    });
    let evidencePage: Page | null = null;
    let stage: "session" | "billing" = "session";
    try {
      const loginPage = await browserContext.newPage();
      await loginPage.goto(`${this.baseUrl}/login?next=%2Fapp%2Fsettings%2Fbilling`, {
        waitUntil: "networkidle",
        timeout: 45_000,
      });
      await loginPage.locator('input[type="email"]').fill(credential.email);
      await loginPage.locator('input[type="password"]').fill(credential.password);
      await Promise.all([
        loginPage.waitForURL(url => url.pathname.startsWith("/app/settings/billing"), { timeout: 45_000 }),
        loginPage.getByRole("button", { name: "Sign in" }).click(),
      ]);

      const authCookies = (await browserContext.cookies(this.baseUrl)).filter(cookie =>
        cookie.name.startsWith(`sb-${this.options.config.projectRef}-auth-token`),
      );
      if (authCookies.length === 0) throw new Error("Email/password login did not establish a Supabase SSR auth cookie");

      // A brand-new page forces a fresh document request through the SSR proxy.
      // localStorage from the login page cannot satisfy this assertion.
      evidencePage = await browserContext.newPage();
      const protectedResponse = await evidencePage.goto(`${this.baseUrl}/app/settings/billing`, {
        waitUntil: "networkidle",
        timeout: 45_000,
      });
      if (!protectedResponse || protectedResponse.status() >= 400) throw new Error("Protected Billing document request failed");
      if (new URL(evidencePage.url()).pathname.startsWith("/login")) throw new Error("SSR proxy rejected the cookie session");

      stage = "billing";
      await evidencePage.getByTestId("settings-modal").waitFor({ state: "visible", timeout: 30_000 });
      await evidencePage.getByTestId("billing-usage-period").waitFor({ state: "visible", timeout: 30_000 });
      const currentPlanText = await evidencePage.getByTestId("billing-current-plan").innerText();
      const usageText = await evidencePage.getByTestId("billing-usage-period").innerText();
      validateBillingUiText({ currentPlanText, usageText }, input);
      if (await evidencePage.getByTestId("billing-sync-error").count() > 0) throw new Error("Billing status rendered sync-error semantics");
      if (await evidencePage.getByTestId("billing-usage-sync-error").count() > 0) throw new Error("Usage rendered sync-error semantics");
      const screenshot = await this.maskedScreenshot(evidencePage, input, round, credential, "pass");
      const expectation = expectedBillingUi(input);
      return [
        {
          surface: "session",
          status: "PASS",
          caseId: "CRED-01",
          detail: `${input.plan} ${input.scenario}: email/password login created SSR cookie; a fresh page passed the protected document guard`,
        },
        {
          surface: "billing",
          status: "PASS",
          caseId: "CRED-01",
          detail: `${input.plan} ${input.scenario}: asserted ${expectation.plan}, ${expectation.aiImages.join(", ")}, ${expectation.scheduledPosts.join(", ")}; sync-error UI absent; screenshot account regions masked and DOM PII scan passed`,
          screenshot,
        },
      ];
    } catch {
      let screenshot: string | undefined;
      if (evidencePage) screenshot = await this.maskedScreenshot(evidencePage, input, round, credential, "fail").catch(() => undefined);
      return [{
        surface: stage,
        status: "FAIL",
        caseId: "CRED-01",
        detail: `${input.plan} ${input.scenario}: ${stage === "session" ? "SSR cookie/session verification" : "Billing semantic assertion"} failed; no screenshot is emitted when the PII guard cannot prove safe masking`,
        ...(screenshot ? { screenshot } : {}),
      }];
    } finally {
      await browserContext.close().catch(() => undefined);
    }
  }

  private notExecutedProductEvidence(input: CreditE2eRun): Evidence[] {
    if (input.scenario === "default") return [];
    if (input.scenario === "limit_minus_one") {
      return [{
        surface: "product_path",
        status: "NOT_EXECUTED",
        caseId: "CRED-02",
        detail: `${input.plan}: no reviewed provider-safe product action fixture was available; near-limit reserve → job/provider → settle/release was not executed`,
      }];
    }
    return [
      {
        surface: "product_path",
        status: "NOT_EXECUTED",
        caseId: "CRED-03",
        detail: `${input.plan}: exhausted product action and its UI limit_reached semantics were not executed; RPC refusal evidence is reported separately`,
      },
      {
        surface: "job",
        status: "NOT_EXECUTED",
        caseId: "CRED-04..CRED-08",
        detail: `${input.plan}: failure, partial, unknown, replay, concurrency, idempotency, release, and cancel require a reviewed product/job fixture; none was invoked`,
      },
      {
        surface: "provider",
        status: "NOT_EXECUTED",
        caseId: "CRED-09..CRED-12",
        detail: `${input.plan}: scheduling, cross-owner, and anonymous product paths were not invoked; no provider/job/placeholder count is claimed`,
      },
      {
        surface: "billing",
        status: "NOT_EXECUTED",
        caseId: "CRED-13",
        detail: `${input.plan}: live Usage 500/503/timeout/invalid-shape UI error semantics were not injected because no reviewed safe Preview fault seam exists`,
      },
      {
        surface: "product_path",
        status: "NOT_EXECUTED",
        caseId: "CRED-14..CRED-16",
        detail: `${input.plan}: unlimited-meter action, rollover, and wallet/package isolation require reviewed product fixtures and were not executed`,
      },
    ];
  }

  async collectEvidence(input: CreditE2eRun, userId: string, context?: { round: 1 | 2 }): Promise<Evidence[]> {
    const { data: row, error: rowError } = await this.service
      .from("usage_accounts")
      .select("plan_key,ai_images_used,ai_images_limit,scheduled_posts_used,scheduled_posts_limit,ai_images_reserved,bonus_images_balance")
      .eq("user_id", userId)
      .single();
    if (rowError || !row) throw new Error(`Could not read back ${input.plan} usage`);
    if (row.plan_key !== input.plan || row.ai_images_used !== input.aiImages.used || row.ai_images_limit !== input.aiImages.limit) {
      throw new Error(`${input.plan} database usage readback mismatch`);
    }
    if (row.scheduled_posts_used !== input.scheduledPosts.used || row.scheduled_posts_limit !== input.scheduledPosts.limit) {
      throw new Error(`${input.plan} scheduled-post readback mismatch`);
    }
    if (row.ai_images_reserved !== 0 || row.bonus_images_balance !== 0) throw new Error(`${input.plan} seed has unexpected reserved/bonus usage`);

    const token = await this.accessToken(userId);
    const response = await this.fetchImpl(`${this.baseUrl}/api/billing/usage`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...buildPreviewRequestHeaders(this.baseUrl) },
    });
    if (!response.ok) throw new Error(`${input.plan} usage API returned HTTP ${response.status}`);
    const snapshot = await response.json() as UsageSnapshot;
    validateUsageSnapshot(snapshot, input);

    const evidence: Evidence[] = [
      { surface: "database", status: "PASS", detail: `${input.plan} ${input.scenario}: exact usage counters and zero reserved/bonus read back` },
      { surface: "http", status: "PASS", detail: `${input.plan} ${input.scenario}: authenticated usage API matched plan, used, limit, and included` },
    ];

    if (input.scenario === "limit") {
      const { count: before, error: beforeError } = await this.service
        .from("usage_reservations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (beforeError) throw new Error(`${input.plan} reservation pre-count failed`);
      const key = `credit-e2e:${input.runId}:${context?.round ?? 0}:${input.plan}:${randomUUID()}`;
      const { data, error } = await this.service.rpc("usage_reserve", {
        p_user_id: userId,
        p_usage_type: "ai_image",
        p_slot_keys: [`${key}:slot`],
        p_request_key: key,
        p_operation: "credit_e2e_exhausted_probe",
        p_reference_id: key,
        p_metadata: { credit_e2e: true },
      });
      if (error) throw new Error(`${input.plan} exhausted reserve probe failed (${error.code ?? "unknown"})`);
      const result = data as { ok?: unknown; reason?: unknown } | null;
      if (result?.ok !== false || result.reason !== "insufficient_capacity") {
        throw new Error(`${input.plan} exhausted usage was not refused`);
      }
      const { count: after, error: afterError } = await this.service
        .from("usage_reservations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (afterError || before !== after) throw new Error(`${input.plan} exhausted probe created a reservation`);
      evidence.push({
        surface: "rpc",
        status: "PASS",
        caseId: "CRED-03",
        detail: `${input.plan} exhausted: usage_reserve returned insufficient_capacity and the reservation row count was unchanged; this is RPC-only evidence`,
        json: JSON.stringify({ ok: false, reason: "insufficient_capacity" }),
      });
    }

    evidence.push(...await this.collectBillingUiEvidence(input, userId, context?.round ?? 1));
    evidence.push(...this.notExecutedProductEvidence(input));
    return evidence;
  }

  async cleanup(runId: string, userIds: string[]): Promise<CleanupReceipt> {
    if (
      !this.bindingVerified
      && !this.resourceCreationAttempted
      && userIds.length === 0
      && !this.browser
      && this.fixtureIdentities.size === 0
    ) {
      return {
        status: "PASS",
        actions: [{ resource: "unverified preflight", status: "PASS", detail: "no resources were created; cleanup issued no external requests" }],
      };
    }
    let discoveredUsers: DiscoveredSyntheticUser[] = [];
    const discoveryReceipt = await runCleanupSteps([{
      resource: "run-scoped temporary Auth discovery",
      run: async () => {
        discoveredUsers = await this.discoverSyntheticRunUsers(runId);
      },
    }]);
    const planByUserId = new Map(discoveredUsers.map(user => [user.id, user.plan] as const));
    for (const [userId, credential] of this.credentials) {
      const plan = CREDIT_E2E_PLANS.find(candidate => credential.email.toLowerCase() === syntheticEmail(candidate, runId).toLowerCase());
      if (plan) planByUserId.set(userId, plan);
    }
    const cleanupUserIds = [...new Set([...userIds, ...discoveredUsers.map(user => user.id)])];
    const steps: CleanupStep[] = [];
    if (this.browser) {
      steps.push({
        resource: "browser",
        run: async () => {
          await this.browser?.close();
          this.browser = null;
        },
      });
    }
    cleanupUserIds.forEach((userId, index) => {
      const owner = `owner-${index + 1}`;
      const plan = planByUserId.get(userId);
      const derivedFixture = plan && plan !== "free"
        ? {
            customerId: `credit-e2e:${runId}:${plan}:customer`,
            subscriptionId: `credit-e2e:${runId}:${plan}:subscription`,
          }
        : undefined;
      const fixture = this.fixtureIdentities.get(userId) ?? derivedFixture;
      if (fixture?.subscriptionId) {
        steps.push({ resource: `${owner} billing subscription`, run: async () => {
          const { error } = await this.service.from("creem_subscriptions").delete().eq("creem_subscription_id", fixture.subscriptionId as string);
          if (error) throw error;
        } });
      }
      if (fixture?.customerId) {
        steps.push({ resource: `${owner} billing customer`, run: async () => {
          const { error } = await this.service.from("creem_customers").delete().eq("creem_customer_id", fixture.customerId as string);
          if (error) throw error;
        } });
      }
      steps.push(
        { resource: `${owner} usage account and cascades`, run: async () => {
          const { error } = await this.service.from("usage_accounts").delete().eq("user_id", userId);
          if (error) throw error;
        } },
        { resource: `${owner} auth account`, run: async () => {
          const { error } = await this.service.auth.admin.deleteUser(userId);
          if (error) throw error;
        } },
        { resource: `${owner} zero-residual database verification`, run: async () => {
          for (const table of ["usage_accounts", "usage_reservations", "usage_events"] as const) {
            const { count, error } = await this.service.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId);
            if (error || count !== 0) throw new Error(`${table} residual verification failed`);
          }
        } },
        { resource: `${owner} zero-residual auth verification`, run: async () => {
          const { data, error } = await this.service.auth.admin.getUserById(userId);
          if (data.user) throw new Error("auth user remains");
          if (error) {
            const status = (error as { status?: number }).status;
            if (status !== 404 && !/not found/i.test(error.message)) throw error;
          }
        } },
      );
    });
    steps.push({ resource: "run-scoped billing zero-residual verification", run: async () => {
      const prefix = `credit-e2e:${runId}:%`;
      for (const [table, column] of [
        ["creem_customers", "creem_customer_id"],
        ["creem_subscriptions", "creem_subscription_id"],
      ] as const) {
        const { count, error } = await this.service.from(table).select(column, { count: "exact", head: true }).like(column, prefix);
        if (error || count !== 0) throw new Error(`${table} run residual verification failed`);
      }
    } });
    steps.push({ resource: "run-scoped zero-residual Auth verification", run: async () => {
      const residual = await this.discoverSyntheticRunUsers(runId);
      if (residual.length !== 0) throw new Error("run-scoped temporary Auth accounts remain");
    } });
    const cleanupReceipt = await runCleanupSteps(steps);
    const actions = [...discoveryReceipt.actions, ...cleanupReceipt.actions];
    const receipt: CleanupReceipt = {
      status: actions.some(action => action.status === "FAIL") ? "FAIL" : "PASS",
      actions,
    };
    for (const userId of cleanupUserIds) {
      this.credentials.delete(userId);
      this.fixtureIdentities.delete(userId);
    }
    return receipt;
  }
}
