import { expect, type Locator, type Page } from "@playwright/test";

export const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

export const TINY_RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const MOCK_PRODUCT_ROWS = [
  {
    id: "p1",
    product_name: "Wicker Storage Basket",
    image_url: "https://placehold.co/300x300/8B5CF6/white?text=Product+1",
    seed_keyword: "home decor",
    save_count: 100,
    source_pin_save_count: 80,
    source_url: "https://shop.example.com/basket",
    domain: "shop.example.com",
    price: 29,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 82,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p2",
    product_name: "Vanilla Bean Candle",
    image_url: "https://placehold.co/300x300/D946EF/white?text=Product+2",
    seed_keyword: "home decor",
    save_count: 90,
    source_pin_save_count: 70,
    source_url: "https://shop.example.com/candle",
    domain: "shop.example.com",
    price: 18,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 75,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p3",
    product_name: "Ceramic Floral Mug",
    image_url: "https://placehold.co/300x300/7C3AED/white?text=Product+3",
    seed_keyword: "home decor",
    save_count: 86,
    source_pin_save_count: 61,
    source_url: "https://shop.example.com/mug",
    domain: "shop.example.com",
    price: 16,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 73,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p4",
    product_name: "Olive Green Bedding Set",
    image_url: "https://placehold.co/300x300/FF4D8D/white?text=Product+4",
    seed_keyword: "home decor",
    save_count: 82,
    source_pin_save_count: 60,
    source_url: "https://shop.example.com/bedding",
    domain: "shop.example.com",
    price: 72,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 70,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p5",
    product_name: "Minimalist Line Art Print",
    image_url: "https://placehold.co/300x300/4ADE80/white?text=Product+5",
    seed_keyword: "home decor",
    save_count: 78,
    source_pin_save_count: 55,
    source_url: "https://shop.example.com/print",
    domain: "shop.example.com",
    price: 24,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 68,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p6",
    product_name: "Wavy Edge Mirror",
    image_url: "https://placehold.co/300x300/60A5FA/white?text=Product+6",
    seed_keyword: "home decor",
    save_count: 74,
    source_pin_save_count: 52,
    source_url: "https://shop.example.com/mirror",
    domain: "shop.example.com",
    price: 49,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 66,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
];

export const MOCK_PIN_ROWS = [
  { id: "r1", image_url: "https://placehold.co/300x450/7C3AED/white?text=Pin+1", save_count: 1200, source_keyword: "home decor" },
  { id: "r2", image_url: "https://placehold.co/300x450/FF4D8D/white?text=Pin+2", save_count: 900, source_keyword: "fashion" },
];

export const DEFAULT_GENERATED_URLS = [
  "https://placehold.co/400x600/FF4D8D/white?text=Pin+1",
  "https://placehold.co/400x600/7C3AED/white?text=Pin+2",
];

export type StudioMockOptions = {
  generateMode?: "success" | "fail";
  generateUrls?: string[];
  /** Clear localStorage/sessionStorage on each navigation (default true). */
  clearStorage?: boolean;
};

async function pickerSelectedCount(page: Page): Promise<number> {
  const text = await page.getByTestId("asset-picker-selected-count").textContent() ?? "";
  const match = text.match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function setupStudioMocks(page: Page, opts: StudioMockOptions = {}) {
  const { generateMode = "success", generateUrls = DEFAULT_GENERATED_URLS } = opts;
  const lastUpdatedAt = new Date().toISOString();

  await page.route("**/api/products/top**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: MOCK_PRODUCT_ROWS,
        data: MOCK_PRODUCT_ROWS,
        itemCount: MOCK_PRODUCT_ROWS.length,
        source: "product_ideas_api",
        lastUpdatedAt,
      }),
    });
  });

  await page.route("**/api/viral-pins**", async route => {
    const pinItems = MOCK_PIN_ROWS.map(r => ({
      ...r,
      title: r.source_keyword,
      category: r.source_keyword?.includes("fashion") ? "fashion" : "home-decor",
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: pinItems,
        data: pinItems,
        itemCount: pinItems.length,
        source: "pin_ideas_api",
        lastUpdatedAt,
        count: MOCK_PIN_ROWS.length,
        limit: 160,
        offset: 0,
      }),
    });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/trend_keywords*`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ keyword: "home decor", category: "home-decor" }]),
    });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/keyword_expansions*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/pin_products*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PRODUCT_ROWS) });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/pin_samples*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PIN_ROWS) });
  });

  await page.route("**/api/generate", async route => {
    if (generateMode === "fail") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Model timeout" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, urls: generateUrls }),
    });
  });

  await page.route("**/api/history-storage", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
  });

  await page.route("**/api/storage-image**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });

  await page.route("https://placehold.co/**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });
}

export async function prepareStudioPage(page: Page, opts: StudioMockOptions = {}) {
  const { clearStorage = true, ...mockOpts } = opts;
  await setupStudioMocks(page, mockOpts);
  if (clearStorage) {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  }
}

export async function gotoStudio(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("composer-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("generate-btn")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("generation-feed")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("add-product-images")).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId("studio-interactive")).toBeAttached({ timeout: 20_000 });
}

export async function openProductPicker(page: Page): Promise<Locator> {
  const btn = page.getByTestId("add-product-images");
  await btn.scrollIntoViewIfNeeded();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);

  const panel = page.getByTestId("product-picker");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("picker-tab-my_products")).toBeVisible();
  await expect(page.getByTestId("compact-upload-product")).toBeVisible({ timeout: 10000 });
  return panel;
}

export async function openReferencePicker(page: Page): Promise<Locator> {
  const btn = page.getByTestId("add-pin-references");
  await btn.scrollIntoViewIfNeeded();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);

  const panel = page.getByTestId("reference-picker");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("picker-tab-my_references")).toBeVisible();
  return panel;
}

export async function uploadProductInPicker(page: Page, panel?: Locator, buffer: Buffer = TINY_RED_PNG) {
  const picker = panel ?? page.getByTestId("product-picker");
  const before = await pickerSelectedCount(page);
  const fileInput = picker.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1, { timeout: 10000 });
  await fileInput.setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer,
  });
  await expect.poll(async () => pickerSelectedCount(page), { timeout: 10000 }).toBe(before + 1);
}

export async function confirmAssetPicker(page: Page) {
  const confirm = page.getByTestId("asset-picker-confirm");
  await expect(confirm).toBeEnabled({ timeout: 10000 });
  await confirm.click();
}

export async function uploadReferenceInPicker(page: Page, panel?: Locator, buffer: Buffer = TINY_RED_PNG) {
  const picker = panel ?? page.getByTestId("reference-picker");
  const before = await pickerSelectedCount(page);
  const fileInput = picker.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1, { timeout: 10000 });
  await fileInput.setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer,
  });
  await expect.poll(async () => pickerSelectedCount(page), { timeout: 10000 }).toBe(before + 1);
}

export async function addProductViaUpload(page: Page) {
  const panel = await openProductPicker(page);
  await uploadProductInPicker(page, panel);
  await confirmAssetPicker(page);
  await expect(page.getByTestId("product-picker")).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByTestId("generation-feed")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("products-asset-section-count")).toHaveText("(1)", { timeout: 10000 });
}

export async function addReferenceViaUpload(page: Page, buffer: Buffer = TINY_RED_PNG) {
  const panel = await openReferencePicker(page);
  await uploadReferenceInPicker(page, panel, buffer);
  await confirmAssetPicker(page);
  await expect(page.getByTestId("reference-picker")).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByTestId("generation-feed")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("refs-asset-section-count")).toHaveText("(1)", { timeout: 10000 });
}

export async function generatePins(
  page: Page,
  prompt: string,
  opts: StudioMockOptions = {},
) {
  await prepareStudioPage(page, opts);
  await gotoStudio(page);
  await addProductViaUpload(page);
  await page.getByTestId("prompt-textarea").fill(prompt);
  await page.getByTestId("generate-btn").click();
}

export async function expectGeneratedPins(page: Page, min = 1) {
  const cards = page.getByTestId("generated-pin-card");
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => cards.count(), { timeout: 10000 }).toBeGreaterThanOrEqual(min);
}

export async function expectFailedPlaceholder(page: Page) {
  await page.getByTestId("feed-tab-failed").click();
  await expect(page.getByTestId("placeholder-card").first()).toBeVisible({ timeout: 30000 });
}

export function pickerTab(page: Page, tabId: "my_products" | "product_ideas" | "my_references" | "pin_ideas") {
  return page.getByTestId(`picker-tab-${tabId}`);
}

export async function waitForProductIdeasGrid(page: Page) {
  await pickerTab(page, "product_ideas").click();
  await expect(page.getByTestId("product-ideas-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });
  const cards = page.getByTestId("product-ideas-grid").getByTestId("asset-card");
  await expect(cards.first()).toBeVisible({ timeout: 15000 });
  return cards;
}

export async function waitForPinIdeasGrid(page: Page) {
  await pickerTab(page, "pin_ideas").click();
  await expect(page.getByTestId("pin-ideas-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pin-ideas-grid").getByTestId("asset-card").first()).toBeVisible({ timeout: 15000 });
  return page.getByTestId("pin-ideas-grid").getByTestId("asset-card");
}
