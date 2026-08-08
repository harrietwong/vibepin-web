/**
 * Browser QA for the 2026-07-21 Create Pin flow changes.
 *
 * AUTH MODEL: this runs on the ANONYMOUS default project and reaches /app/** via
 * E2E_TEST_MODE=true (the proxy no-op), NOT via a real signed-in storageState. It is
 * therefore deliberately NOT named *.auth.spec.ts — that suffix is reserved for specs
 * that consume a genuine authenticated session (see playwright.config.ts). The line-20
 * `not.toHaveURL(/login/)` assertion just confirms the test-mode gate let us in.
 *
 * SURFACE: Studio Board V2 (`data-testid="studio-board"`), which is the DEFAULT
 * Create Pins experience — see lib/studioBoardFlag.ts. An earlier version of this
 * file reused helpers/studio.ts `gotoStudio()`, which waits for the LEGACY composer
 * (composer-panel / generate-btn / generation-feed). Those ids do not exist on Board
 * V2, so every test failed on navigation and never reached its assertion.
 *
 * ENVIRONMENT: run against the ISOLATED TEST Supabase project only. Per
 * .claude/CLAUDE.md "测试环境隔离", production (jaxteelkecvlozdrdoog) must never be
 * the target of E2E writes; these tests create Pin drafts.
 */

import { test, expect, type Page } from "@playwright/test";

/** Open Create Pins (Board V2) and wait for the board itself, not the legacy composer. */
async function gotoBoard(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 30_000 });
}

/**
 * Open the canonical Product Picker.
 *
 * The board has TWO Select-product entry points and renders exactly one: the
 * toolbar button (`board-select-product`) only once cards exist, and the empty
 * state's "Create from your store?" link (`board-select-product-empty`) otherwise.
 * Both are additionally gated on the Shopify integration flag.
 */
async function openProductPicker(page: Page) {
  const toolbar = page.getByTestId("board-select-product");
  const empty = page.getByTestId("board-select-product-empty");
  const entry = (await toolbar.count()) > 0 ? toolbar : empty;
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  await expect(page.getByTestId("canonical-product-picker")).toBeVisible({ timeout: 20_000 });
}

test.describe("Create Pin flow 2026-07-21 — canonical Product Picker", () => {
  test("board renders and exposes a Select product entry point", async ({ page }) => {
    await gotoBoard(page);
    const toolbar = await page.getByTestId("board-select-product").count();
    const empty = await page.getByTestId("board-select-product-empty").count();
    expect(toolbar + empty).toBeGreaterThan(0);
  });

  test("only ONE product picker exists, and it is the canonical one", async ({ page }) => {
    await gotoBoard(page);
    await openProductPicker(page);
    // The retired ProductPickerModal is gone; nothing else may render a second picker.
    await expect(page.getByTestId("canonical-product-picker")).toHaveCount(1);
    await expect(page.getByTestId("product-picker")).toBeVisible();
  });

  test("primary tabs are My Products and Product Ideas — no From Shopify tab", async ({ page }) => {
    await gotoBoard(page);
    await openProductPicker(page);
    await expect(page.getByTestId("asset-picker-top-tabs").locator("button"))
      .toHaveText(["My Products", "Product Ideas"]);
    await expect(page.getByTestId("picker-tab-shopify")).toHaveCount(0);
  });

  test("source chips exclude Product Ideas and Recent", async ({ page }) => {
    await gotoBoard(page);
    await openProductPicker(page);
    const chips = page.getByTestId("my-products-filter-chips");
    await expect(chips).toBeVisible();
    const text = (await chips.locator("button").allTextContents()).join("|");
    expect(text).toContain("All");
    expect(text).not.toContain("Product Ideas");
    expect(text).not.toContain("Recent");
  });

  test("Recent is a SORT mode, not a source", async ({ page }) => {
    await gotoBoard(page);
    await openProductPicker(page);
    const sort = page.getByTestId("my-products-sort");
    await expect(sort).toBeVisible();
    const options = await sort.locator("option").allTextContents();
    expect(options).toContain("Recently used");
    expect(options).toContain("Recently added");
    expect(options).toContain("Name A–Z");
  });

  test("a single-product entry point says 'Choose a product' and offers no vague CTA", async ({ page }) => {
    await gotoBoard(page);
    await openProductPicker(page);
    // Select product consumes exactly one product, so the picker must not promise more.
    await expect(page.getByText("Choose a product")).toBeVisible();
    await expect(page.getByText("Add Selected")).toHaveCount(0);
  });

  test("cancelling the picker creates NO draft", async ({ page }) => {
    await gotoBoard(page);
    const before = await page.getByTestId("pin-board-card").count();
    await openProductPicker(page);
    await page.getByTestId("asset-picker-cancel").click();
    await expect(page.getByTestId("canonical-product-picker")).toHaveCount(0);
    // Browsing and cancelling must never have a side effect.
    await expect.poll(() => page.getByTestId("pin-board-card").count()).toBe(before);
  });
});
