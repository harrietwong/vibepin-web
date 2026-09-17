import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLAN_ENTITLEMENTS } from "../../src/lib/server/planEntitlements";
import {
  CREDIT_E2E_TEST_REF,
  assertStrictTestRef,
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
    ? ["Scheduled posts", `${input.scheduledPosts.used} used`, "Unlimited", "No monthly limit"]
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

export function validateBillingUiText(text: string, input: CreditE2eRun): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/Couldn't sync billing data|Could not load usage|usage unavailable/i.test(normalized)) {
    throw new Error("Billing UI displayed sync error instead of verified usage truth");
  }
  const expected = expectedBillingUi(input);
  const fragments = [`Current plan ${expected.plan}`, "Usage this period", ...expected.aiImages, ...expected.scheduledPosts];
  const requiredCounts = new Map<string, number>();
  for (const fragment of fragments) requiredCounts.set(fragment, (requiredCounts.get(fragment) ?? 0) + 1);
  for (const [fragment, required] of requiredCounts) {
    const actual = normalized.split(fragment).length - 1;
    if (actual < required) throw new Error(`Billing UI is missing expected semantic: ${fragment}`);
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

export function validateRestoredAppMetadata(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
): void {
  if (current.credit_e2e_run_id !== original.credit_e2e_run_id) {
    throw new Error("Synthetic run metadata was not restored");
  }
  if (current.plan !== original.plan) throw new Error("Synthetic plan metadata was not restored");
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

type AdapterOptions = PreviewExpectation & {
  config: TestDbConfig;
  screenshotDir?: string;
  fetchImpl?: typeof fetch;
};

type Credential = { email: string; password: string };
type FixtureIdentity = { customerId?: string; subscriptionId?: string };

export class SupabaseCreditE2eAdapter implements CreditE2eApplyAdapter {
  private readonly service: SupabaseClient;
  private readonly credentials = new Map<string, Credential>();
  private readonly originalAppMetadata = new Map<string, Record<string, unknown>>();
  private readonly fixtureIdentities = new Map<string, FixtureIdentity>();
  private browser: Browser | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: AdapterOptions) {
    this.baseUrl = new URL(options.baseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.service = createClient(options.config.url, options.config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async assertTarget(ref: string): Promise<TargetBinding> {
    const testBinding = validateTestSupabaseBinding(this.options.config);
    assertStrictTestRef(ref);
    if (ref !== this.options.config.projectRef || ref !== CREDIT_E2E_TEST_REF) {
      throw new Error("Test project identity disagreement");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/debug/deployment`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Preview identity endpoint failed with HTTP ${response.status}`);
    const previewIdentity = await response.json() as PreviewIdentity;
    validatePreviewIdentity(previewIdentity, this.options);
    const versionResponse = await this.fetchImpl(`${this.baseUrl}/api/version`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!versionResponse.ok) throw new Error(`Build identity endpoint failed with HTTP ${versionResponse.status}`);
    const buildIdentity = await versionResponse.json() as BuildIdentity;
    validateBuildIdentity(buildIdentity, this.options);
    if (previewIdentity.deploymentId !== buildIdentity.deploymentId) throw new Error("Identity endpoints disagree on deployment id");
    const { error } = await this.service.from("usage_accounts").select("id").limit(0);
    if (error) throw new Error(`Test usage ledger preflight failed (${error.code ?? "unknown"})`);
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
    const { data, error } = await this.service.auth.admin.createUser({
      email: input.email,
      password,
      email_confirm: true,
    });
    if (error || !data.user?.id) throw new Error(`Could not provision ${input.plan} synthetic account`);
    this.credentials.set(data.user.id, { email: input.email, password });
    this.originalAppMetadata.set(data.user.id, { ...(data.user.app_metadata ?? {}) });
    return { userId: data.user.id };
  }

  async seedUsage(input: CreditE2eRun, userId: string): Promise<void> {
    const { error: metaError } = await this.service.auth.admin.updateUserById(userId, {
      app_metadata: { plan: input.plan, credit_e2e_run_id: input.runId },
    });
    if (metaError) throw new Error(`Could not set ${input.plan} trusted plan metadata`);
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
    await mkdir(resolve(this.options.screenshotDir), { recursive: true });
    const visibleText = await page.locator("body").innerText().catch(() => "");
    assertNoPrivateEvidence(visibleText.replaceAll(credential.email, "[redacted-email]"));
    const masks: Locator[] = [page.getByTestId("account-menu-trigger"), page.getByText(credential.email, { exact: true })];
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
      validateBillingUiText(`${currentPlanText}\n${usageText}`, input);
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
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
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
    userIds.forEach((userId, index) => {
      const owner = `owner-${index + 1}`;
      const fixture = this.fixtureIdentities.get(userId);
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
        { resource: `${owner} run metadata restore`, run: async () => {
          const { error } = await this.service.auth.admin.updateUserById(userId, {
            app_metadata: this.originalAppMetadata.get(userId) ?? {},
          });
          if (error) throw error;
        } },
        { resource: `${owner} run metadata verification`, run: async () => {
          const original = this.originalAppMetadata.get(userId) ?? {};
          const { data, error } = await this.service.auth.admin.getUserById(userId);
          if (error || !data.user) throw error ?? new Error("auth user missing before cleanup");
          validateRestoredAppMetadata(original, { ...(data.user.app_metadata ?? {}) });
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
    const receipt = await runCleanupSteps(steps);
    for (const userId of userIds) {
      this.credentials.delete(userId);
      this.originalAppMetadata.delete(userId);
      this.fixtureIdentities.delete(userId);
    }
    return receipt;
  }
}
