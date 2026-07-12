import { test, expect, type Page } from "@playwright/test";

/**
 * Shopify product picker E2E (WP8, §9 of the Phase 1 implementation plan).
 *
 * Covers:
 *   ① flag on → Create Pins board shows [Select product]; opens the picker on
 *     the Shopify tab (and flag off hides the entry entirely)
 *   ② mocked products list → search issues a request with the q param and filters
 *   ③ selecting a product creates a new board card whose draft has the product
 *     title and an EMPTY destinationUrl (§2: never auto-fill) — asserted via
 *     localStorage vp:pin_drafts:v1
 *   ④ not connected → picker shows the Connect guidance empty state
 *
 * All /api/integrations/shopify/** traffic is mocked with page.route. The board
 * itself (studioBoardV2) is on via NEXT_PUBLIC_STUDIO_BOARD_V2 in .env.local
 * (default is board-v2 anyway); the Shopify flag is enabled per-test through the
 * localStorage override `vp:shopify_integration` = "1" (shopifyFlag.ts step 3).
 * Auth: E2E_TEST_MODE=true bypasses the middleware (src/proxy.ts) — no login.
 *
 * Run:  npx playwright test tests/e2e/shopify-picker.spec.ts
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";
const SHOPIFY_FLAG_KEY = "vp:shopify_integration";
const DRAFTS_KEY = "vp:pin_drafts:v1";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// ── Mock payloads (shapes mirror shopifyClient.ts §6.5/§6.7) ───────────────────

const MOCK_CONNECTION = {
  id: "conn_e2e_1",
  shopDomain: "demo-store.myshopify.com",
  shopName: "Demo Store",
  primaryDomain: "demo-store.com",
  status: "connected",
  scopes: ["read_products"],
  lastFullSyncAt: new Date().toISOString(),
  uninstalledAt: null,
  disconnectedAt: null,
  updatedAt: new Date().toISOString(),
  sync: { status: "completed", syncedCount: 2, totalCount: 2, cursor: null, error: null, startedAt: null, resumable: false },
};

const MOCK_PLAN = { key: "starter", maxStores: 1, maxSyncedProducts: 100 };

const MOCK_PRODUCTS = [
  {
    id: "sp_1",
    title: "Ceramic Mug",
    handle: "ceramic-mug",
    description: "A handmade ceramic mug.",
    productUrl: "https://demo-store.com/products/ceramic-mug",
    adminUrl: "https://demo-store.myshopify.com/admin/products/1001",
    status: "active",
    availability: "in_stock",
    vendor: "Demo Store",
    productType: "Drinkware",
    tags: ["kitchen", "handmade"],
    price: { amount: 19.99, currency: "USD", compareAt: null },
    primaryImageUrl: "https://placehold.co/600x600/7C3AED/white?text=Mug",
    imageCount: 2,
    updatedAtSource: new Date().toISOString(),
    deletedAt: null,
  },
  {
    id: "sp_2",
    title: "Linen Apron",
    handle: "linen-apron",
    description: "A stonewashed linen apron.",
    productUrl: "https://demo-store.com/products/linen-apron",
    adminUrl: "https://demo-store.myshopify.com/admin/products/1002",
    status: "active",
    availability: "in_stock",
    vendor: "Demo Store",
    productType: "Apparel",
    tags: ["kitchen"],
    price: { amount: 34, currency: "USD", compareAt: null },
    primaryImageUrl: "https://placehold.co/600x600/FF4D8D/white?text=Apron",
    imageCount: 1,
    updatedAtSource: new Date().toISOString(),
    deletedAt: null,
  },
];

// ── Shared setup ───────────────────────────────────────────────────────────────

async function setupBaseMocks(page: Page, opts: { connected?: boolean } = {}) {
  const connected = opts.connected ?? true;

  await page.route("**/api/integrations/shopify/status*", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, connections: connected ? [MOCK_CONNECTION] : [], plan: MOCK_PLAN }),
    });
  });

  // List query — supports the q param the same way the real route does (title ilike).
  await page.route("**/api/integrations/shopify/products?*", async route => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const products = q ? MOCK_PRODUCTS.filter(p => p.title.toLowerCase().includes(q)) : MOCK_PRODUCTS;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products, nextCursor: null }),
    });
  });

  // Detail (row expand) — not central to these tests but kept consistent.
  await page.route("**/api/integrations/shopify/products/*", async route => {
    const id = route.request().url().split("/").pop()?.split("?")[0];
    const product = MOCK_PRODUCTS.find(p => p.id === id);
    if (!product) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found", code: "not_found" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...product,
        images: [{ id: `${product.id}_img1`, url: product.primaryImageUrl, width: 600, height: 600, altText: product.title, position: 0 }],
        stale: { deleted: false, archived: false, unavailable: false },
      }),
    });
  });

  // App-shell background traffic — keep the board quiet and deterministic.
  await page.route("**/api/pin-drafts**", async route => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: 0, skippedStale: 0 }) });
    }
  });
  await page.route("**/api/pinterest/boards**", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], bookmark: null }) });
  });
  await page.route("**/api/ai-copy/analyze", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("https://placehold.co/**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
  });
}

async function enableShopifyFlag(page: Page) {
  await page.addInitScript(([key]) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(key, "1");
  }, [SHOPIFY_FLAG_KEY]);
}

async function gotoBoard(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 20_000 });
}

