import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PLAN_ENTITLEMENTS } from "../../src/lib/server/planEntitlements";
import {
  CREDIT_E2E_TEST_REF,
  assertStrictTestRef,
  type CreditE2eApplyAdapter,
  type CreditE2eRun,
  type Evidence,
} from "./credit-e2e-harness";
import { assertNotProduction, type TestDbConfig } from "./test-db-config";

export type PreviewIdentity = {
  vercelEnv?: unknown;
  gitCommitSha?: unknown;
  deploymentId?: unknown;
  host?: unknown;
  forwardedHost?: unknown;
  vercelUrl?: unknown;
};

export type PreviewExpectation = {
  baseUrl: string;
  expectedCommit: string;
  expectedDeploymentId: string;
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing`);
  return value.trim();
}

export function validatePreviewIdentity(identity: PreviewIdentity, expected: PreviewExpectation): void {
  const base = new URL(expected.baseUrl);
  if (base.protocol !== "https:") throw new Error("Preview base URL must use HTTPS");
  if (identity.vercelEnv !== "preview") throw new Error(`Expected Vercel preview, received ${String(identity.vercelEnv)}`);
  const actualCommit = requiredString(identity.gitCommitSha, "Preview commit");
  const wantedCommit = requiredString(expected.expectedCommit, "Expected commit");
  if (!wantedCommit.startsWith(actualCommit) && !actualCommit.startsWith(wantedCommit)) {
    throw new Error(`Preview commit mismatch: expected ${wantedCommit.slice(0, 12)}, received ${actualCommit.slice(0, 12)}`);
  }
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

type AdapterOptions = PreviewExpectation & {
  config: TestDbConfig;
  screenshotDir?: string;
  fetchImpl?: typeof fetch;
};

type Credential = { email: string; password: string };
type BrowserSession = { context: BrowserContext; page: Page };

export class SupabaseCreditE2eAdapter implements CreditE2eApplyAdapter {
  private readonly service: SupabaseClient;
  private readonly credentials = new Map<string, Credential>();
  private readonly sessions = new Map<string, BrowserSession>();
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

  async assertTarget(ref: string): Promise<void> {
    assertNotProduction(this.options.config);
    assertStrictTestRef(ref);
    assertStrictTestRef(this.options.config.projectRef);
    if (ref !== this.options.config.projectRef || ref !== CREDIT_E2E_TEST_REF) {
      throw new Error("Test project identity disagreement");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/debug/deployment`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Preview identity endpoint failed with HTTP ${response.status}`);
    validatePreviewIdentity(await response.json() as PreviewIdentity, this.options);
    const { error } = await this.service.from("usage_accounts").select("id").limit(0);
    if (error) throw new Error(`Test usage ledger preflight failed (${error.code ?? "unknown"})`);
  }

  async provision(input: CreditE2eRun, password: string): Promise<{ userId: string }> {
    const { data, error } = await this.service.auth.admin.createUser({
      email: input.email,
      password,
      email_confirm: true,
      app_metadata: { plan: input.plan, credit_e2e_run_id: input.runId },
    });
    if (error || !data.user?.id) throw new Error(`Could not provision ${input.plan} synthetic account`);
    this.credentials.set(data.user.id, { email: input.email, password });
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
  }

  private async accessToken(userId: string): Promise<{ token: string; session: unknown }> {
    const credential = this.credentials.get(userId);
    if (!credential) throw new Error("Synthetic credential is missing");
    const client = createClient(this.options.config.url, this.options.config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.signInWithPassword(credential);
    if (error || !data.session?.access_token) throw new Error("Synthetic account sign-in failed");
    return { token: data.session.access_token, session: data.session };
  }

  private async screenshot(input: CreditE2eRun, userId: string, round: 1 | 2, session: unknown): Promise<string | undefined> {
    if (!this.options.screenshotDir) return undefined;
    await mkdir(resolve(this.options.screenshotDir), { recursive: true });
    if (!this.browser) this.browser = await chromium.launch({ headless: true });
    let browserSession = this.sessions.get(userId);
    if (!browserSession) {
      const context = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: `sb-${this.options.config.projectRef}-auth-token`,
        value: session,
      });
      browserSession = { context, page: await context.newPage() };
      this.sessions.set(userId, browserSession);
    }
    const page = browserSession.page;
    await page.goto(`${this.baseUrl}/app/settings/billing`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    if (new URL(page.url()).pathname.startsWith("/login")) throw new Error("Preview browser session was not accepted");
    const path = resolve(this.options.screenshotDir, `round-${round}-${input.plan}-${input.scenario}-billing.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
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

    const auth = await this.accessToken(userId);
    const response = await this.fetchImpl(`${this.baseUrl}/api/billing/usage`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${auth.token}` },
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
        surface: "database",
        status: "PASS",
        detail: `${input.plan} exhausted: insufficient_capacity returned and no reservation/provider work was created`,
        json: JSON.stringify({ ok: false, reason: "insufficient_capacity" }),
      });
    }

    const screenshot = await this.screenshot(input, userId, context?.round ?? 1, auth.session);
    if (screenshot) evidence.push({ surface: "billing", status: "PASS", detail: `${input.plan} ${input.scenario}: Preview Billing/Usage captured`, screenshot });
    return evidence;
  }

  async cleanup(_runId: string, userIds: string[]): Promise<void> {
    const errors: string[] = [];
    for (const session of this.sessions.values()) await session.context.close().catch(() => undefined);
    this.sessions.clear();
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.browser = null;
    if (userIds.length > 0) {
      const { error } = await this.service.from("usage_accounts").delete().in("user_id", userIds);
      if (error) errors.push(`usage cleanup (${error.code ?? "unknown"})`);
    }
    for (const userId of userIds) {
      const { error } = await this.service.auth.admin.deleteUser(userId);
      if (error) errors.push("auth cleanup");
      this.credentials.delete(userId);
    }
    if (errors.length > 0) throw new Error(`Credit E2E cleanup failed: ${errors.join(", ")}`);
  }
}
