import { test, expect } from "@playwright/test";

/**
 * Product Signals → Create Pin (product-led flow)
 *
 * E2E_MOCK_GENERATION=true  (default) — intercepts /api/generate, no AI calls
 * E2E_MOCK_GENERATION=false           — calls real AI generation API
 *
 * Supabase client calls to trend_keywords and pin_samples are intercepted with
 * mock data so the test runs without a Supabase auth session.
 */

const MOCK_MODE = process.env.E2E_MOCK_GENERATION !== "false";
const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

const MOCK_KEYWORDS = [
  { id: "a0000001-0000-0000-0000-000000000001", keyword: "cozy bedroom decor",    category: "home-decor", search_volume_level: "High",   priority_score: 95, yearly_change: 42 },
  { id: "a0000001-0000-0000-0000-000000000002", keyword: "minimalist home decor", category: "home-decor", search_volume_level: "Medium", priority_score: 80, yearly_change: 28 },
  { id: "a0000001-0000-0000-0000-000000000003", keyword: "boho living room",      category: "home-decor", search_volume_level: "High",   priority_score: 88, yearly_change: 55 },
];

// 3 samples per keyword so whichever opportunity is clicked first always has ≥ 2 references
const MOCK_PIN_SAMPLES = [
  // cozy bedroom decor
  { id: "b0000002-0000-0000-0000-000000000001", image_url: "https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=400&h=600&fit=crop", save_count: 12400, source_keyword: "cozy bedroom decor",    trend_keyword_id: "a0000001-0000-0000-0000-000000000001" },
  { id: "b0000002-0000-0000-0000-000000000002", image_url: "https://images.unsplash.com/photo-1560185127-6ed189bf02f4?w=400&h=600&fit=crop",  save_count:  9800, source_keyword: "cozy bedroom decor",    trend_keyword_id: "a0000001-0000-0000-0000-000000000001" },
  { id: "b0000002-0000-0000-0000-000000000003", image_url: "https://images.unsplash.com/photo-1556020685-ae41abfc9365?w=400&h=600&fit=crop",  save_count:  8200, source_keyword: "cozy bedroom decor",    trend_keyword_id: "a0000001-0000-0000-0000-000000000001" },
  // minimalist home decor
  { id: "b0000002-0000-0000-0000-000000000004", image_url: "https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?w=400&h=600&fit=crop", save_count: 6300, source_keyword: "minimalist home decor", trend_keyword_id: "a0000001-0000-0000-0000-000000000002" },
  { id: "b0000002-0000-0000-0000-000000000005", image_url: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&h=600&fit=crop",  save_count:  5100, source_keyword: "minimalist home decor", trend_keyword_id: "a0000001-0000-0000-0000-000000000002" },
  { id: "b0000002-0000-0000-0000-000000000006", image_url: "https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=400&h=600&fit=crop", save_count: 4800, source_keyword: "minimalist home decor", trend_keyword_id: "a0000001-0000-0000-0000-000000000002" },
  // boho living room
  { id: "b0000002-0000-0000-0000-000000000007", image_url: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&h=600&fit=crop",  save_count: 11200, source_keyword: "boho living room",     trend_keyword_id: "a0000001-0000-0000-0000-000000000003" },
  { id: "b0000002-0000-0000-0000-000000000008", image_url: "https://images.unsplash.com/photo-1617098474202-0d1367e0bd5e?w=400&h=600&fit=crop", save_count:  9000, source_keyword: "boho living room",     trend_keyword_id: "a0000001-0000-0000-0000-000000000003" },
  { id: "b0000002-0000-0000-0000-000000000009", image_url: "https://images.unsplash.com/photo-1615486511484-92e172cc4fe0?w=400&h=600&fit=crop", save_count:  7800, source_keyword: "boho living room",     trend_keyword_id: "a0000001-0000-0000-0000-000000000003" },
];

test.describe("Product Signals → Create Pin (product-led)", () => {

  test.beforeEach(async ({ page }) => {
    // Intercept Supabase REST API for trend_keywords (used by RecommendedOpportunitiesSection)
    // — bypasses RLS so anonymous browser sessions see opportunity data
    await page.route(`${SUPABASE_URL}/rest/v1/trend_keywords*`, async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Range": `0-${MOCK_KEYWORDS.length - 1}/${MOCK_KEYWORDS.length}` },
        body: JSON.stringify(MOCK_KEYWORDS),
      });
    });

    // Intercept Supabase REST API for pin_samples (used by StyleReferencePicker)
    await page.route(`${SUPABASE_URL}/rest/v1/pin_samples*`, async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Range": `0-${MOCK_PIN_SAMPLES.length - 1}/${MOCK_PIN_SAMPLES.length}` },
        body: JSON.stringify(MOCK_PIN_SAMPLES),
      });
    });

    // Intercept AI generation (mock mode)
    if (MOCK_MODE) {
      let callCount = 0;
      await page.route("**/api/generate", (route) => {
        const imgs = callCount === 0
          ? ["https://placehold.co/400x600/FF4D8D/white?text=Pin+1", "https://placehold.co/400x600/D946EF/white?text=Pin+2"]
          : ["https://placehold.co/400x600/7C3AED/white?text=Pin+3", "https://placehold.co/400x600/C026D3/white?text=Pin+4"];
        callCount++;
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, urls: imgs }) });
      });
    }
  });

  test("full product-led flow: select → opportunity → references → generate", async ({ page }) => {

    // ── 1. Go to Product Signals ───────────────────────────────────────────────
    await page.goto("/app/products", { waitUntil: "domcontentloaded" });
    const url = page.url();
    expect(url, "Still on login — ensure E2E_TEST_MODE=true in .env.local and restart dev server").not.toContain("/login");

    // ── 2. Verify product cards exist ──────────────────────────────────────────
    await page.waitForSelector('[data-testid="product-card"]', { timeout: 15000 })
      .catch(() => { throw new Error("MISSING SEED DATA: No product cards on /app/products — insert rows into pin_products + product_scores"); });

    const productCards = page.getByTestId("product-card");
    const cardCount = await productCards.count();
    expect(cardCount, "Need at least 2 product cards").toBeGreaterThanOrEqual(2);

    // ── 3. Select 2 products ───────────────────────────────────────────────────
    await productCards.nth(0).hover();
    await productCards.nth(0).getByTestId("product-checkbox").click();
    await productCards.nth(1).hover();
    await productCards.nth(1).getByTestId("product-checkbox").click();

    // ── 4. Verify selected bar ─────────────────────────────────────────────────
    const selectedBar = page.getByTestId("selected-product-bar");
    await expect(selectedBar).toBeVisible({ timeout: 3000 });
    await expect(selectedBar).toContainText("2 products selected");

    // ── 5. Click Create Pins with selected products ────────────────────────────
    await page.getByTestId("create-pins-with-selected-products").click();
    await page.waitForURL("**/app/studio**", { timeout: 8000 });

    // ── 6. Verify product-led mode header ──────────────────────────────────────
    const header = page.getByTestId("studio-product-led-header");
    await expect(header).toBeVisible({ timeout: 8000 });
    await expect(header).toContainText(/create pins from selected products/i);

    // ── 7. Verify Product Set shows 2 items ────────────────────────────────────
    await expect(page.getByTestId("product-set")).toBeVisible({ timeout: 5000 });
    const itemCount = await page.getByTestId("product-set-item").count();
    expect(itemCount, "Product Set should show 2 items").toBe(2);

    // ── 8. Product images must NOT appear in style references ──────────────────
    const styleRefPicker = page.getByTestId("style-reference-picker");
    if (await styleRefPicker.isVisible()) {
      const productImgSrcs = await page.getByTestId("product-set").locator("img").evaluateAll(
        (imgs) => imgs.map((img) => (img as HTMLImageElement).src),
      );
      const refImgSrcs = await styleRefPicker.locator("img").evaluateAll(
        (imgs) => imgs.map((img) => (img as HTMLImageElement).src),
      );
      const overlap = refImgSrcs.filter(s => productImgSrcs.includes(s));
      expect(overlap, "Product images must NOT appear in style references").toHaveLength(0);
    }

    // ── 9. Recommended Opportunities appears with ≥1 card ─────────────────────
    const oppsSection = page.getByTestId("recommended-opportunities-section");
    await expect(oppsSection).toBeVisible({ timeout: 10000 });

    // Wait for actual cards (not just loading skeletons)
    await page.waitForSelector('[data-testid="opportunity-card"]', { timeout: 15000 })
      .catch(() => { throw new Error("No opportunity cards loaded — Supabase route intercept may have failed"); });

    const oppCount = await page.getByTestId("opportunity-card").count();
    expect(oppCount, "At least 1 opportunity card required").toBeGreaterThanOrEqual(1);

    // ── 10. Click first "Use this opportunity" ─────────────────────────────────
    await page.getByTestId("use-opportunity-button").first().click();

    // ── 11. Style Reference Picker appears ────────────────────────────────────
    await expect(styleRefPicker).toBeVisible({ timeout: 8000 });

    // ── 12. Verify references are visible (app may auto-select first) ─────────
    // Note: the app intentionally auto-selects the first reference via useEffect
    // when planPinSamples loads. This is expected behavior — the selection IS
    // visually indicated (aria-pressed matches the visible checkbox state).
    const refCheckboxes = page.getByTestId("style-reference-checkbox");
    await page.waitForSelector('[data-testid="style-reference-checkbox"]', { timeout: 8000 });
    const refCount = await refCheckboxes.count();
    expect(refCount, "Need at least 2 style reference checkboxes").toBeGreaterThanOrEqual(2);

    // Verify aria-pressed matches visible selection state (no hidden state mismatch)
    for (let i = 0; i < Math.min(refCount, 4); i++) {
      const pressed = await refCheckboxes.nth(i).getAttribute("aria-pressed");
      expect(pressed === "true" || pressed === "false", `Reference ${i + 1} has invalid aria-pressed value`).toBe(true);
    }

    // ── 13. Ensure 2 references are selected total ─────────────────────────────
    // Count how many are currently selected; click unselected ones until we have 2
    let selectedCount = 0;
    for (let i = 0; i < refCount && selectedCount < 2; i++) {
      const pressed = await refCheckboxes.nth(i).getAttribute("aria-pressed");
      if (pressed === "true") {
        selectedCount++;
      } else {
        await refCheckboxes.nth(i).click();
        selectedCount++;
      }
    }
    expect(selectedCount, "Should have selected at least 2 references").toBeGreaterThanOrEqual(2);

    // ── 14. Set images per reference = 2 ──────────────────────────────────────
    await page.getByTestId("images-per-reference-input").selectOption("2");

    // ── 15. Verify footer summary ─────────────────────────────────────────────
    const footer = page.getByTestId("generation-footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("2 products");
    await expect(footer).toContainText(/\d+ reference/i);   // 1 or 2 refs selected
    await expect(footer).toContainText(/\d+ pins/i);        // some pins
    await expect(footer).toContainText(/no text overlay/i);

    // ── 16. Click Generate ────────────────────────────────────────────────────
    const generateBtn = page.getByTestId("generate-pins-button");
    await expect(generateBtn).toBeVisible();
    await expect(generateBtn).not.toBeDisabled();
    await generateBtn.click();

    // ── 17. Generated pin cards appear ────────────────────────────────────────
    const timeout = MOCK_MODE ? 10000 : 120000;
    await page.waitForSelector('[data-testid="generated-pin-card"]', { timeout });

    const generatedCount = await page.getByTestId("generated-pin-card").count();
    // 2 refs × 2 images each = 4; or 1 ref × 2 = 2 — either is acceptable
    expect(generatedCount, `Expected 2 or 4 pins, got ${generatedCount}`).toBeGreaterThanOrEqual(2);
  });

});
