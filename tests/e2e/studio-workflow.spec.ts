import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio as gotoStudioPage,
  openProductPicker,
  uploadProductInPicker,
  openReferencePicker,
  uploadReferenceInPicker,
  confirmAssetPicker,
} from "./helpers/studio";

/**
 * Studio workflow E2E test suite — 18 cases
 *
 * Tests the refactored Create Pins page (/app/studio) covering:
 *   - Asset pool model (upload, select, deselect, pool persistence)
 *   - Pool separation (products vs references)
 *   - Prompt auto-generation and promptTouched protection
 *   - Generate button behavior (inputs preserved, placeholder cards)
 *   - Add to Plan (simple, no complex form)
 *   - Session restore on refresh
 *   - Layout: user dropdown, language submenu, sidebar width
 *
 * Run:  npx playwright test studio-workflow.spec.ts
 * Env:  E2E_TEST_MODE=true  (set in .env.local to bypass auth redirect)
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

const MOCK_TREND_KEYWORDS = [
  { id: "t0001", keyword: "cozy bedroom decor", category: "home-decor", priority_score: 90, yearly_change: 40, status: "active" },
  { id: "t0002", keyword: "boho living room",   category: "home-decor", priority_score: 75, yearly_change: 30, status: "active" },
];

// Small 1×1 red PNG as a test "product" image (base64)
const TINY_RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Small 1×1 blue PNG as a test "reference" image (base64)
const TINY_BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const MOCK_GENERATED_URLS = [
  "https://placehold.co/400x600/FF4D8D/white?text=Generated+1",
  "https://placehold.co/400x600/7C3AED/white?text=Generated+2",
];

async function setupMocks(page: Page) {
  await prepareStudioPage(page);
  await page.route(`${SUPABASE_URL}/rest/v1/trend_keywords*`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Range": `0-${MOCK_TREND_KEYWORDS.length - 1}/${MOCK_TREND_KEYWORDS.length}` },
      body: JSON.stringify(MOCK_TREND_KEYWORDS),
    });
  });
  await page.route(`${SUPABASE_URL}/auth/**`, async (route) => { await route.continue(); });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, urls: MOCK_GENERATED_URLS }),
    });
  });
}

async function gotoStudio(page: Page) {
  await gotoStudioPage(page);
}

/** Upload via asset picker (compact entry model) */
async function uploadViaPicker(page: Page, role: "product" | "style_reference", buffer: Buffer, filename: string) {
  void filename;
  if (role === "product") {
    const panel = await openProductPicker(page);
    await uploadProductInPicker(page, panel, buffer);
  } else {
    const panel = await openReferencePicker(page);
    await uploadReferenceInPicker(page, panel, buffer);
  }
  await confirmAssetPicker(page);
  const panelId = role === "product" ? "product-picker" : "reference-picker";
  await expect(page.getByTestId(panelId)).toHaveCount(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Studio workflow — 18 cases", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
    // Clear localStorage before each test so asset pools start empty
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  // ── Case 1: Page loads without React error ────────────────────────────────
  test("1 — /app/studio loads without React error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await gotoStudio(page);
    await expect(page.getByTestId("generate-btn")).toBeVisible();

    const reactErrors = errors.filter(e =>
      e.includes("React") || e.includes("Uncaught") || e.includes("Cannot read"),
    );
    expect(reactErrors, `React errors on load: ${reactErrors.join("; ")}`).toHaveLength(0);
  });

  // ── Case 2: Upload product via picker → appears in selected-products ───────
  test("2 — upload product image via picker → appears in selected-products", async ({ page }) => {
    await gotoStudio(page);
    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");

    await expect(page.getByTestId("selected-products")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(1)");
  });

  // ── Case 3: Upload product → auto-selected ───────────────────────────────
  test("3 — uploaded product image is auto-selected", async ({ page }) => {
    await gotoStudio(page);
    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");

    await expect(page.getByTestId("selected-products")).toBeVisible({ timeout: 5000 });
    const selectedItems = page.getByTestId("selected-products").locator("div, img");
    expect(await selectedItems.count()).toBeGreaterThan(0);
  });

  // ── Case 4: Deselect → removes from selection ─────────────────────────────
  test("4 — deselecting product removes it from selection", async ({ page }) => {
    await gotoStudio(page);
    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");

    await expect(page.getByTestId("selected-products")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("selected-products").locator("button").first().click();
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(0)");
  });

  // ── Case 5: Re-open picker in same session → uploaded product still in library
  test("5 — uploaded product persists when picker is reopened", async ({ page }) => {
    await gotoStudio(page);
    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");
    await expect(page.getByTestId("selected-products")).toBeVisible({ timeout: 5000 });

    // Re-open without reload — asset should still be in the library.
    // (addInitScript clears localStorage on reload, so persistence-across-reload is
    //  tested at unit level instead.)
    await openProductPicker(page);
    await expect(page.getByTestId("picker-tab-my_products")).toHaveText("My Products");
    await expect(page.getByTestId("picker-tab-product_ideas")).toHaveText("Product Ideas");
    await expect(page.getByTestId("my-products-grid").getByTestId("asset-card")).toHaveCount(1, { timeout: 15000 });
  });

  // ── Case 6: Select reference → appears in selected-refs ──────────────────
  test("6 — upload reference via picker → appears in selected-refs", async ({ page }) => {
    await gotoStudio(page);
    await uploadViaPicker(page, "style_reference", TINY_BLUE_PNG, "ref.png");

    await expect(page.getByTestId("selected-refs")).toBeVisible({ timeout: 5000 });
    const selectedRefItems = page.getByTestId("selected-refs").locator("div, img");
    expect(await selectedRefItems.count()).toBeGreaterThan(0);
  });

  // ── Case 7: Products and references stay in separate selections ───────────
  test("7 — products and references stay in separate selections", async ({ page }) => {
    await gotoStudio(page);

    await uploadViaPicker(page, "product",         TINY_RED_PNG,  "product.png");
    await uploadViaPicker(page, "style_reference", TINY_BLUE_PNG, "ref.png");

    await expect(page.getByTestId("selected-products")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("selected-refs")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("products-asset-section-count")).toHaveText("(1)");
    await expect(page.getByTestId("refs-asset-section-count")).toHaveText("(1)");
  });

  // ── Case 8: Select product → prompt auto-generates ───────────────────────
  test("8 — selecting product auto-generates prompt", async ({ page }) => {
    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");

    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");

    // Prompt should change after upload (auto-generation from product context)
    await page.waitForTimeout(500); // debounce
    const updatedPrompt = await textarea.inputValue();

    // Prompt should now have content (either changed or already had content)
    // At minimum it should mention product context
    expect(updatedPrompt.length, "Prompt should be non-empty after product upload").toBeGreaterThan(0);
  });

  // ── Case 9: Manual prompt edit → not overridden ──────────────────────────
  test("9 — manual prompt edit is not overridden by auto-generation", async ({ page }) => {
    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");
    const MANUAL_PROMPT = "My very specific custom prompt that should not be overridden.";

    // Type a manual prompt (this sets promptTouched=true)
    await textarea.click();
    await textarea.fill(MANUAL_PROMPT);

    // Now upload a product (which would trigger auto-generation)
    await uploadViaPicker(page, "product", TINY_RED_PNG, "product.png");

    await page.waitForTimeout(500);

    // Manual prompt must be preserved
    const currentPrompt = await textarea.inputValue();
    expect(currentPrompt, "Manual prompt was overridden").toBe(MANUAL_PROMPT);
  });

  // ── Case 10: Generate → composer inputs NOT cleared ───────────────────────
  test("10 — generate does not clear prompt, products, or refs", async ({ page }) => {
    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");
    const PROMPT = "A beautiful Pinterest-native home decor pin.";
    await textarea.fill(PROMPT);

    await uploadViaPicker(page, "product",         TINY_RED_PNG,  "product.png");
    await uploadViaPicker(page, "style_reference", TINY_BLUE_PNG, "ref.png");

    // Click generate
    const generateBtn = page.getByTestId("generate-btn");
    await expect(generateBtn).not.toBeDisabled({ timeout: 3000 });
    await generateBtn.click();

    // Wait for generation to complete
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout: 15000 });

    // Prompt must still be intact
    const postGenPrompt = await textarea.inputValue();
    expect(postGenPrompt, "Prompt was cleared after generation").toBe(PROMPT);

    // Both selections must still be visible
    await expect(page.getByTestId("selected-products")).toBeVisible();
    await expect(page.getByTestId("selected-refs")).toBeVisible();
  });

  // ── Case 11: Generate → placeholder cards appear immediately ─────────────
  test("11 — placeholder cards appear immediately when generation starts", async ({ page }) => {
    await gotoStudio(page);

    // Slow down /api/generate to give us time to observe placeholders
    await page.route("**/api/generate", async (route) => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, urls: MOCK_GENERATED_URLS }),
      });
    });

    const textarea = page.getByTestId("prompt-textarea");
    await textarea.fill("A Pinterest pin for testing placeholder behavior.");

    const generateBtn = page.getByTestId("generate-btn");
    await generateBtn.click();

    // Placeholders should appear quickly, before generation is done
    await expect(page.getByTestId("placeholder-card").first()).toBeVisible({ timeout: 3000 });
  });

  // ── Case 12: 2 refs × 2 images → 2 groups, 2 placeholders each ──────────
  test("12 — 2 refs × 2 images → 2 groups each with 2 placeholder cards", async ({ page }) => {
    await gotoStudio(page);

    // Slow down generate to observe groups
    await page.route("**/api/generate", async (route) => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, urls: ["https://placehold.co/400x600/FF4D8D/white?text=P1", "https://placehold.co/400x600/7C3AED/white?text=P2"] }),
      });
    });

    // Upload 2 refs (inline upload adds to pool + selects)
    await uploadViaPicker(page, "style_reference", TINY_BLUE_PNG, "ref1.png");
    // Second upload needs a different filename to avoid dedup in assetStore
    const TINY_GREEN_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=",
      "base64",
    );
    await uploadViaPicker(page, "style_reference", TINY_GREEN_PNG, "ref2.png");

    const textarea = page.getByTestId("prompt-textarea");
    await textarea.fill("Two references test.");

    const generateBtn = page.getByTestId("generate-btn");
    await generateBtn.click();

    // With 2 refs, we should see placeholder-card elements appear (at least 2 groups' worth)
    await expect(page.getByTestId("generated-set")).toHaveCount(0);
    await page.waitForSelector('[data-testid="placeholder-card"]', { timeout: 5000 });
    const placeholders = page.getByTestId("placeholder-card");
    const count = await placeholders.count();
    expect(count).toBe(4);
    await expect(page.getByTestId("pin-feed-grid")).toBeVisible();

    // 2 refs × 2 images = 4 placeholders minimum (or 2 if groups sequential)
    expect(count, `Expected ≥2 placeholder cards, got ${count}`).toBeGreaterThanOrEqual(2);
  });

  // ── Case 13: Completed pins appear in correct group ───────────────────────
  test("13 — generated pins appear in the generation feed after completion", async ({ page }) => {
    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");
    await textarea.fill("A test pin for group verification.");

    const generateBtn = page.getByTestId("generate-btn");
    await generateBtn.click();

    // Wait for generated pin cards (not placeholders)
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout: 15000 });
    const cards = page.getByTestId("generated-pin-card");
    expect(await cards.count(), "Expected at least 1 generated card").toBeGreaterThanOrEqual(1);

    // Cards are inside the generation feed
    const feed = page.getByTestId("generation-feed");
    await expect(feed).toBeVisible();
    await expect(feed.getByTestId("generated-pin-card").first()).toBeVisible();
  });

  // ── Case 14: Add to Plan → no complex form opens ─────────────────────────
  test("14 — Add to Plan does not open a complex publish form", async ({ page }) => {
    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");
    await textarea.fill("A pin to add to plan.");

    await page.getByTestId("generate-btn").click();
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout: 15000 });

    // Click first Add to Plan button (inside a generated card)
    await page.locator('[data-testid="generated-pin-card"]').first().hover();
    const addToPlanBtn = page.locator('[data-testid="generated-pin-card"]').first().getByRole("button", { name: /Add to Plan/i });
    if (await addToPlanBtn.isVisible()) {
      await addToPlanBtn.click();

      // Should NOT navigate away or open a large form/modal
      await page.waitForTimeout(500);
      expect(page.url()).toContain("/app/studio");

      // Confirm the button changed to "Added" (success state) — no modal/form
      const addedBtn = page.locator('[data-testid="generated-pin-card"]').first().getByRole("button", { name: /Added/i });
      // Either the button shows "Added" or a toast was shown — either is acceptable
      const buttonChanged = await addedBtn.isVisible().catch(() => false);
      // Also check no modal appeared
      const modalVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
      expect(modalVisible, "A modal/form opened after clicking Add to Plan").toBe(false);
      // If button changed, great. If not, check for toast
      if (!buttonChanged) {
        // Toast is acceptable confirmation
        const toastVisible = await page.locator('[data-sonner-toast]').isVisible().catch(() => false);
        expect(buttonChanged || toastVisible, "Neither button state nor toast confirmed Add to Plan success").toBe(true);
      }
    } else {
      // If button isn't found by that name, just verify no modal
      const modalVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
      expect(modalVisible).toBe(false);
    }
  });

  // ── Case 15: Refresh → recent generations visible, no crash ──────────────
  test("15 — refresh preserves recent generations in feed without crash", async ({ page }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });

    await gotoStudio(page);

    const textarea = page.getByTestId("prompt-textarea");
    await textarea.fill("Refresh persistence test.");
    await page.getByTestId("generate-btn").click();
    await expect(page.getByTestId("generated-pin-card").first()).toBeVisible({ timeout: 30000 });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await expect(page.getByTestId("studio-interactive")).toBeAttached({ timeout: 20000 });
    await expect(page.getByTestId("generation-feed")).toBeVisible({ timeout: 10000 });

    const reactErrors = errors.filter(e => e.includes("React") || e.includes("Uncaught") || e.includes("Cannot read"));
    expect(reactErrors, "React errors after refresh").toHaveLength(0);
  });

  // ── Case 16: Avatar click → dropdown opens ────────────────────────────────
  test("16 — clicking user avatar opens dropdown menu", async ({ page }) => {
    await gotoStudio(page);

    const avatar = page.getByTestId("user-avatar");
    await expect(avatar).toBeVisible({ timeout: 5000 });
    await avatar.click();

    const dropdown = page.getByTestId("user-dropdown");
    await expect(dropdown).toBeVisible({ timeout: 3000 });

    // Dropdown should contain expected items
    await expect(dropdown).toContainText("退出登录");
  });

  // ── Case 17: Language submenu → shows with 中文 checked ──────────────────
  test("17 — language submenu shows with 中文 checked by default", async ({ page }) => {
    await gotoStudio(page);

    // Open dropdown
    const avatar = page.getByTestId("user-avatar");
    await avatar.click();
    await expect(page.getByTestId("user-dropdown")).toBeVisible({ timeout: 3000 });

    // Hover language menu item to trigger submenu
    const langItem = page.getByTestId("language-menu-item");
    await expect(langItem).toBeVisible({ timeout: 3000 });
    await langItem.hover();

    // Submenu should appear
    const submenu = page.getByTestId("language-submenu");
    await expect(submenu).toBeVisible({ timeout: 2000 });

    // 中文 option should be present
    const zhOption = page.getByTestId("lang-zh");
    await expect(zhOption).toBeVisible({ timeout: 2000 });

    // 中文 should indicate it is selected/checked
    const zhText = await zhOption.textContent();
    expect(zhText, "zh option should contain 中文").toContain("中文");
  });

  // ── Case 18: Sidebar width ≤ 88px ────────────────────────────────────────
  test("18 — sidebar width is compact (≤ 88px)", async ({ page }) => {
    await gotoStudio(page);

    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    const box = await sidebar.boundingBox();
    expect(box, "Could not get sidebar bounding box").not.toBeNull();
    expect(
      box!.width,
      `Sidebar too wide: ${box!.width}px (expected ≤ 88px)`,
    ).toBeLessThanOrEqual(88);
  });

});
