/**
 * Safe leaf helpers shared by the live Test-Supabase account-quota adapter.
 *
 * They are intentionally data-only: no token is ever seeded, OAuth is never
 * followed, and rejection proof requires the start route to leave no state cookie.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TestDbConfig } from "./test-db-config";
import {
  buildPreviewRequestHeaders,
  validateBuildIdentity,
  validatePreviewIdentity,
  validateTestSupabaseBinding,
} from "./credit-e2e-supabase-adapter";
import {
  ACCOUNT_QUOTA_PLANS,
  ACCOUNT_QUOTA_TEST_REF,
  assertAccountQuotaTestRef,
  syntheticAccountQuotaEmail,
  type AccountQuotaApplyAdapter,
  type AccountQuotaBinding,
  type AccountQuotaCleanup,
  type AccountQuotaEvidence,
  type AccountQuotaScenario,
} from "./credit-account-quota-harness";

export type SyntheticSocialConnectionRow = {
  user_id: string;
  provider: "pinterest";
  provider_account_id: string;
  provider_account_name: string;
  provider_account_username: string;
  connection_status: "connected" | "not_connected";
  auth_provider: "official";
  metadata: { account_quota_e2e: true; run_id: string };
};

export function buildSyntheticSocialConnectionRows(
  scenario: AccountQuotaScenario,
  userId: string,
): SyntheticSocialConnectionRow[] {
  return scenario.connections.map((connection, index) => ({
    user_id: userId,
    provider: "pinterest",
    provider_account_id: connection.providerAccountId,
    provider_account_name: `Synthetic ${scenario.plan} ${index + 1}`,
    provider_account_username: `quota_${scenario.plan}_${index + 1}`,
    connection_status: connection.status === "disconnected" ? "not_connected" : "connected",
    auth_provider: "official",
    metadata: { account_quota_e2e: true, run_id: scenario.runId },
  }));
}

export function validateAtLimitConnectResponse(input: {
  status: number;
  body: { code?: unknown } | null;
  setCookie: string | null;
  rowsBefore: number;
  rowsAfter: number;
}): void {
  if (input.status !== 403) throw new Error(`Expected at-limit start HTTP 403, received ${input.status}`);
  if (input.body?.code !== "limit_reached") throw new Error("Expected at-limit start code limit_reached");
  if ((input.setCookie ?? "").toLowerCase().includes("pinterest_oauth_state")) {
    throw new Error("At-limit response must not create OAuth state");
  }
  if (input.rowsBefore !== input.rowsAfter) throw new Error("At-limit connect changed social connection row count");
}

export function validateReconnectStartResponse(input: {
  status: number;
  body: { url?: unknown; code?: unknown } | null;
  requestedReconnectId: string;
}): void {
  if (input.status === 403 && input.body?.code === "limit_reached") {
    throw new Error("Reconnect must not be blocked by account limit");
  }
  if (input.status !== 200) throw new Error(`Expected reconnect start HTTP 200, received ${input.status}`);
  const url = typeof input.body?.url === "string" ? input.body.url : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Reconnect response must return an absolute Pinterest authorize URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.pinterest.com" || !/^\/oauth\/?$/.test(parsed.pathname)) {
    throw new Error("Reconnect response must return an allowed Pinterest HTTPS authorize URL");
  }
  if (!parsed.searchParams.get("client_id")) {
    throw new Error("Reconnect Pinterest authorize URL is missing client_id");
  }
  if (!parsed.searchParams.get("state")) {
    throw new Error("Reconnect Pinterest authorize URL is missing state");
  }
  // The reconnect identity is sealed into the state cookie by the route; do not
  // attempt to derive it from the external URL and never request this URL.
  void input.requestedReconnectId;
}

export type SyntheticCleanupStep = {
  resource: string;
  // Supabase query builders are PromiseLike rather than native Promises.
  remove: () => PromiseLike<{ error: unknown | null }>;
};

/**
 * Deletes are deliberately serial: subscription -> customer -> social -> Auth.
 * A failed child delete is recorded but cannot stop later cleanup/residual checks.
 */
