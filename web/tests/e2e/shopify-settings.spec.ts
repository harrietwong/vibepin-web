import { test, expect, type Page } from "@playwright/test";

/**
 * Shopify Settings tab E2E (WP8, §9 of the Phase 1 implementation plan).
 *
 * Covers:
 *   ① flag off → no Shopify tab in the settings sidebar
 *   ② flag on + not connected (mocked status) → connect form + invalid-domain feedback
 *   ③ mocked connected → shop name / status / Sync now visible
 *   ④ mocked sync loop (running → completed) → progress copy changes
 *   ⑤ mocked limit_reached → "Synced X of Y" banner + upgrade link
 *   ⑥ ?shopify=connected OAuth return → success notice, query param consumed
 *
 * All /api/integrations/shopify/** traffic is mocked with page.route (same
 * pattern as the other specs in this directory) — no real store, no real DB.
 * Auth: E2E_TEST_MODE=true in .env.local bypasses the auth middleware
 * (see src/proxy.ts), so no login/storage state is needed.
 *
 * The Shopify UI flag (NEXT_PUBLIC_SHOPIFY_INTEGRATION, default off) is turned
 * on per-test via the localStorage override `vp:shopify_integration` = "1"
 * (shopifyFlag.ts resolution step 3 — works because the env var is unset).
 *
 * Run:  npx playwright test tests/e2e/shopify-settings.spec.ts
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";
const SHOPIFY_FLAG_KEY = "vp:shopify_integration";

// ── Mock payload builders (shapes mirror shopifyClient.ts types / §6.5) ───────

type MockSync = {
  status: "idle" | "running" | "completed" | "limit_reached" | "error";
  syncedCount: number;
  totalCount: number | null;
  cursor: string | null;
  error: string | null;
  startedAt: string | null;
  resumable: boolean;
};

function mockSync(overrides: Partial<MockSync> = {}): MockSync {
  return {
    status: "idle",
    syncedCount: 0,
    totalCount: null,
    cursor: null,
    error: null,
    startedAt: null,
    resumable: false,
    ...overrides,
  };
}

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_e2e_1",
    shopDomain: "demo-store.myshopify.com",
    shopName: "Demo Store",
    primaryDomain: "demo-store.com",
    status: "connected",
    scopes: ["read_products"],
    lastFullSyncAt: new Date(Date.now() - 3600_000).toISOString(),
    uninstalledAt: null,
    disconnectedAt: null,
    updatedAt: new Date().toISOString(),
    sync: mockSync(),
    ...overrides,
  };
}

function statusBody(connections: unknown[], plan?: Record<string, unknown>) {
  return JSON.stringify({
    configured: true,
    connections,
    plan: plan ?? { key: "starter", maxStores: 1, maxSyncedProducts: 100 },
  });
}

// ── Shared page setup ──────────────────────────────────────────────────────────

/** Mock app-shell background traffic so unrelated requests never slow/poison tests. */
async function setupBaseMocks(page: Page) {
  await page.route("**/api/pin-drafts**", async route => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: 0, skippedStale: 0 }) });
    }
  });
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

/** Turn the Shopify UI flag on (localStorage override; env var is unset locally). */
async function enableShopifyFlag(page: Page) {
  await page.addInitScript(([key]) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(key, "1");
  }, [SHOPIFY_FLAG_KEY]);
}

