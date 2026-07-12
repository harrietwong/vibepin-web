import { test, expect } from "@playwright/test";

const FORBIDDEN_EXACT_METRICS = [
  "Avg. Searches",
  "Avg. Clicks",
  "CTR",
  "Search Volume",
  "Exact saves",
  "Total pins",
  "Total products",
  "Exact competition count",
];

const QUALITATIVE_BANDS = [
  /high|medium|low/i,
  /strong|weak/i,
  /rising|evergreen|seasonal/i,
  /best bet|steady|competitive/i,
];

async function assertNoFakeMetrics(page: Parameters<Parameters<typeof test>[1]>[0]) {
  const bodyText = await page.textContent("body") ?? "";
  for (const phrase of FORBIDDEN_EXACT_METRICS) {
    expect(bodyText, `Forbidden fake metric found: "${phrase}"`).not.toContain(phrase);
  }
}

// Fills the search input using pressSequentially (reliable with React 19 controlled inputs)
async function searchKeyword(page: Parameters<Parameters<typeof test>[1]>[0], keyword: string) {
  const input = page.getByTestId("keyword-search-input");
  await input.click();
  await input.fill("");  // clear first
  await input.pressSequentially(keyword, { delay: 30 });
  await page.getByTestId("keyword-search-button").click();
}

