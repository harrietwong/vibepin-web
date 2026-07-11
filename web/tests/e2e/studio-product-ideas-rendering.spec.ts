import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  openProductPicker,
  pickerTab,
} from "./helpers/studio";

const MOCK_SIX_PRODUCTS = Array.from({ length: 6 }, (_, i) => ({
  id: `pi${i + 1}`,
  product_name: `Test Product ${i + 1}`,
  image_url: [
    "https://placehold.co/300x300/8B5CF6/white?text=Prod+1",
    "https://placehold.co/300x300/D946EF/white?text=Prod+2",
    "https://placehold.co/300x300/7C3AED/white?text=Prod+3",
    "https://placehold.co/300x300/FF4D8D/white?text=Prod+4",
    "https://placehold.co/300x300/4ADE80/white?text=Prod+5",
    "https://placehold.co/300x300/60A5FA/white?text=Prod+6",
  ][i],
  seed_keyword: "home decor",
  save_count: 100 - i * 5,
  source_pin_save_count: 80 - i * 5,
  source_url: `https://shop.example.com/product-${i + 1}`,
  domain: "shop.example.com",
  price: 29 + i,
  currency: "USD",
  merchant: "Shop",
  scraped_at: null,
  opportunity_score: 90 - i * 5,
  trend_score: null,
  save_velocity_score: null,
  item_type: "product",
}));

test.describe("Product Ideas tab rendering", () => {
  test("renders 6 product cards with proper image height after loading", async ({ page }) => {
    await prepareStudioPage(page);

    // Override the product route with 6 deterministic items (registered after
    // prepareStudioPage so this route takes precedence per Playwright ordering).
    await page.route("**/api/products/top**", async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: MOCK_SIX_PRODUCTS,
          data: MOCK_SIX_PRODUCTS,
          itemCount: MOCK_SIX_PRODUCTS.length,
          source: "product_ideas_api",
          lastUpdatedAt: new Date().toISOString(),
        }),
      });
    });

    await gotoStudio(page);
    await openProductPicker(page);
    await pickerTab(page, "product_ideas").click();

    // Skeleton disappears once data loads
    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });

    // All 6 cards visible
    const grid = page.getByTestId("product-ideas-grid");
    const cards = grid.getByTestId("asset-card");
    await expect(cards).toHaveCount(6, { timeout: 15000 });

    // Skeleton and real cards must not coexist
    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0);

    // First card image has non-zero bounding box (catches the CSS grid height-collapse bug)
    const firstCard = cards.first();
    await expect(firstCard).toBeVisible();
    const firstImg = firstCard.locator("img").first();
    await expect(firstImg).toBeVisible();
    const box = await firstImg.boundingBox();
    expect(box, "image bounding box must not be null").not.toBeNull();
    expect(box!.width, "image width must be > 100px").toBeGreaterThan(100);
    expect(box!.height, "image height must be > 100px — thin line = grid height-collapse bug").toBeGreaterThan(100);

    // Each card's image height must be close to its width (square ≈ aspect-ratio 1:1 ± 10%)
    const secondBox = await cards.nth(1).locator("img").first().boundingBox();
    expect(secondBox).not.toBeNull();
    const ratio = secondBox!.height / secondBox!.width;
    expect(ratio, `card aspect ratio ${ratio} must be near 1.0`).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  test("selecting a card increments count and enables Add Selected", async ({ page }) => {
    await prepareStudioPage(page);

    await page.route("**/api/products/top**", async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: MOCK_SIX_PRODUCTS,
          data: MOCK_SIX_PRODUCTS,
          itemCount: MOCK_SIX_PRODUCTS.length,
          source: "product_ideas_api",
          lastUpdatedAt: new Date().toISOString(),
        }),
      });
    });

    await gotoStudio(page);
    await openProductPicker(page);
    await pickerTab(page, "product_ideas").click();

    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });
    const cards = page.getByTestId("product-ideas-grid").getByTestId("asset-card");
    await expect(cards.first()).toBeVisible({ timeout: 15000 });

    // Initial state: 0 selected, Add Selected disabled
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("0 products selected");
    const addSelected = page.getByTestId("asset-picker-confirm");
    await expect(addSelected).toBeDisabled();

    // Click first card → 1 selected, Add Selected enabled
    await cards.first().click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("1 product selected");
    await expect(addSelected).toBeEnabled();

    // Click second card → 2 selected
    await cards.nth(1).click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("2 products selected");
  });

  test("empty state shows only when loaded with no items", async ({ page }) => {
    await prepareStudioPage(page);

    await page.route("**/api/products/top**", async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          data: [],
          itemCount: 0,
          source: "product_ideas_api",
          lastUpdatedAt: new Date().toISOString(),
        }),
      });
    });

    await gotoStudio(page);
    await openProductPicker(page);
    await pickerTab(page, "product_ideas").click();

    // Skeleton gone after load
    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });

    // No cards
    const cards = page.getByTestId("product-ideas-grid").getByTestId("asset-card");
    await expect(cards).toHaveCount(0);

    // Empty state message visible
    await expect(page.getByText(/No product ideas found/)).toBeVisible();
  });

  test("card shows image, title text, and Product Ideas source label", async ({ page }) => {
    await prepareStudioPage(page);

    await page.route("**/api/products/top**", async route => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [MOCK_SIX_PRODUCTS[0]],
          data: [MOCK_SIX_PRODUCTS[0]],
          itemCount: 1,
          source: "product_ideas_api",
          lastUpdatedAt: new Date().toISOString(),
        }),
      });
    });

    await gotoStudio(page);
    await openProductPicker(page);
    await pickerTab(page, "product_ideas").click();

    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });
    const card = page.getByTestId("product-ideas-grid").getByTestId("asset-card").first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // Image present
    await expect(card.locator("img").first()).toBeVisible();

    // Title shown
    await expect(card.getByText("Test Product 1")).toBeVisible();

    // Source label
    await expect(card.getByText("Product Ideas")).toBeVisible();
  });
});
