import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  addProductViaUpload,
  expectGeneratedPins,
} from "./helpers/studio";

/** Monday-based date inside the current calendar week (Playwright runs in local TZ). */
function planDateInCurrentWeek(dayOffset = 0): string {
  const now = new Date();
  const day = now.getDay();
  const mondayDiff = day === 0 ? -6 : 1 - day;
  const d = new Date(now);
  d.setDate(now.getDate() + mondayDiff + dayOffset);
  return d.toISOString().slice(0, 10);
}

async function generateOnePin(page: import("@playwright/test").Page, prompt: string) {
  await prepareStudioPage(page, { clearStorage: false });
  await gotoStudio(page);
  await addProductViaUpload(page);
  await page.getByTestId("prompt-textarea").fill(prompt);
  await page.getByTestId("generate-btn").click();
  await expectGeneratedPins(page);
}

test.describe("Studio → Weekly Plan handoff", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("__handoff_test_cleared")) return;
      localStorage.clear();
      sessionStorage.setItem("__handoff_test_cleared", "1");
    });
  });

  test("Add to Plan preserves edited metadata in Weekly Plan", async ({ page }) => {
    test.setTimeout(120000);
    const planDate = planDateInCurrentWeek(1);
    await generateOnePin(page, "Cozy bedroom decor handoff test prompt.");

    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-drawer")).toBeVisible();
    await expect(page.getByTestId("pin-details-editor")).toBeVisible();
    await expect(page.getByTestId("pin-details-title")).not.toHaveValue("", { timeout: 15000 });

    const customTitle = "Handoff Test Pin Title";
    const customDesc = "Handoff test description for weekly plan.";
    await page.getByTestId("pin-details-title").fill(customTitle);
    await page.getByTestId("pin-details-description").fill(customDesc);
    await page.getByTestId("pin-details-planned-date").fill(planDate);
    await page.getByTestId("pin-details-add-to-plan").click();
    await expect(page.getByTestId("pin-details-status-badge")).toContainText("Added", { timeout: 10000 });

    await page.goto("/app/plan?category=home-decor", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("weekly-plan-page")).toBeVisible({ timeout: 15000 });

    const scheduledCard = page.getByTestId("scheduled-draft-card").filter({ hasText: customTitle }).first();
    await expect(scheduledCard).toBeVisible({ timeout: 15000 });
    await expect(scheduledCard).toContainText("Ready");

    await scheduledCard.click();
    await expect(page.getByTestId("draft-details-drawer")).toBeVisible();
    await expect(page.getByTestId("draft-edit-title")).toHaveValue(customTitle);
    await expect(page.getByTestId("draft-edit-description")).toHaveValue(customDesc);

    await page.getByTestId("draft-edit-title").fill("");
    await page.getByTestId("draft-edit-save").click();
    await expect(page.getByTestId("draft-details-drawer")).toHaveCount(0);
    await expect(page.getByTestId("scheduled-status-badge").filter({ hasText: "Needs details" }).first()).toBeVisible({ timeout: 10000 });
  });

  test("metadata persists after refresh", async ({ page }) => {
    test.setTimeout(120000);
    const planDate = planDateInCurrentWeek(2);
    await generateOnePin(page, "Persist handoff metadata test.");

    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-drawer")).toBeVisible();
    await expect(page.getByTestId("pin-details-title")).not.toHaveValue("", { timeout: 15000 });
    await page.getByTestId("pin-details-title").fill("Persisted Title");
    await page.getByTestId("pin-details-description").fill("Persisted description for weekly plan.");
    await page.getByTestId("pin-details-planned-date").fill(planDate);
    await page.getByTestId("pin-details-add-to-plan").click();
    await expect(page.getByTestId("pin-details-status-badge")).toContainText("Added", { timeout: 10000 });

    await page.goto("/app/plan?category=home-decor", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("weekly-plan-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("scheduled-draft-card").filter({ hasText: "Persisted Title" }).first()).toBeVisible({ timeout: 15000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("scheduled-draft-card").filter({ hasText: "Persisted Title" }).first()).toBeVisible({ timeout: 15000 });
  });
});