export async function executeSyntheticCleanupSteps(
  steps: SyntheticCleanupStep[],
): Promise<Array<{ resource: string; status: "PASS" | "FAIL"; detail: string }>> {
  const actions: Array<{ resource: string; status: "PASS" | "FAIL"; detail: string }> = [];
  for (const step of steps) {
    let lastFailure = "synthetic state delete failed";
    let deleted = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await step.remove();
        if (!result.error) {
          actions.push({ resource: step.resource, status: "PASS", detail: `synthetic state deleted after ${attempt} attempt(s)` });
          deleted = true;
          break;
        }
      } catch {
        lastFailure = "synthetic state delete threw";
      }
    }
    if (!deleted) actions.push({ resource: step.resource, status: "FAIL", detail: `${lastFailure} after 3 attempts` });
  }
  return actions;
}

type AdapterOptions = {
  config: TestDbConfig;
  baseUrl: string;
  expectedCommit: string;
  expectedDeploymentId: string;
  fetchImpl?: typeof fetch;
  serviceClientFactory?: (url: string, key: string) => SupabaseClient;
};

type Credential = { email: string; password: string };
type BillingFixture = { customerId: string; subscriptionId: string };
type SeededConnection = { id: string; status: "connected" | "not_connected" };
type DiscoveredSyntheticUser = { id: string; plan: AccountQuotaScenario["plan"] };

export function normalizeSeededConnections(rows: Array<{ id?: unknown; connection_status?: unknown }>): SeededConnection[] {
  return rows.map(row => {
    if (typeof row.id !== "string" || !row.id) throw new Error("Synthetic connection readback is missing id");
    if (row.connection_status !== "connected" && row.connection_status !== "not_connected") {
      throw new Error("Synthetic connection readback has unexpected lifecycle status");
    }
    return { id: row.id, status: row.connection_status };
  });
}

function exactHttpsOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return parsed.origin;
}

function newPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Real Test-Supabase adapter. It only calls the application’s local OAuth-start
 * route, with `redirect: "manual"`; it never follows the returned provider URL.
 */
export class SupabaseAccountQuotaAdapter implements AccountQuotaApplyAdapter {
  private readonly service: SupabaseClient;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials = new Map<string, Credential>();
  private readonly billingFixtures = new Map<string, BillingFixture>();
  private readonly seededConnections = new Map<string, SeededConnection[]>();

