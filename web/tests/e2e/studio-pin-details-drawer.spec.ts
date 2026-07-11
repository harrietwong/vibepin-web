import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  addProductViaUpload,
  expectGeneratedPins,
  expectFailedPlaceholder,
} from "./helpers/studio";

const PROMPT = "Cozy bedroom scene with warm lighting for Pinterest.";

async function uploadProductAndGenerate(page: import("@playwright/test").Page, generateMode: "success" | "fail" = "success") {
  await prepareStudioPage(page, { generateMode });
  await gotoStudio(page);
  await addProductViaUpload(page);
  await page.getByTestId("prompt-textarea").fill(PROMPT);
  await page.getByTestId("generate-btn").click();
}

test.describe("Pin Details Drawer", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("completed pin opens right-side drawer on Preview tab by default", async ({ page }) => {
    await uploadProductAndGenerate(page, "success");
    await expectGeneratedPins(page);

    await page.getByTestId("generated-pin-card").first().click();

    const drawer = page.getByTestId("pin-details-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS("right", "0px");

    // Tab bar with three tabs
    await expect(page.getByTestId("pin-details-tab-bar")).toBeVisible();
    await expect(page.getByTestId("pin-details-tab-preview")).toBeVisible();
    await expect(page.getByTestId("pin-details-tab-remix")).toBeVisible();
    await expect(page.getByTestId("pin-details-tab-plan")).toBeVisible();

    // Preview tab is shown by default
    await expect(page.getByTestId("pin-details-preview")).toBeVisible();
    await expect(page.getByTestId("pin-details-preview-image")).toBeVisible();
    await expect(page.getByTestId("pin-details-status-badge")).toBeVisible();

    // No centered modal
    await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);
    await expect(page.getByText("Edit Pin Details")).toHaveCount(0);

    await page.getByTestId("pin-details-close").click();
    await expect(drawer).toHaveCount(0);
  });

  test("Remix tab shows prompt, products, references, and settings", async ({ page }) => {
    await uploadProductAndGenerate(page, "success");
    await expectGeneratedPins(page);

    await page.getByTestId("generated-pin-card").first().click();
    const drawer = page.getByTestId("pin-details-drawer");
    await expect(drawer).toBeVisible();

    // Switch to Remix tab
    await page.getByTestId("pin-details-tab-remix").click();
    await expect(page.getByTestId("pin-details-prompt")).toBeVisible();
    await expect(page.getByTestId("pin-details-setup-products")).toBeVisible();
    await expect(page.getByTestId("pin-details-setup-references")).toBeVisible();
    await expect(page.getByTestId("pin-details-setup-opportunity")).toBeVisible();
    await expect(page.getByTestId("pin-details-setup-settings")).toBeVisible();
    await expect(page.getByTestId("pin-details-remix-actions")).toBeVisible();
    await expect(page.getByTestId("pin-details-regenerate-with-remix")).toBeVisible();
  });

  test("Plan tab shows metadata form fields", async ({ page }) => {
    await uploadProductAndGenerate(page, "success");
    await expectGeneratedPins(page);

    await page.getByTestId("generated-pin-card").first().click();
    const drawer = page.getByTestId("pin-details-drawer");
    await expect(drawer).toBeVisible();

    // Switch to Plan tab
    await page.getByTestId("pin-details-tab-plan").click();
    await expect(page.getByTestId("pin-details-editor")).toBeVisible();
    await expect(page.getByTestId("pin-details-plan-actions")).toBeVisible();
    await expect(page.getByTestId("pin-details-save")).toBeVisible();
    await expect(page.getByTestId("pin-details-add-to-plan")).toBeVisible();
    await expect(page.getByTestId("pin-details-mark-as-posted")).toBeVisible();
  });

  test("pin card View button opens drawer on Preview tab", async ({ page }) => {
    await uploadProductAndGenerate(page, "success");
    await expectGeneratedPins(page);

    // Hover to reveal View button
    const card = page.getByTestId("generated-pin-card").first();
    await card.hover();
    await page.getByTestId("pin-card-view-btn").first().click();

    const drawer = page.getByTestId("pin-details-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("pin-details-preview")).toBeVisible();
  });

  test("failed pin opens drawer with failure UI and retry action", async ({ page }) => {
    await uploadProductAndGenerate(page, "fail");
    await expectFailedPlaceholder(page);
    await page.getByTestId("placeholder-card").first().click();

    const drawer = page.getByTestId("pin-details-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("pin-details-failed-label")).toHaveText("Failed to generate");
    await expect(page.getByTestId("pin-details-retry-pin")).toBeVisible();
    await expect(page.getByTestId("pin-details-error-reason")).toBeVisible();

    await expect(page.getByTestId("asset-picker-modal")).toHaveCount(0);
    await expect(page.locator('[style*="position: fixed"][style*="inset: 0"]').filter({ hasText: "Pin Details" })).toHaveCount(0);
  });

  test("Remix tab edits are isolated — original snapshot not mutated", async ({ page }) => {
    await uploadProductAndGenerate(page, "success");
    await expectGeneratedPins(page);

    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-drawer")).toBeVisible();

    // Open Remix tab and edit the prompt
    await page.getByTestId("pin-details-tab-remix").click();
    const promptArea = page.getByTestId("pin-details-remix-prompt");
    await expect(promptArea).toBeVisible();
    const originalPrompt = await promptArea.inputValue();
    await promptArea.fill("Edited remix prompt");

    // Reset to original — prompt should revert
    await expect(page.getByTestId("pin-details-remix-reset")).toBeVisible();
    await page.getByTestId("pin-details-remix-reset").click();
    await expect(promptArea).toHaveValue(originalPrompt);
  });
});
