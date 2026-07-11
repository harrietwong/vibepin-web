import { test, expect } from "@playwright/test";
import {
  prepareStudioPage,
  gotoStudio,
  expectGeneratedPins,
} from "./helpers/studio";

const PRODUCT_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const REFERENCE_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

test.describe("Studio setup snapshot recovery", () => {
  test("refresh keeps generated setup recoverable in Remix", async ({ page }) => {
    await prepareStudioPage(page, {
      generateMode: "success",
      generateUrls: [
        "https://placehold.co/400x600/FF4D8D/white?text=Recovered+Pin+1",
        "https://placehold.co/400x600/7C3AED/white?text=Recovered+Pin+2",
      ],
      clearStorage: false,
    });
    await page.addInitScript(({ productImg, referenceImg }) => {
      const seeded = sessionStorage.getItem("studio_recovery_seeded") === "1";
      if (!seeded) {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem("studio_recovery_seeded", "1");
      }
      localStorage.setItem("vibepin_composer_v1", JSON.stringify({
        products: [productImg],
        refs: [referenceImg],
        prompt: "Fashion street-style product pin with strong reference-led composition.",
        count: 2,
        variationMode: "distinct",
      }));
    }, { productImg: PRODUCT_IMG, referenceImg: REFERENCE_IMG });
    await gotoStudio(page);

    await expect(page.getByTestId("selected-products").locator("img")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("selected-refs").locator("img")).toHaveCount(1, { timeout: 10_000 });
    const generateResponse = page.waitForResponse(resp =>
      resp.url().includes("/api/generate") && resp.request().method() === "POST",
      { timeout: 10_000 },
    );
    await page.getByTestId("generate-btn").click();
    const response = await generateResponse;
    await expect(response.ok()).toBeTruthy();
    const generateBody = await response.json() as { ok?: boolean; urls?: string[]; error?: string };
    await expect(generateBody.ok, generateBody.error ?? JSON.stringify(generateBody)).toBeTruthy();
    await expect(generateBody.urls?.length ?? 0).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => page.evaluate(() => {
      const raw = localStorage.getItem("vp:studio:history");
      if (!raw) return "missing";
      const parsed = JSON.parse(raw) as Array<{ groups?: Array<{ images?: string[] }> }>;
      return parsed.reduce((sum, entry) => sum + (entry.groups ?? []).reduce((gSum, group) => gSum + (group.images?.length ?? 0), 0), 0);
    }), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expectGeneratedPins(page, 2);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("generation-feed")).toBeVisible({ timeout: 20_000 });
    await expectGeneratedPins(page, 2);

    await page.getByTestId("generated-pin-card").first().click();
    await expect(page.getByTestId("pin-details-drawer")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("pin-details-tab-remix").click();

    await expect(page.getByText("Original setup wasn’t saved")).toHaveCount(0);
    await expect(page.getByTestId("pin-details-setup-products").locator("img")).toHaveCount(1);
    await expect(page.getByTestId("pin-details-setup-references").locator("img")).toHaveCount(1);
    await expect(page.getByTestId("pin-details-remix-prompt")).not.toHaveValue("");
    await expect(page.getByTestId("pin-details-setup-settings")).toContainText(/2/);
    await expect(page.getByTestId("pin-details-setup-settings")).toContainText(/GPT Image|GPT/i);
  });
});
