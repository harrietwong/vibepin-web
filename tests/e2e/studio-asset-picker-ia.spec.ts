import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  openProductPicker,
  openReferencePicker,
  confirmAssetPicker,
  pickerTab,
  waitForProductIdeasGrid,
  waitForPinIdeasGrid,
} from "./helpers/studio";

test.describe("Create Pins asset picker information architecture", () => {
  test.beforeEach(async ({ page }) => {
    await prepareStudioPage(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("Product Images picker uses right panel with only My Products and Product Ideas", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);

    await expect(page.getByTestId("composer-panel")).toBeVisible();
    await expect(page.getByText("Choose Product Images")).toBeVisible();
    await expect(page.getByTestId("asset-picker-top-tabs").locator("button")).toHaveText(["My Products", "Product Ideas"]);
    await expect(page.getByTestId("picker-tab-my_products")).toHaveText("My Products");
    await expect(page.getByTestId("picker-tab-product_ideas")).toHaveText("Product Ideas");
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("Upload")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("URL Import")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("More sources")).toHaveCount(0);
    await expect(page.getByTestId("compact-upload-product")).toBeVisible();
    await expect(page.getByTestId("compact-import-url")).toBeVisible();

    const cards = await waitForProductIdeasGrid(page);
    await expect(cards).toHaveCount(6, { timeout: 10000 });
    await expect(page.getByTestId("product-ideas-category-sidebar")).toBeVisible();
  });

  test("Product Ideas renders real image-first cards instead of skeleton rows", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);
    const cards = await waitForProductIdeasGrid(page);

    await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0);
    await expect(cards).toHaveCount(6, { timeout: 10000 });

    const firstCard = cards.first();
    const firstImageWrap = firstCard.getByTestId("asset-card-image-wrap");
    const firstImage = firstCard.getByTestId("asset-card-image");
    await expect(firstCard).toBeVisible();
    await expect(firstCard.getByText("Product Ideas")).toBeVisible();

    const cardBox = await firstCard.boundingBox();
    const imageBox = await firstImageWrap.boundingBox();
    expect(cardBox?.height ?? 0, "asset-card height should not collapse into skeleton rows").toBeGreaterThan(180);
    expect(imageBox?.height ?? 0, "asset-card image area should have a real square height").toBeGreaterThan(100);

    const imageMetrics = await firstImage.evaluate(img => {
      const el = img as HTMLImageElement;
      const styles = window.getComputedStyle(el);
      return {
        complete: el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        opacity: styles.opacity,
        visibility: styles.visibility,
        display: styles.display,
      };
    });
    expect(imageMetrics.complete).toBe(true);
    expect(imageMetrics.naturalWidth).toBeGreaterThan(0);
    expect(imageMetrics.naturalHeight).toBeGreaterThan(0);
    expect(imageMetrics.opacity).toBe("1");
    expect(imageMetrics.visibility).toBe("visible");
    expect(imageMetrics.display).toBe("block");

    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("0 products selected");
    await firstCard.click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("1 product selected");
    await expect(page.getByTestId("asset-picker-confirm")).toBeEnabled();
  });

  test("Product Ideas selection updates footer count, commits to composer, and saves to My Products", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);
    const cards = await waitForProductIdeasGrid(page);

    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("0 products selected");
    await cards.first().click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("1 product selected");

    await confirmAssetPicker(page);
    await expect(page.getByTestId("product-picker")).toHaveCount(0);
    await expect(page.getByTestId("generation-feed")).toBeVisible();
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(1)");
    await expect(page.getByTestId("selected-products").locator("img")).toHaveCount(1);

    await openProductPicker(page);
    await pickerTab(page, "my_products").click();
    await expect(page.getByTestId("my-products-grid").getByTestId("asset-card")).toHaveCount(1, { timeout: 15000 });
  });

  test("Pin References picker uses right panel with only My References and Pin Ideas", async ({ page }) => {
    await gotoStudio(page);
    await openReferencePicker(page);

    await expect(page.getByTestId("composer-panel")).toBeVisible();
    await expect(page.getByText("Choose Pin References")).toBeVisible();
    await expect(page.getByTestId("asset-picker-top-tabs").locator("button")).toHaveText(["My References", "Pin Ideas"]);
    await expect(page.getByTestId("picker-tab-my_references")).toHaveText("My References");
    await expect(page.getByTestId("picker-tab-pin_ideas")).toHaveText("Pin Ideas");
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("Upload")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("URL Import")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-top-tabs").getByText("More sources")).toHaveCount(0);
    await expect(page.getByTestId("reference-picker").getByText("Viral Pins")).toHaveCount(0);
    await expect(page.getByTestId("reference-picker").getByText("Saved from Viral Pins")).toHaveCount(0);
    await expect(page.getByTestId("compact-upload-reference")).toBeVisible();
    await expect(page.getByTestId("compact-import-url")).toBeVisible();
    await expect(page.getByTestId("asset-section-recent")).toBeVisible();
    await expect(page.getByTestId("asset-section-saved-from-pin-ideas")).toBeVisible();
    await expect(page.getByTestId("asset-section-uploaded-references")).toBeVisible();
    await expect(page.getByTestId("asset-section-url-imported")).toBeVisible();

    const cards = await waitForPinIdeasGrid(page);
    await expect(page.getByTestId("pin-ideas-filters")).toBeVisible();
    await expect(page.getByTestId("search-pin-ideas")).toBeVisible();
    await expect(page.getByTestId("pin-ideas-category-filter")).toHaveValue("All categories");
    await expect(page.getByTestId("pin-ideas-format-filter")).toHaveValue("All formats");
    await expect(cards).toHaveCount(2, { timeout: 8000 });
    await expect(page.getByTestId("viral-pins-category-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("pin-ideas-grid").getByText("Pin Ideas").first()).toBeVisible();
    await expect(page.getByText("Browse Pin references for style, layout, mood, and composition.")).toBeVisible();

    const filtersBox = await page.getByTestId("pin-ideas-filters").boundingBox();
    const gridBox = await page.getByTestId("pin-ideas-grid").boundingBox();
    expect(filtersBox?.y ?? 0, "Pin Ideas filters should be above the grid").toBeLessThan(gridBox?.y ?? 0);
  });

  test("Pin Ideas selection updates footer count and Add Selected updates composer references", async ({ page }) => {
    await gotoStudio(page);
    await openReferencePicker(page);
    await pickerTab(page, "pin_ideas").click();

    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("0 references selected");

    const cards = await waitForPinIdeasGrid(page);
    await cards.first().click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("1 reference selected");

    await cards.nth(1).click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("2 references selected");

    await confirmAssetPicker(page);
    await expect(page.getByTestId("reference-picker")).toHaveCount(0);
    await expect(page.getByTestId("refs-asset-section-count")).toHaveText("(2)");
    await expect(page.getByTestId("selected-refs").locator("img")).toHaveCount(2);
  });

  test("Cancel clears draft selection and returns to feed", async ({ page }) => {
    await gotoStudio(page);
    await openReferencePicker(page);
    const cards = await waitForPinIdeasGrid(page);
    await cards.first().click();
    await expect(page.getByTestId("asset-picker-selected-count")).toHaveText("1 reference selected");

    await page.getByTestId("asset-picker-cancel").click();
    await expect(page.getByTestId("reference-picker")).toHaveCount(0);
    await expect(page.getByTestId("generation-feed")).toBeVisible();
    await expect(page.getByTestId("refs-asset-section-count")).toHaveText("(0)");
  });
});
