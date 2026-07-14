import { test, expect, type Page } from "@playwright/test";

/**
 * Create Pins initial-state UI — Studio Board V2 (upload-first empty state, board
 * filter tabs). Repointed from the retired legacy composer (studio-interactive /
 * generate-btn) to the shipping board UI (studio-board / board-empty / board-filters).
 * Run: pnpm test:e2e studio-initial-state.spec.ts
 */

const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

async function setupMocks(page: Page) {
  // Return empty arrays for all Supabase table reads so the picker can render cleanly.
  await page.route(`${SUPABASE_URL}/rest/v1/**`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(`${SUPABASE_URL}/auth/**`, async (route) => { await route.continue(); });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, urls: [] }) });
  });
  await page.route("**/api/history-storage", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
  });
  await page.route("**/api/storage-image**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("") });
  });
}

async function gotoStudio(page: Page) {
  await setupMocks(page);
  await page.goto("/app/studio", { waitUntil: "domcontentloaded" });
  const url = page.url();
  expect(url, "Redirected to login — set E2E_TEST_MODE=true in .env.local and restart dev server")
    .not.toContain("/login");
  await page.waitForSelector('[data-testid="studio-board"]', { timeout: 15000 });
}

test.describe("Create Pins initial state", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("loads without React error", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await gotoStudio(page);
    const reactErrors = errors.filter(e =>
      e.includes("React") || e.includes("Uncaught") || e.includes("Cannot read"),
    );
    expect(reactErrors).toHaveLength(0);
  });

  test("sidebar width is <= 88px", async ({ page }) => {
    await gotoStudio(page);
    const box = await page.getByTestId("app-sidebar").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(88);
  });

  test("page text is English on initial load", async ({ page }) => {
    await gotoStudio(page);
    // Board-v2 has no dedicated page-header testid; the board's own <h1> carries the
    // page title (same "Create Pins" copy the legacy header used).
    await expect(page.getByRole("heading", { name: "Create Pins", level: 1 })).toBeVisible();
    await expect(page.getByText("Drag and drop images here")).toBeVisible();
    await expect(page.getByText("Upload one or more images to create editable Pin drafts.")).toBeVisible();
    await expect(page.getByText("图片")).toHaveCount(0);
    await expect(page.getByText("上传")).toHaveCount(0);
  });

  // Legacy behavior: compact "Add product images" / "Add pin references" entry
  // buttons sat directly on the default composer page and opened an asset picker
  // pre-generation. Board-v2 is upload-first — there is no page-level product/
  // reference picker before a card exists. Product/reference selection now lives
  // inside the per-card "Generate AI Image" drawer (AiVersionDrawer), which requires
  // an existing (or scratch) draft to open. No board-v2 equivalent at page level.
  test.skip("compact product and reference entry buttons", async () => {});

  // Legacy behavior: default page intentionally had NO large dropzone (compact
  // entry buttons only); a big dropzone only lived inside the picker modal. Board-v2
  // inverts this by design — the default/empty state IS a large drag-and-drop upload
  // zone (`board-empty`, PRD "upload-first"). Asserting "no large dropzone" would
  // directly contradict the shipping empty-state design, not just use a new selector.
  test.skip("no large dropzone or separate Upload/Browse buttons on default page", async () => {});

  // Legacy behavior: "Add product images" opened a page-level Product Images picker
  // pre-generation. Board-v2 has no such top-level entry point — product selection
  // only exists inside a card's AI drawer or the Shopify "Select product" flow.
  test.skip("clicking Add product images opens Product Images picker", async () => {});

  // Legacy behavior: "Add pin references" opened a page-level Pin References picker
  // pre-generation. Board-v2 has no such top-level entry point — reference selection
  // only exists inside a card's AI drawer (AiVersionDrawer's InlineCreateAssetPicker).
  test.skip("clicking Add pin references opens Pin References picker", async () => {});

  test("board shows empty upload-first state without any cards", async ({ page }) => {
    await gotoStudio(page);
    await expect(page.getByTestId("board-empty")).toBeVisible();
    await expect(page.getByTestId("pin-board-card")).toHaveCount(0);
    await expect(page.getByTestId("board-upload-primary")).toBeVisible();
    await expect(page.getByTestId("board-create-with-ai")).toBeVisible();
  });

  test("board shows filter tabs", async ({ page }) => {
    await gotoStudio(page);
    await expect(page.getByTestId("board-filters")).toBeVisible();
    for (const tab of ["all", "unscheduled", "scheduled", "posted", "failed"]) {
      await expect(page.getByTestId(`board-filter-${tab}`)).toBeVisible();
    }
  });
});