  constructor(private readonly options: AdapterOptions) {
    validateTestSupabaseBinding(options.config);
    this.baseUrl = exactHttpsOrigin(options.baseUrl, "Preview base URL");
    if (!/^[a-f0-9]{40}$/i.test(options.expectedCommit)) throw new Error("Expected full commit must be 40 hexadecimal characters");
    if (!/^dpl_[A-Za-z0-9]+$/.test(options.expectedDeploymentId)) throw new Error("Expected Preview deployment id is invalid");
    this.fetchImpl = options.fetchImpl ?? fetch;
    const factory = options.serviceClientFactory ?? ((url: string, key: string) => createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    }));
    this.service = factory(options.config.url, options.config.serviceRoleKey);
  }

  async assertTarget(ref: string): Promise<AccountQuotaBinding> {
    assertAccountQuotaTestRef(ref);
    const test = validateTestSupabaseBinding(this.options.config);
    if (ref !== test.projectRef || ref !== ACCOUNT_QUOTA_TEST_REF) throw new Error("Test project identity disagreement");
    const headers = { Accept: "application/json", ...buildPreviewRequestHeaders(this.baseUrl) };
    const debug = await this.fetchImpl(`${this.baseUrl}/api/debug/deployment`, { method: "GET", cache: "no-store", headers });
    if (!debug.ok) throw new Error(`Preview identity endpoint failed with HTTP ${debug.status}`);
    const identity = await debug.json() as {
      vercelEnv?: unknown; deploymentId?: unknown; host?: unknown; forwardedHost?: unknown;
      vercelUrl?: unknown; origin?: unknown; forwardedProto?: unknown;
    };
    validatePreviewIdentity(identity, this.options);
    const version = await this.fetchImpl(`${this.baseUrl}/api/version`, { method: "GET", cache: "no-store", headers });
    if (!version.ok) throw new Error(`Build identity endpoint failed with HTTP ${version.status}`);
    const build = await version.json() as { environment?: unknown; buildSha?: unknown; deploymentId?: unknown };
    validateBuildIdentity(build, this.options);
    return {
      previewOrigin: this.baseUrl,
      candidateCommit: this.options.expectedCommit,
      deploymentId: this.options.expectedDeploymentId,
      testSupabaseOrigin: test.origin,
      testSupabaseRef: test.projectRef,
      verified: true,
    };
  }

  async provision(scenario: AccountQuotaScenario): Promise<{ userId: string }> {
    const password = newPassword();
    const { data, error } = await this.service.auth.admin.createUser({
      email: scenario.email,
      password,
      email_confirm: true,
      app_metadata: {
        plan: scenario.plan,
        account_quota_e2e_synthetic: true,
        account_quota_e2e_run_id: scenario.runId,
      },
    });
    if (error || !data.user?.id) throw new Error(`Could not provision ${scenario.plan} synthetic account`);
    const userId = data.user.id;
    this.credentials.set(userId, { email: scenario.email, password });
    if (scenario.plan !== "free") {
      const now = new Date().toISOString();
      const customerId = `account-quota-e2e:${scenario.runId}:${scenario.plan}:customer`;
      const subscriptionId = `account-quota-e2e:${scenario.runId}:${scenario.plan}:subscription`;
      this.billingFixtures.set(userId, { customerId, subscriptionId });
      const { error: customerError } = await this.service.from("creem_customers").upsert({
        creem_customer_id: customerId, email: scenario.email, user_id: userId, last_event_at: now, updated_at: now,
      }, { onConflict: "creem_customer_id" });
      if (customerError) throw new Error(`Could not seed ${scenario.plan} billing customer (${customerError.code ?? "unknown"})`);
      const { error: subscriptionError } = await this.service.from("creem_subscriptions").upsert({
        creem_subscription_id: subscriptionId,
        provider: "creem",
        creem_customer_id: customerId,
        user_id: userId,
        status: "active",
        creem_product_id: `account-quota-e2e:${scenario.plan}:fixture`,
        plan: scenario.plan,
        billing_interval: "month",
        current_period_end: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
        scheduled_cancel: false,
        last_event_at: now,
        updated_at: now,
      }, { onConflict: "creem_subscription_id" });
      if (subscriptionError) throw new Error(`Could not seed ${scenario.plan} billing subscription (${subscriptionError.code ?? "unknown"})`);
    }
    return { userId };
  }

  async seedConnections(scenario: AccountQuotaScenario, userId: string): Promise<void> {
    const { error: clearError } = await this.service.from("social_connections").delete().eq("user_id", userId).eq("provider", "pinterest");
    if (clearError) throw new Error(`Could not clear ${scenario.plan} synthetic connections (${clearError.code ?? "unknown"})`);
    const rows = buildSyntheticSocialConnectionRows(scenario, userId);
    const { error: insertError } = await this.service.from("social_connections").insert(rows);
    if (insertError) throw new Error(`Could not seed ${scenario.plan} synthetic connections (${insertError.code ?? "unknown"})`);
    const { data, error } = await this.service
      .from("social_connections")
      .select("id,connection_status")
      .eq("user_id", userId)
      .eq("provider", "pinterest");
    const actual = normalizeSeededConnections((data ?? []) as Array<{ id?: unknown; connection_status?: unknown }>);
    if (error || actual.length !== scenario.limit || actual.filter(row => row.status === "not_connected").length !== 1) {
      throw new Error(`${scenario.plan} connection fixture readback mismatch`);
    }
    this.seededConnections.set(userId, actual);
  }

  private async accessToken(userId: string): Promise<string> {
    const credential = this.credentials.get(userId);
    if (!credential) throw new Error("Synthetic account credential is missing");
    const client = createClient(this.options.config.url, this.options.config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.signInWithPassword(credential);
    if (error || !data.session?.access_token) throw new Error("Synthetic account sign-in failed");
    return data.session.access_token;
  }

  private async countPinterestRows(userId: string): Promise<number> {
    const { count, error } = await this.service
      .from("social_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", "pinterest");
    if (error || typeof count !== "number") throw new Error("Could not count synthetic Pinterest rows");
    return count;
  }

  private async postStart(token: string, body: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null; setCookie: string | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/pinterest/connect`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...buildPreviewRequestHeaders(this.baseUrl),
      },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | null = null;
    try { parsed = await response.json() as Record<string, unknown>; } catch { /* non-JSON is a failed contract */ }
    return { status: response.status, body: parsed, setCookie: response.headers.get("set-cookie") };
  }

  async verifyConnectGate(scenario: AccountQuotaScenario, userId: string): Promise<AccountQuotaEvidence[]> {
    const token = await this.accessToken(userId);
    const before = await this.countPinterestRows(userId);
    const denied = await this.postStart(token, { next: "/app/settings/social" });
    const afterDenied = await this.countPinterestRows(userId);
    validateAtLimitConnectResponse({
      status: denied.status,
      body: denied.body,
      setCookie: denied.setCookie,
      rowsBefore: before,
      rowsAfter: afterDenied,
    });
    const disconnected = this.seededConnections.get(userId)?.find(row => row.status === "not_connected");
    if (!disconnected?.id) throw new Error("Synthetic disconnected connection is missing");
    const reconnect = await this.postStart(token, { next: "/app/settings/social", reconnect: disconnected.id });
    validateReconnectStartResponse({ status: reconnect.status, body: reconnect.body, requestedReconnectId: disconnected.id });
    const afterReconnectStart = await this.countPinterestRows(userId);
    if (afterReconnectStart !== before) throw new Error("Reconnect start changed social connection row count");
    return [
      { surface: "database", status: "PASS", caseId: "AQ-01", detail: `${scenario.plan}: ${before}/${scenario.limit} held Pinterest rows (one disconnected); refused add left row count unchanged` },
      { surface: "oauth", status: "PASS", caseId: "AQ-02", detail: `${scenario.plan}: full-plan start returned 403 limit_reached with no OAuth-state cookie; no provider URL was followed` },
      { surface: "http", status: "PASS", caseId: "AQ-03", detail: `${scenario.plan}: reconnect start passed the account gate and returned a local start URL only; row count stayed unchanged` },
      { surface: "ui", status: "NOT_EXECUTED", caseId: "AQ-04", detail: `${scenario.plan}: no safe reviewed UI fixture was used; direct authenticated start-route evidence is reported instead` },
    ];
  }

  private async discoverSyntheticRunUsers(runId: string): Promise<DiscoveredSyntheticUser[]> {
    const expectedEmails = new Map(ACCOUNT_QUOTA_PLANS.map(plan => [syntheticAccountQuotaEmail(plan, runId).toLowerCase(), plan]));
    const discovered: DiscoveredSyntheticUser[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const { data, error } = await this.service.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error("Run-scoped Auth discovery failed");
      const users = data?.users ?? [];
      for (const user of users) {
        const plan = expectedEmails.get((user.email ?? "").toLowerCase());
        const metadata = user.app_metadata ?? {};
        if (plan && metadata.account_quota_e2e_synthetic === true && metadata.account_quota_e2e_run_id === runId) {
          discovered.push({ id: user.id, plan });
        }
      }
      if (users.length < 1000) return discovered;
    }
    throw new Error("Run-scoped Auth discovery exceeded bounded scan");
  }

  async cleanup(runId: string, userIds: string[]): Promise<AccountQuotaCleanup> {
    const actions: AccountQuotaCleanup["actions"] = [];
    let discovered: DiscoveredSyntheticUser[] = [];
    try {
      discovered = await this.discoverSyntheticRunUsers(runId);
      actions.push({ resource: "run-scoped synthetic Auth discovery", status: "PASS", detail: "bounded discovery completed" });
    } catch {
      actions.push({ resource: "run-scoped synthetic Auth discovery", status: "FAIL", detail: "could not safely discover all temporary accounts" });
    }
    const planByUser = new Map(discovered.map(item => [item.id, item.plan] as const));
    const ids = [...new Set([...userIds, ...discovered.map(item => item.id)])];
    for (const userId of ids) {
      const plan = planByUser.get(userId);
      const fixture = this.billingFixtures.get(userId) ?? (plan && plan !== "free"
        ? {
            customerId: `account-quota-e2e:${runId}:${plan}:customer`,
            subscriptionId: `account-quota-e2e:${runId}:${plan}:subscription`,
          }
        : undefined);
      const deleteSteps: SyntheticCleanupStep[] = [];
      if (fixture) {
        deleteSteps.push(
          { resource: "synthetic billing subscription", remove: () => this.service.from("creem_subscriptions").delete().eq("creem_subscription_id", fixture.subscriptionId) },
          { resource: "synthetic billing customer", remove: () => this.service.from("creem_customers").delete().eq("creem_customer_id", fixture.customerId) },
        );
      }
      deleteSteps.push(
        { resource: "synthetic social connections", remove: () => this.service.from("social_connections").delete().eq("user_id", userId) },
        { resource: "synthetic Auth", remove: () => this.service.auth.admin.deleteUser(userId) },
      );
      actions.push(...await executeSyntheticCleanupSteps(deleteSteps));
      const { count, error } = await this.service.from("social_connections").select("id", { count: "exact", head: true }).eq("user_id", userId);
      if (error || count !== 0) actions.push({ resource: "synthetic social residual", status: "FAIL", detail: "social connection residual remains" });
      else actions.push({ resource: "synthetic social residual", status: "PASS", detail: "zero social connection residual verified" });
      const { data: authRead, error: authReadError } = await this.service.auth.admin.getUserById(userId);
      const authGone = !authRead?.user && (!authReadError || (authReadError as { status?: number }).status === 404 || /not found/i.test(authReadError.message));
      actions.push(authGone
        ? { resource: "synthetic Auth residual", status: "PASS", detail: "zero Auth residual verified" }
        : { resource: "synthetic Auth residual", status: "FAIL", detail: "synthetic Auth residual remains" });
      this.credentials.delete(userId);
      this.billingFixtures.delete(userId);
      this.seededConnections.delete(userId);
    }
    const prefix = `account-quota-e2e:${runId}:%`;
    for (const [table, field] of [["creem_customers", "creem_customer_id"], ["creem_subscriptions", "creem_subscription_id"]] as const) {
      const { count, error } = await this.service.from(table).select(field, { count: "exact", head: true }).like(field, prefix);
      actions.push(error || count !== 0
        ? { resource: `${table} run residual`, status: "FAIL", detail: "run-scoped billing residual remains" }
        : { resource: `${table} run residual`, status: "PASS", detail: "zero run-scoped billing residual verified" });
    }
    try {
      const residual = await this.discoverSyntheticRunUsers(runId);
      actions.push(residual.length === 0
        ? { resource: "run-scoped Auth residual", status: "PASS", detail: "zero run-scoped Auth residual verified" }
        : { resource: "run-scoped Auth residual", status: "FAIL", detail: "run-scoped synthetic Auth residual remains" });
    } catch {
      actions.push({ resource: "run-scoped Auth residual", status: "FAIL", detail: "could not verify run-scoped Auth cleanup" });
    }
    return { status: actions.some(action => action.status === "FAIL") ? "FAIL" : "PASS", actions };
  }
}