async function gotoShopifySettings(page: Page, query = "") {
  await page.goto(`/app/settings/shopify${query}`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe("Settings → Shopify tab", () => {
  test.describe.configure({ timeout: 90_000 });

  // ① Flag off → the sidebar has no Shopify tab (flag-off UI must be pixel-identical to today).
  test("1 — flag off: settings sidebar has no Shopify tab", async ({ page }) => {
    await setupBaseMocks(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto("/app/settings", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 20_000 });
    // Sidebar is rendered (other tabs present) but Shopify is filtered out.
    await expect(page.getByTestId("settings-tab-account")).toBeVisible();
    await expect(page.getByTestId("settings-tab-pinterest")).toBeVisible();
    await expect(page.getByTestId("settings-tab-shopify")).toHaveCount(0);
  });

  // ② Flag on + status says not connected → connect form; invalid domain gets feedback.
  test("2 — flag on, not connected: connect form with domain validation feedback", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await page.route("**/api/integrations/shopify/status*", async route => {
      await route.fulfill({ status: 200, contentType: "application/json", body: statusBody([]) });
    });
    const connectCalls: string[] = [];
    await page.route("**/api/integrations/shopify/connect*", async route => {
      const body = route.request().postDataJSON() as { shopDomain?: string };
      connectCalls.push(body?.shopDomain ?? "");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Enter a valid *.myshopify.com store domain", code: "invalid_shop_domain" }),
      });
    });

    await gotoShopifySettings(page);
    await expect(page.getByTestId("settings-tab-shopify")).toBeVisible();
    await expect(page.getByTestId("shopify-state-not-connected")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("shopify-shop-domain-input")).toBeVisible();
    await expect(page.getByTestId("shopify-connect")).toBeVisible();

    // Empty input → client-side validation feedback, no request issued.
    await page.getByTestId("shopify-connect").click();
    await expect(page.getByText("Enter your Shopify store domain").first()).toBeVisible({ timeout: 10_000 });
    expect(connectCalls).toHaveLength(0);

    // Invalid domain → server 400 invalid_shop_domain surfaces as an error toast.
    await page.getByTestId("shopify-shop-domain-input").fill("not-a-real-shopify-domain");
    await page.getByTestId("shopify-connect").click();
    await expect(page.getByText("Enter a valid *.myshopify.com store domain").first()).toBeVisible({ timeout: 10_000 });
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]).toBe("not-a-real-shopify-domain");
  });

  // ③ Mocked connected → shop name / connected status / Sync now visible.
  test("3 — connected: shop name, status dot and Sync now are visible", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await page.route("**/api/integrations/shopify/status*", async route => {
      await route.fulfill({ status: 200, contentType: "application/json", body: statusBody([mockConnection()]) });
    });

    await gotoShopifySettings(page);
    await expect(page.getByTestId("shopify-state-connected")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Demo Store")).toBeVisible();
    await expect(page.getByText("demo-store.myshopify.com")).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Read products")).toBeVisible();
    await expect(page.getByTestId("shopify-sync-now")).toBeVisible();
    await expect(page.getByTestId("shopify-sync-now")).toBeEnabled();
    await expect(page.getByTestId("shopify-disconnect")).toBeVisible();
  });

  // ④ Sync loop: status=running (resumable) → Resume → chunk(running 80/120) → chunk(completed).
  test("4 — sync running → completed: progress copy changes and completion toast shows", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);

    let phase: "running" | "completed" = "running";
    await page.route("**/api/integrations/shopify/status*", async route => {
      const conn = phase === "running"
        ? mockConnection({
            sync: mockSync({ status: "running", syncedCount: 40, totalCount: 120, cursor: "c40", startedAt: new Date().toISOString(), resumable: true }),
          })
        : mockConnection({
            lastFullSyncAt: new Date().toISOString(),
            sync: mockSync({ status: "completed", syncedCount: 120, totalCount: 120 }),
          });
      await route.fulfill({ status: 200, contentType: "application/json", body: statusBody([conn]) });
    });

    let syncCalls = 0;
    await page.route("**/api/integrations/shopify/sync*", async route => {
      syncCalls++;
      if (syncCalls === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ state: "running", hasMore: true, syncedCount: 80, totalCount: 120, cursor: "c80" }),
        });
        return;
      }
      // Hold the terminal chunk briefly so the intermediate progress copy is observable.
      await new Promise(resolve => setTimeout(resolve, 800));
      phase = "completed";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: "completed", hasMore: false, syncedCount: 120, totalCount: 120 }),
      });
    });

    await gotoShopifySettings(page);
    // Interrupted run → progress copy from the persisted sync state + Resume button.
    await expect(page.getByTestId("shopify-sync-progress")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("shopify-sync-progress")).toContainText("Synced 40 of 120");
    await expect(page.getByTestId("shopify-resume-sync")).toBeVisible();

    await page.getByTestId("shopify-resume-sync").click();
    // First chunk lands → progress copy advances.
    await expect(page.getByTestId("shopify-sync-progress")).toContainText("Synced 80 of 120", { timeout: 10_000 });
    // Terminal chunk → completion toast, progress gone, Sync now back.
    await expect(page.getByText("Shopify sync complete").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("shopify-sync-progress")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("shopify-sync-now")).toBeVisible();
    expect(syncCalls).toBe(2);
  });

  // ⑤ limit_reached → "Synced X of Y" banner + upgrade link (决策 3: never silently truncate).
  test("5 — limit_reached: Synced X of Y banner with upgrade link", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await page.route("**/api/integrations/shopify/status*", async route => {
      const conn = mockConnection({
        lastFullSyncAt: new Date().toISOString(),
        sync: mockSync({ status: "limit_reached", syncedCount: 100, totalCount: 342 }),
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: statusBody([conn]) });
    });

    await gotoShopifySettings(page);
    const banner = page.getByTestId("shopify-limit-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("Synced 100 of 342 products");
    const upgrade = banner.getByRole("link", { name: /Upgrade to sync more/ });
    await expect(upgrade).toBeVisible();
    await expect(upgrade).toHaveAttribute("href", "/pricing");
  });

  // ⑥ OAuth return: ?shopify=connected → success notice; query param consumed (router.replace).
  test("6 — ?shopify=connected return shows the success notice and clears the query", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await page.route("**/api/integrations/shopify/status*", async route => {
      await route.fulfill({ status: 200, contentType: "application/json", body: statusBody([mockConnection()]) });
    });
    // The connected return auto-kicks one sync (§3.1) — resolve it immediately.
    await page.route("**/api/integrations/shopify/sync*", async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ state: "completed", hasMore: false, syncedCount: 2, totalCount: 2 }),
      });
    });

    await gotoShopifySettings(page, "?shopify=connected");
    const notice = page.getByTestId("shopify-oauth-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("Shopify store connected");
    // The query param is consumed so a refresh never re-fires the toast.
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("shopify=connected");
  });
});
