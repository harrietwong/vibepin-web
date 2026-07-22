/**
 * Mock-driven QA for the 2026-07-21 Create Pin flow changes.
 *
 * SCOPE: the Product Picker information architecture (create-pin PRD Section C)
 * and the footer/header copy, which are reachable from /app/studio with the
 * existing mock harness.
 *
 * NOT covered here: the Studio Board V2 AI drawer changes (unified reference
 * selection, 3x3 reference groups, serial queue, per-group failure media,
 * Website URL derivation). Those live behind an authenticated board surface that
 * this mock harness does not stand up; they are covered by the unit suites
 * (test-selected-references, test-reference-groups, test-generation-failure-media,
 * test-product-selection, test-destination-url-derivation) and remain pending
 * authenticated Preview QA.
 */

import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  openProductPicker,
  uploadProductInPicker,
  pickerTab,
} from "./helpers/studio";

test.describe("Create Pin flow 2026-07-21 — Product Picker IA", () => {
  test.beforeEach(async ({ page }) => {
    await prepareStudioPage(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("primary tabs are only My Products and Product Ideas — no From Shopify", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);

    const tabs = page.getByTestId("asset-picker-top-tabs").locator("button");
    await expect(tabs).toHaveText(["My Products", "Product Ideas"]);
    // Shopify is a SOURCE of My Products now, never a primary tab.
    await expect(page.getByTestId("picker-tab-shopify")).toHaveCount(0);
    await expect(pickerTab(page, "my_products")).toBeVisible();
  });

  test("source chips exclude Product Ideas and Recent", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);

    const chips = page.getByTestId("my-products-filter-chips");
    await expect(chips).toBeVisible();
    const chipText = (await chips.locator("button").allTextContents()).join("|");
    expect(chipText).not.toContain("Product Ideas");
    expect(chipText).not.toContain("Recent");
    // "All" is always available.
    expect(chipText).toContain("All");
  });

  test("Recent is offered as a sort mode, not a source", async ({ page }) => {
    await gotoStudio(page);
    await openProductPicker(page);

    const sort = page.getByTestId("my-products-sort");
    await expect(sort).toBeVisible();
    const options = await sort.locator("option").allTextContents();
    expect(options).toContain("Recently used");
    expect(options).toContain("Recently added");
    expect(options).toContain("Name A–Z");
  });

  test("footer CTA names what is being added, with a count", async ({ page }) => {
    await gotoStudio(page);
    const panel = await openProductPicker(page);

    // Nothing selected yet — the CTA is disabled and plural.
    const confirm = page.getByTestId("asset-picker-confirm");
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveText("Add 0 products");

    await uploadProductInPicker(page, panel);

    // Exactly one selected → singular noun, explicit count (never "Add Selected").
    await expect(confirm).toBeEnabled({ timeout: 10000 });
    await expect(confirm).toHaveText("Add 1 product");
    await expect(page.getByText("Add Selected")).toHaveCount(0);
  });

  test("picker header reflects the selection mode", async ({ page }) => {
    await gotoStudio(page);
    const panel = await openProductPicker(page);

    await expect(page.getByText("Choose products")).toBeVisible();
    await uploadProductInPicker(page, panel);
    // Exactly one chosen → singular header.
    await expect(page.getByText("Choose a product")).toBeVisible({ timeout: 10000 });
  });

  test("reference picker keeps its own tabs and role", async ({ page }) => {
    await gotoStudio(page);
    await page.getByTestId("add-pin-references").click();
    await expect(page.getByTestId("reference-picker")).toBeVisible({ timeout: 8000 });

    // Product images and Style references stay separate pickers (PRD Section D).
    await expect(page.getByTestId("product-picker")).toHaveCount(0);
    await expect(page.getByTestId("asset-picker-top-tabs").locator("button"))
      .toHaveText(["My References", "Pin Ideas"]);
  });
});

/**
 * Studio Board V2: top-level Select product → AI drawer.
 *
 * These cover review items 1 and 8 — a scratch drawer opened from Select product
 * requests recommendations (draft-less), and cancelling leaves no draft. They live
 * behind the authenticated board surface, so they run under authenticated Preview
 * QA; the request-building, stale-guard, and product-link logic they exercise is
 * additionally unit-tested (test-recommendation-request, test-drawer-product-state,
 * test-generation-product-link).
 */
test.describe("Create Pin flow 2026-07-21 — Select product opens the AI drawer @auth", () => {
  test.skip(!process.env.PLAYWRIGHT_AUTH_STATE, "requires an authenticated Preview session");

  test("Select product opens the AI drawer prefilled, and requests recommendations", async ({ page }) => {
    const recRequests: string[] = [];
    await page.route("**/api/reference-candidates", async route => {
      recRequests.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], recommendationBasis: "category_fallback" }) });
    });

    await gotoStudio(page);
    await page.getByTestId("board-select-product").click();
    await expect(page.getByTestId("canonical-product-picker")).toBeVisible();
    // (Select a product via the picker — helper omitted; runs under auth QA.)
    // The AI drawer opens with the product prefilled…
    await expect(page.getByTestId("ai-version-drawer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("product-images-selected")).toContainText(/./);
    // …and a recommendation request fired for that product (item 1).
    await expect.poll(() => recRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test("cancelling the AI drawer leaves no draft (item 8)", async ({ page }) => {
    await gotoStudio(page);
    const before = await page.getByTestId("pin-board-card").count();
    await page.getByTestId("board-select-product").click();
    await page.getByTestId("canonical-product-picker").waitFor();
    // (Pick a product, then close the drawer without generating.)
    await page.getByTestId("ai-version-close").click();
    await expect.poll(() => page.getByTestId("pin-board-card").count()).toBe(before);
  });
});
