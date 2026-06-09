import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  addProductViaUpload,
  expectGeneratedPins,
} from "./helpers/studio";

const PROMPT = "Cozy bedroom decor with warm lighting for Pinterest.";

async function generatePins(page: import("@playwright/test").Page) {
  await prepareStudioPage(page);
  await gotoStudio(page);
  await addProductViaUpload(page);
  await page.getByTestId("prompt-textarea").fill(PROMPT);
  await page.getByTestId("generate-btn").click();
  await expectGeneratedPins(page);
}

test.describe("Studio pin metadata flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  });

  test("edit metadata in drawer, save, persist, add to plan", async ({ page }) => {
    await generatePins(page);
    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-drawer")).toBeVisible();
    await expect(page.getByTestId("pin-details-editor")).toBeVisible();

    const title = page.getByTestId("pin-details-title");
    await expect(title).not.toHaveValue("");
    await title.fill("My Custom Pin Title");
    await page.getByTestId("pin-details-description").fill("A beautiful cozy bedroom pin for saving.");
    await page.getByTestId("pin-details-planned-date").fill("2026-06-15");
    await page.getByTestId("pin-details-save").click();

    await page.getByTestId("pin-details-close").click();
    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-title")).toHaveValue("My Custom Pin Title");
    await expect(page.getByTestId("pin-details-description")).toHaveValue("A beautiful cozy bedroom pin for saving.");

    await page.getByTestId("pin-details-add-to-plan").click();
    await expect(page.getByTestId("pin-details-status-badge")).toContainText("Added");
  });

  test("batch select, batch edit, generate metadata, add selected", async ({ page }) => {
    await generatePins(page);
    const cards = page.getByTestId("generated-pin-card");
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 2); i++) {
      await cards.nth(i).locator('[data-testid="pin-select-checkbox"]').click();
    }
    await expect(page.getByTestId("batch-toolbar")).toBeVisible();
    await expect(page.getByTestId("generate-pin-details-button")).toBeVisible();
    await page.getByTestId("batch-edit-details-button").click();
    await expect(page.getByTestId("batch-edit-drawer")).toBeVisible();
    await page.getByTestId("batch-destination-url").fill("https://shop.example.com/product");
    await page.getByTestId("batch-generate-metadata").click();
    await page.getByTestId("batch-edit-close").click();
    await page.getByTestId("batch-add-selected").click();
    await expect(page.getByTestId("batch-toolbar")).toHaveCount(0);
  });
});
