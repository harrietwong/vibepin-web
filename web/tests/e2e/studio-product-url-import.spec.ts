import { test, expect, type Page } from "@playwright/test";

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

const MOCK_IMPORT_RESPONSE = {
  results: [
    {
      sourceUrl:    "https://shop.example.com/products/basket",
      sourceDomain: "shop.example.com",
      status:       "success",
      title:        "Wicker Storage Basket",
      candidates:   [
        {
          id:       "jsonld-0-basket",
          imageUrl: "https://placehold.co/600x600/8B5CF6/white?text=Basket+1",
          width:    600,
          height:   600,
          score:    0.95,
          reason:   "jsonld_product_image",
        },
        {
          id:       "og-1-basket2",
          imageUrl: "https://placehold.co/600x600/D946EF/white?text=Basket+2",
          width:    600,
          height:   600,
          score:    0.85,
          reason:   "og_image",
        },
      ],
    },
    {
      sourceUrl:    "https://shop.example.com/products/candle",
      sourceDomain: "shop.example.com",
      status:       "success",
      title:        "Vanilla Bean Candle",
      candidates:   [
        {
          id:       "og-0-candle",
          imageUrl: "https://placehold.co/600x600/7C3AED/white?text=Candle",
          width:    600,
          height:   600,
          score:    0.88,
          reason:   "og_image",
        },
      ],
    },
  ],
};

async function setupMocks(page: Page) {
  await page.route("**/api/import/product-urls", async route => {
    await route.fulfill({
      status:       200,
      contentType:  "application/json",
      body:         JSON.stringify(MOCK_IMPORT_RESPONSE),
    });
  });
  await page.route("**/api/products/top**", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/generate", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, urls: [] }) });
  });
  await page.route("**/api/history-storage", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
  });
}

async function gotoStudio(page: Page) {
  await setupMocks(page);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/app/studio", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("studio-interactive")).toBeAttached({ timeout: 15000 });
  await expect(page.getByTestId("generate-btn")).toBeVisible({ timeout: 15000 });
}

test.describe("Create Pins multi-URL product import", () => {
  test("imports reviewed URL candidates into My Products and composer selection", async ({ page }) => {
    await gotoStudio(page);

    await page.getByTestId("add-product-images").click();
    await expect(page.getByTestId("product-picker")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("picker-tab-my_products")).toBeVisible();

    await page.getByTestId("compact-import-url").click();
    await expect(page.getByTestId("product-url-import-panel")).toBeVisible();

    await page.getByTestId("url-import-textarea").fill(
      "https://shop.example.com/products/basket\nhttps://shop.example.com/products/candle",
    );
    await page.getByTestId("url-import-extract").click();

    await expect(page.getByTestId("url-import-result-group")).toHaveCount(2, { timeout: 10000 });
    await expect(page.getByTestId("url-import-candidate")).toHaveCount(3);

    await expect(page.getByTestId("url-import-selected-count")).toHaveText("2 images selected");

    await page.getByTestId("url-import-save").click();
    await expect(page.getByTestId("product-url-import-panel")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("2 products selected");

    await page.getByTestId("asset-picker-confirm").click();
    await expect(page.getByTestId("product-picker")).toHaveCount(0);
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(2)");
    await expect(page.getByTestId("selected-products").locator("img")).toHaveCount(2);

    await page.getByTestId("add-product-images").click();
    await expect(page.getByTestId("product-picker")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("my-products-grid").getByTestId("asset-card")).toHaveCount(2, { timeout: 15000 });
  });
});
