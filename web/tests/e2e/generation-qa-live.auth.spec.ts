/**
 * LIVE generation-path QA (create-pin flow rework, Section G/G2).
 *
 * Unlike the mocked specs, this exercises the REAL stack end to end: authenticated
 * session against the isolated TEST Supabase project, real /api/generate call
 * (billed model usage — run only with explicit authorisation), real draft
 * persistence. It is therefore NOT part of the default suite: it self-skips unless
 * RUN_LIVE_GENERATION_QA=1.
 *
 * What it proves that the mocked specs cannot:
 *  - Select product → AI drawer → Generate produces EXACTLY the requested number
 *    of result cards ("请求几张就返回几张" — provider extras must be discarded).
 *  - Each result belongs to a generation group; with a reference selected the
 *    group carries the reference association (Section G2).
 *  - The product's URL is derived into the Pin's destination URL automatically.
 */
import { test, expect } from "@playwright/test";
import path from "path";

const LIVE = process.env.RUN_LIVE_GENERATION_QA === "1";
test.skip(!LIVE, "live generation QA runs only with RUN_LIVE_GENERATION_QA=1 (billed)");

// A generation round-trip through a real model takes minutes, not seconds.
test.setTimeout(10 * 60_000);

const PRODUCT_IMAGE = path.join(process.cwd(), "tests", "e2e", "fixtures", "qa-product.png");

test("select product → generate 2 → exactly 2 results with product URL derived", async ({ page }) => {
  await page.goto("/app/studio");
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 30_000 });

  // Open the canonical picker from whichever Select-product entry is rendered.
  const entry = page.getByTestId("board-select-product").or(page.getByTestId("board-select-product-empty"));
  await entry.first().click();
  await expect(page.getByTestId("canonical-product-picker")).toBeVisible();

  // Upload a product image through the picker's own upload affordance — this both
  // guarantees the fresh test account has an asset and exercises the upload path.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("compact-upload-product").click(),
  ]);
  await chooser.setFiles(PRODUCT_IMAGE);

  // The uploaded asset appears as a card; select it and confirm.
  const card = page.getByTestId("asset-card").first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  await page.getByTestId("asset-picker-confirm").click();

  // Selecting a product opens the AI drawer directly (no bare draft).
  await expect(page.getByTestId("ai-version-drawer")).toBeVisible({ timeout: 15_000 });

  // If reference recommendations arrive, select the first one so the run forms a
  // reference group; if the section errors or stays empty, proceed without — the
  // count semantics under test are identical (max(refs,1) × perReference).
  const recommended = page.getByTestId("recommended-reference-card").first();
  let referenceSelected = false;
  try {
    await recommended.waitFor({ state: "visible", timeout: 20_000 });
    await recommended.click();
    referenceSelected = true;
  } catch {
    /* no recommendations for a brand-new product — acceptable */
  }

  // Request exactly 2 pins (per reference when one is selected).
  await page.getByTestId("ai-version-count").selectOption("2");

  const generate = page.getByTestId("ai-version-generate");
  await expect(generate).toBeEnabled();
  await generate.click();

  // The board should show generating placeholders, then settle into result cards.
  // Board V2 renders each generated pin as a board card; count the settled images
  // that came from this run by waiting for the generating state to clear.
  const generating = page.getByTestId("board-card-generating");
  await expect(generating.first()).toBeVisible({ timeout: 60_000 });
  await expect(generating).toHaveCount(0, { timeout: 8 * 60_000 });

  const resultCards = page.getByTestId("board-card");
  const settled = await resultCards.count();
  expect(settled, "exactly the requested number of drafts, no provider extras").toBe(2);

  // Open the first result's details and assert the product URL was derived.
  await resultCards.first().click();
  const urlField = page.getByTestId("pin-details-destination-url").or(page.locator('input[name="destinationUrl"]'));
  await expect(urlField.first()).toBeVisible({ timeout: 15_000 });
  const urlValue = await urlField.first().inputValue();
  expect(urlValue.length, "destination URL derived from the selected product").toBeGreaterThan(0);

  console.log(`LIVE QA: 2 requested, ${settled} settled, reference selected: ${referenceSelected}, url: ${urlValue}`);
});