test.describe("Keyword Tool", () => {

  test.beforeEach(async ({ page }) => {
    await page.goto("/app/trends", { waitUntil: "domcontentloaded" });
    const url = page.url();
    expect(url, "Still on login — ensure E2E_TEST_MODE=true in .env.local and restart dev server").not.toContain("/login");
  });

  test("page title is Pinterest Keyword Trends", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Pinterest Keyword Trends", { timeout: 5000 });
  });

  test("search bar and button are visible", async ({ page }) => {
    await expect(page.getByTestId("keyword-search-input")).toBeVisible();
    await expect(page.getByTestId("keyword-search-button")).toBeVisible();
  });

  test.describe("real keyword: cozy bedroom decor", () => {

    test.beforeEach(async ({ page }) => {
      await searchKeyword(page, "cozy bedroom decor");
      // Wait until either results or empty state loads (use race — mixed CSS+text selector invalid)
      await Promise.race([
        page.waitForSelector('[data-testid="keyword-summary-card"]', { timeout: 15000 }),
        page.waitForSelector('[data-testid="keyword-create-anyway-button"]', { timeout: 15000 }),
      ]).catch(() => {});
    });

    test("shows four summary cards", async ({ page }) => {
      await page.waitForSelector('[data-testid="keyword-summary-card"]', { timeout: 10000 })
        .catch(() => { throw new Error("MISSING SEED DATA: No summary cards for 'cozy bedroom decor'"); });

      const cards = page.getByTestId("keyword-summary-card");
      await expect(cards).toHaveCount(4, { timeout: 5000 });

      // Read ALL text across all 4 cards (not just first <p> of first card)
      const allText = (await cards.allTextContents()).join(" ").toUpperCase();
      expect(allText).toMatch(/PINTEREST INTEREST/);
      expect(allText).toMatch(/SAVE SIGNAL/);
      expect(allText).toMatch(/COMPETITION/);
      expect(allText).toMatch(/OPPORTUNITY/);
    });

    test("shows source-aware trend section — not a fake 12-month chart for estimated data", async ({ page }) => {
      await page.waitForSelector('[data-testid="search-trend-chart"]', { timeout: 15000 });
      const chart = page.getByTestId("search-trend-chart");
      await expect(chart).toBeVisible();

      const hasOfficial = await chart.getByText("Search Trend · Past 12 months").isVisible().catch(() => false);
      const hasEstimated = await chart.getByTestId("estimated-trend-signal").isVisible().catch(() => false);
      const hasResource = await chart.getByTestId("resource-trend-insight").isVisible().catch(() => false);

      expect(hasOfficial || hasEstimated || hasResource, "Expected official chart OR estimated/resource insight").toBe(true);

      if (hasEstimated) {
        await expect(chart).toContainText("Estimated trend signal");
        await expect(chart).not.toContainText("Past 12 months");
      }
      if (hasOfficial) {
        await expect(chart.getByTestId("trend-source-line")).toContainText("Pinterest Trends API");
      }
    });

    test("shows related keywords table with at least 1 row", async ({ page }) => {
      // Wait for the actual rows, not just the table shell (which shows first as skeleton)
      await page.waitForSelector('[data-testid="related-keyword-row"]', { timeout: 20000 })
        .catch(() => { throw new Error("Related keywords table loaded but 0 rows rendered after 20s"); });

      const rows = page.getByTestId("related-keyword-row");
      await expect(rows.first()).toBeVisible();
      const rowCount = await rows.count();
      expect(rowCount, "Related keywords table should have at least 1 row").toBeGreaterThan(0);
    });

    test("table rows show only qualitative bands — no exact metrics", async ({ page }) => {
      await page.waitForSelector('[data-testid="related-keyword-row"]', { timeout: 20000 });
      await assertNoFakeMetrics(page);

      const table = page.getByTestId("related-keywords-table");
      const tableText = await table.textContent() ?? "";
      const hasBands = QUALITATIVE_BANDS.some(pattern => pattern.test(tableText));
      expect(hasBands, "Related keywords table should show at least one qualitative band").toBe(true);
    });

    test("no forbidden exact metric strings appear anywhere on the page", async ({ page }) => {
      await page.waitForSelector('[data-testid="keyword-summary-card"]', { timeout: 15000 })
        .catch(() => {});
      await assertNoFakeMetrics(page);
    });

  });

  test.describe("missing keyword: zzzzzztest", () => {

    test.beforeEach(async ({ page }) => {
      await searchKeyword(page, "zzzzzztest");
      await Promise.race([
        page.waitForSelector('[data-testid="keyword-summary-card"]',        { timeout: 15000 }),
        page.waitForSelector('[data-testid="keyword-create-anyway-button"]', { timeout: 15000 }),
        page.waitForSelector("text=No keyword data found yet",               { timeout: 15000 }),
      ]).catch(() => {});
    });

    test("shows empty state — not closest match", async ({ page }) => {
      const hasSummaryCards = (await page.getByTestId("keyword-summary-card").count()) > 0;
      expect(hasSummaryCards, "Gibberish query must not return a forced closest match").toBe(false);
      const hasEmpty =
        (await page.getByTestId("keyword-create-anyway-button").isVisible().catch(() => false)) ||
        (await page.locator("text=No keyword data found yet").isVisible().catch(() => false));
      expect(hasEmpty, "Expected empty state for zzzzzztest").toBe(true);
    });
  });

  test.describe("missing keyword: zzzz handmade alien pillow test", () => {

    test.beforeEach(async ({ page }) => {
      await searchKeyword(page, "zzzz handmade alien pillow test");
      // Wait until loading finishes (either empty state or unexpected result)
      await Promise.race([
        page.waitForSelector('[data-testid="keyword-summary-card"]',        { timeout: 15000 }),
        page.waitForSelector('[data-testid="keyword-create-anyway-button"]', { timeout: 15000 }),
        page.waitForSelector("text=No keyword data found yet",               { timeout: 15000 }),
      ]).catch(() => {});
    });

    test("shows empty state — not fake data", async ({ page }) => {
      const hasSummaryCards = (await page.getByTestId("keyword-summary-card").count()) > 0;
      if (hasSummaryCards) {
        await assertNoFakeMetrics(page);
      } else {
        const hasEmpty =
          (await page.getByTestId("keyword-create-anyway-button").isVisible().catch(() => false)) ||
          (await page.locator("text=No keyword data found yet").isVisible().catch(() => false));
        expect(hasEmpty, "Expected empty state for unknown keyword").toBe(true);
      }
    });

    test("'Create from this keyword anyway' link exists in empty state", async ({ page }) => {
      const summaryCardsExist = (await page.getByTestId("keyword-summary-card").count()) > 0;
      if (!summaryCardsExist) {
        const createAnywayVisible = await page.getByTestId("keyword-create-anyway-button").isVisible().catch(() => false);
        expect(createAnywayVisible, "'Create Pins anyway' link must appear in empty state").toBe(true);
      }
    });

    test("no fake demand or competition data is fabricated", async ({ page }) => {
      await assertNoFakeMetrics(page);
      const bodyText = await page.textContent("body") ?? "";
      expect(bodyText).not.toMatch(/\d+%\s+confidence/i);
      expect(bodyText).not.toMatch(/\d{1,3},\d{3}\s+(searches|saves|clicks)/i);
    });

  });

});