async function openShopifyPicker(page: Page) {
  await page.getByTestId("board-select-product").click();
  // ProductPickerModal opens straight on the Shopify tab (initialTab="shopify").
  await expect(page.getByTestId("shopify-picker-panel")).toBeVisible({ timeout: 15_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe("Create Pins → Shopify product picker", () => {
  test.describe.configure({ timeout: 90_000 });

  // ① Entry point + Shopify tab (and flag off hides the entry).
  test("1 — flag on: Select product opens the picker on the Shopify tab", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await gotoBoard(page);

    // Header entry + empty-state secondary entry are both flag-gated.
    await expect(page.getByTestId("board-select-product")).toBeVisible();
    await expect(page.getByTestId("board-select-product-empty")).toBeVisible();

    await openShopifyPicker(page);
    // Shopify tab is the active one: its link-mode bar shows the Shopify-specific
    // "Save to My Products" checkbox (defaults OFF, 决策 5) and the tab label exists.
    await expect(page.getByRole("button", { name: "Shopify", exact: true })).toBeVisible();
    await expect(page.getByTestId("shopify-save-to-library")).toBeVisible();
    await expect(page.getByTestId("shopify-save-to-library").locator("input")).not.toBeChecked();
    // Products from the mocked store are listed.
    await expect(page.getByTestId("shopify-picker-row")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByText("Ceramic Mug")).toBeVisible();
  });

  test("2 — flag off: the Select product entry is not rendered", async ({ page }) => {
    await setupBaseMocks(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await gotoBoard(page);
    await expect(page.getByTestId("board-empty")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("board-select-product")).toHaveCount(0);
    await expect(page.getByTestId("board-select-product-empty")).toHaveCount(0);
  });

  // ② Search issues a request carrying the q param and filters the rows.
  test("3 — search filters the list via the q query param", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await gotoBoard(page);
    await openShopifyPicker(page);
    await expect(page.getByTestId("shopify-picker-row")).toHaveCount(2, { timeout: 15_000 });

    const searchRequest = page.waitForRequest(
      req => req.url().includes("/api/integrations/shopify/products") && new URL(req.url()).searchParams.get("q") === "mug",
      { timeout: 10_000 },
    );
    await page.getByTestId("shopify-picker-search").fill("mug");
    const req = await searchRequest; // 300ms debounce → then the q-carrying request fires
    expect(new URL(req.url()).searchParams.get("q")).toBe("mug");

    await expect(page.getByTestId("shopify-picker-row")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("shopify-picker-row").first()).toContainText("Ceramic Mug");

    // No-match search shows the filtered empty state.
    await page.getByTestId("shopify-picker-search").fill("zzz-no-such-product");
    await expect(page.getByTestId("shopify-picker-empty-filtered")).toBeVisible({ timeout: 10_000 });
  });

  // ③ Confirming a product creates a board card; the draft has the product title,
  //   a shopify linked product and an EMPTY destinationUrl (§2 / §3.6).
  test("4 — selecting a product creates a card with product title and empty destinationUrl", async ({ page }) => {
    await setupBaseMocks(page);
    await enableShopifyFlag(page);
    await gotoBoard(page);
    await expect(page.getByTestId("pin-board-card")).toHaveCount(0);

    await openShopifyPicker(page);
    const mugRow = page.getByTestId("shopify-picker-row").filter({ hasText: "Ceramic Mug" });
    await expect(mugRow).toBeVisible({ timeout: 15_000 });
    await mugRow.getByTestId("shopify-picker-select").click();

    // Picker closes; a new Unscheduled card appears on the board.
    await expect(page.getByTestId("shopify-picker-panel")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("Created a Pin from your product.").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(1, { timeout: 10_000 });

    // Draft assertions straight from the store (localStorage vp:pin_drafts:v1).
    const draft = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { drafts?: Record<string, unknown> };
      const drafts = Object.values(parsed.drafts ?? {});
      return (drafts[0] ?? null) as {
        title?: string;
        destinationUrl?: string;
        imageUrl?: string;
        primaryProductId?: string;
        linkedProducts?: Array<{ productId?: string; source?: string; title?: string; productUrl?: string }>;
      } | null;
    }, DRAFTS_KEY);

    expect(draft, "a draft should be persisted to vp:pin_drafts:v1").not.toBeNull();
    expect(draft!.title).toBe("Ceramic Mug");
    expect(draft!.destinationUrl).toBe(""); // never auto-filled (§2)
    expect(draft!.imageUrl).toBe("https://placehold.co/600x600/7C3AED/white?text=Mug");
    expect(draft!.primaryProductId).toBe("sp_1");
    expect(draft!.linkedProducts?.[0]?.productId).toBe("sp_1");
    expect(draft!.linkedProducts?.[0]?.source).toBe("shopify");
    expect(draft!.linkedProducts?.[0]?.productUrl).toBe("https://demo-store.com/products/ceramic-mug");
  });

  // ④ Not connected → Connect guidance empty state inside the picker.
  test("5 — not connected: picker shows the Connect guidance empty state", async ({ page }) => {
    await setupBaseMocks(page, { connected: false });
    await enableShopifyFlag(page);
    await gotoBoard(page);
    await openShopifyPicker(page);

    const emptyState = page.getByTestId("shopify-picker-disconnected");
    await expect(emptyState).toBeVisible({ timeout: 15_000 });
    await expect(emptyState).toContainText("Connect your Shopify store in Settings");
    const openSettings = page.getByTestId("shopify-picker-open-settings");
    await expect(openSettings).toBeVisible();
    await expect(openSettings).toHaveAttribute("href", "/app/settings/shopify");
    // No product rows and no search box in the disconnected state.
    await expect(page.getByTestId("shopify-picker-row")).toHaveCount(0);
    await expect(page.getByTestId("shopify-picker-search")).toHaveCount(0);
  });
});
