import { test, expect, type Page } from "@playwright/test";

/**
 * Create Pins initial-state UI — compact composer + generation feed fallback.
 * Run: pnpm test:e2e studio-initial-state.spec.ts
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

async function setupMocks(page: Page) {
  // Return empty arrays for all Supabase table reads so the picker can render cleanly.
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(`${SUPABASE_URL}/auth/**`, async (route) => { await route.continue(); });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, urls: [] }) });
  });
  await page.route("**/api/history-storage", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
  });
  await page.route("**/api/storage-image**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("") });
  });
}

async function gotoStudio(page: Page) {
  await setupMocks(page);
  await page.goto("/app/studio", { waitUntil: "domcontentloaded" });
  const url = page.url();
  expect(url, "Redirected to login — set E2E_TEST_MODE=true in .env.local and restart dev server")
    .not.toContain("/login");
  await page.waitForSelector('[data-testid="studio-interactive"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="generate-btn"]', { timeout: 15000 });
}

test.describe("Create Pins initial state", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("loads without React error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await gotoStudio(page);
    const reactErrors = errors.filter(e =>
      e.includes("React") || e.includes("Uncaught") || e.includes("Cannot read"),
    );
    expect(reactErrors).toHaveLength(0);
  });

  test("sidebar width is <= 88px", async ({ page }) => {
    await gotoStudio(page);
    const box = await page.getByTestId("app-sidebar").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(88);
  });

  test("page text is English on initial load", async ({ page }) => {
    await gotoStudio(page);
    // Use the testid on the page header <p> to avoid matching the sidebar nav label.
    await expect(page.getByTestId("page-header-title")).toBeVisible();
    await expect(page.getByTestId("page-header-title")).toHaveText("Create Pins");
    await expect(page.getByText("Products").first()).toBeVisible();
    await expect(page.getByText("References").first()).toBeVisible();
    await expect(page.getByText("Your generated Pins will appear here")).toBeVisible();
    await expect(page.getByText("图片")).toHaveCount(0);
    await expect(page.getByText("上传")).toHaveCount(0);
  });

  test("compact product and reference entry buttons", async ({ page }) => {
    await gotoStudio(page);
    await expect(page.getByTestId("add-product-images")).toBeVisible();
    await expect(page.getByTestId("add-pin-references")).toBeVisible();
    await expect(page.getByTestId("add-product-images")).toContainText("Add product images");
    await expect(page.getByTestId("add-pin-references")).toContainText("Add pin references");
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(0)");
    await expect(page.getByTestId("refs-asset-section-count")).toHaveText("(0)");
  });

  test("no large dropzone or separate Upload/Browse buttons on default page", async ({ page }) => {
    await gotoStudio(page);
    await expect(page.getByText("Click or drag images here")).toHaveCount(0);
    // These buttons only exist inside the picker modal — not on the default page.
    await expect(page.locator('[data-testid="file-input-product"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="file-input-style_reference"]')).toHaveCount(0);
  });

  test("clicking Add product images opens Product Images picker", async ({ page }) => {
    await gotoStudio(page);
    await page.getByTestId("add-product-images").click();
    await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);
    await expect(page.getByTestId("product-picker")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Choose Product Images")).toBeVisible();
    await expect(page.getByTestId("composer-panel")).toBeVisible();
    await expect(page.getByTestId("picker-tab-my_products")).toHaveText("My Products");
    await expect(page.getByTestId("picker-tab-product_ideas")).toHaveText("Product Ideas");
    await expect(page.getByTestId("compact-upload-product")).toBeVisible();
    await expect(page.getByTestId("compact-import-url")).toBeVisible();
  });

  test("clicking Add pin references opens Pin References picker", async ({ page }) => {
    await gotoStudio(page);
    await page.getByTestId("add-pin-references").click();
    await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);
    await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Choose Pin References")).toBeVisible();
    await expect(page.getByTestId("composer-panel")).toBeVisible();
    await expect(page.getByTestId("picker-tab-my_references")).toHaveText("My References");
    await expect(page.getByTestId("picker-tab-pin_ideas")).toHaveText("Pin Ideas");
    await expect(page.getByTestId("compact-upload-reference")).toBeVisible();
    await expect(page.getByTestId("compact-import-url")).toBeVisible();
  });

  test("generation feed shows empty fallback without history cards", async ({ page }) => {
    await gotoStudio(page);
    await expect(page.getByTestId("generation-feed-empty")).toBeVisible();
    await expect(page.getByTestId("generated-pin-card")).toHaveCount(0);
    await expect(page.getByTestId("how-it-works-btn")).toBeVisible();
  });

  test("generation feed shows filter tabs", async ({ page }) => {
    await gotoStudio(page);
    for (const tab of ["all", "generating", "completed", "failed", "added"]) {
      await expect(page.getByTestId(`feed-tab-${tab}`)).toBeVisible();
    }
  });
});
