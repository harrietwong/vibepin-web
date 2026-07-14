import { expect, type Locator, type Page } from "@playwright/test";

export const SUPABASE_URL = "https://jaxteelkecvlozdrdoog.supabase.co";

export const TINY_RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const MOCK_PRODUCT_ROWS = [
  {
    id: "p1",
    product_name: "Wicker Storage Basket",
    image_url: "https://placehold.co/300x300/8B5CF6/white?text=Product+1",
    seed_keyword: "home decor",
    save_count: 100,
    source_pin_save_count: 80,
    source_url: "https://shop.example.com/basket",
    domain: "shop.example.com",
    price: 29,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 82,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p2",
    product_name: "Vanilla Bean Candle",
    image_url: "https://placehold.co/300x300/D946EF/white?text=Product+2",
    seed_keyword: "home decor",
    save_count: 90,
    source_pin_save_count: 70,
    source_url: "https://shop.example.com/candle",
    domain: "shop.example.com",
    price: 18,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 75,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p3",
    product_name: "Ceramic Floral Mug",
    image_url: "https://placehold.co/300x300/7C3AED/white?text=Product+3",
    seed_keyword: "home decor",
    save_count: 86,
    source_pin_save_count: 61,
    source_url: "https://shop.example.com/mug",
    domain: "shop.example.com",
    price: 16,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 73,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p4",
    product_name: "Olive Green Bedding Set",
    image_url: "https://placehold.co/300x300/FF4D8D/white?text=Product+4",
    seed_keyword: "home decor",
    save_count: 82,
    source_pin_save_count: 60,
    source_url: "https://shop.example.com/bedding",
    domain: "shop.example.com",
    price: 72,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 70,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p5",
    product_name: "Minimalist Line Art Print",
    image_url: "https://placehold.co/300x300/4ADE80/white?text=Product+5",
    seed_keyword: "home decor",
    save_count: 78,
    source_pin_save_count: 55,
    source_url: "https://shop.example.com/print",
    domain: "shop.example.com",
    price: 24,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 68,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
  {
    id: "p6",
    product_name: "Wavy Edge Mirror",
    image_url: "https://placehold.co/300x300/60A5FA/white?text=Product+6",
    seed_keyword: "home decor",
    save_count: 74,
    source_pin_save_count: 52,
    source_url: "https://shop.example.com/mirror",
    domain: "shop.example.com",
    price: 49,
    currency: "USD",
    merchant: "Shop",
    scraped_at: null,
    opportunity_score: 66,
    trend_score: null,
    save_velocity_score: null,
    item_type: "product",
  },
];

export const MOCK_PIN_ROWS = [
  { id: "r1", image_url: "https://placehold.co/300x450/7C3AED/white?text=Pin+1", save_count: 1200, source_keyword: "home decor" },
  { id: "r2", image_url: "https://placehold.co/300x450/FF4D8D/white?text=Pin+2", save_count: 900, source_keyword: "fashion" },
];

export const DEFAULT_GENERATED_URLS = [
  "https://placehold.co/400x600/FF4D8D/white?text=Pin+1",
  "https://placehold.co/400x600/7C3AED/white?text=Pin+2",
];

export type StudioMockOptions = {
  generateMode?: "success" | "fail";
  generateUrls?: string[];
  /** Clear localStorage/sessionStorage on each navigation (default true). */
  clearStorage?: boolean;
};

async function pickerSelectedCount(page: Page): Promise<number> {
  const text = await page.getByTestId("asset-picker-selected-count").textContent() ?? "";
  const match = text.match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function setupStudioMocks(page: Page, opts: StudioMockOptions = {}) {
  const { generateMode = "success", generateUrls = DEFAULT_GENERATED_URLS } = opts;
  const lastUpdatedAt = new Date().toISOString();

  await page.route("**/api/products/top**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: MOCK_PRODUCT_ROWS,
        data: MOCK_PRODUCT_ROWS,
        itemCount: MOCK_PRODUCT_ROWS.length,
        source: "product_ideas_api",
        lastUpdatedAt,
      }),
    });
  });

  await page.route("**/api/viral-pins**", async route => {
    const pinItems = MOCK_PIN_ROWS.map(r => ({
      ...r,
      title: r.source_keyword,
      category: r.source_keyword?.includes("fashion") ? "fashion" : "home-decor",
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: pinItems,
        data: pinItems,
        itemCount: pinItems.length,
        source: "pin_ideas_api",
        lastUpdatedAt,
        count: MOCK_PIN_ROWS.length,
        limit: 160,
        offset: 0,
      }),
    });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/**`, async route => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/trend_keywords*`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ keyword: "home decor", category: "home-decor" }]),
    });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/keyword_expansions*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/pin_products*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PRODUCT_ROWS) });
  });

  await page.route(`${SUPABASE_URL}/rest/v1/pin_samples*`, async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PIN_ROWS) });
  });

  await page.route("**/api/generate", async route => {
    if (generateMode === "fail") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Model timeout" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, urls: generateUrls }),
    });
  });

  // Board-v2 upload endpoint (POST /api/studio/upload) — required by uploadBoardImage()
  // / StudioBoard's handleFiles. Same shape as creative-intelligence-smoke.spec.ts.
  await page.route("**/api/studio/upload", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "studio/e2e.png", publicUrl: "https://placehold.co/600x750/8B5CF6/white?text=Uploaded", proxyUrl: "https://placehold.co/600x750/8B5CF6/white?text=Uploaded" }),
    });
  });

  // Background image analysis kicked off after upload/generation (fire-and-forget in
  // app code, but left unmocked it would hit the real backend during tests).
  await page.route("**/api/ai-copy/analyze", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, analysis: { imageSummary: "", visibleObjects: [], colors: [], style: "", ocrText: "", category: "home-decor" }, recommendedKeywords: [], timingsMs: { total: 1 } }),
    });
  });

  // Quality judge kicked off after AI generation (fire-and-forget).
  await page.route("**/api/quality-judge", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, verdict: "ok", overall: 80, scores: { safety: 100, realism: 80, artifacts: 80, productPreservation: 80 }, judgeVersion: "qj_v1" }),
    });
  });

  // Pin-draft server sync (pinDraftSync.ts) runs on startup/reload. Without a real
  // authenticated session this would otherwise hit the live endpoint; keep it inert
  // so the store stays pure-localStorage during tests (matches
  // creative-intelligence-smoke.spec.ts's installMocks).
  await page.route("**/api/pin-drafts**", async route => {
    const m = route.request().method();
    if (m === "GET") { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [] }) }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  // Pinterest connection status + boards — usePinterestBoards() gates Schedule/
  // Publish readiness (noBoardAccess). Without this the real endpoint 401s (no
  // authenticated session in tests) and every card stays "disconnected", so Schedule
  // never succeeds. Matches scripts/qa-prd-workflow-v1.ts's mock shape.
  await page.route("**/api/pinterest/status**", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      connected: true, account: { id: "e2e", username: "e2e-user", accountType: "BUSINESS" },
      scopes: ["boards:read", "pins:read", "pins:write", "boards:write", "user_accounts:read"],
      needsReconnect: false, lastSyncedAt: null, connectionSource: "db", apiEnv: "sandbox", environment: "sandbox",
    }) });
  });
  await page.route("**/api/pinterest/boards**", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      items: [{ id: "b1", name: "Home Decor" }], bookmark: null,
    }) });
  });

  await page.route("**/api/history-storage", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) });
  });

  await page.route("**/api/storage-image**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });

  await page.route("https://placehold.co/**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });
}

export async function prepareStudioPage(page: Page, opts: StudioMockOptions = {}) {
  const { clearStorage = true, ...mockOpts } = opts;
  await setupStudioMocks(page, mockOpts);
  if (clearStorage) {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  }
}

/**
 * Board-v2 landing check. Legacy composer testids (composer-panel, generate-btn,
 * generation-feed, add-product-images, studio-interactive) do not exist in board-v2
 * — the whole page is a single `studio-board` root (StudioBoard.tsx). Callers that
 * need a guaranteed-empty board should follow this with an explicit localStorage
 * clear + reload (see creative-intelligence-smoke.spec.ts's gotoFreshStudio pattern).
 */
export async function gotoStudio(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 20_000 });
}

/**
 * Board-v2 has no page-level product/reference picker entry point. The SAME picker
 * component (InlineCreateAssetPicker — product-picker/reference-picker, picker-tab-*,
 * compact-upload-*, compact-import-url, asset-picker-* testids all unchanged) now
 * lives inside the "Generate AI Image" drawer (AiVersionDrawer), reached via a
 * card's `card-generate-ai-image` action (after expanding via `card-edit`) or the
 * empty board's `board-create-with-ai`. Callers must open/have open an AiVersionDrawer
 * before calling these.
 */
export async function openProductPicker(page: Page): Promise<Locator> {
  const btn = page.getByTestId("ai-version-add-product");
  await btn.scrollIntoViewIfNeeded();
  await expect(btn).toBeVisible();
  await btn.click();

  const panel = page.getByTestId("product-picker");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("picker-tab-my_products")).toBeVisible();
  await expect(page.getByTestId("compact-upload-product")).toBeVisible({ timeout: 10000 });
  return panel;
}

export async function openReferencePicker(page: Page): Promise<Locator> {
  const btn = page.getByTestId("ai-version-add-reference");
  await btn.scrollIntoViewIfNeeded();
  await expect(btn).toBeVisible();
  await btn.click();

  const panel = page.getByTestId("reference-picker");
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("picker-tab-my_references")).toBeVisible();
  return panel;
}

/** Opens the AiVersionDrawer in "scratch" mode from an empty board. */
export async function openCreateWithAi(page: Page) {
  await page.getByTestId("board-create-with-ai").click();
  await expect(page.getByTestId("ai-version-drawer")).toBeVisible({ timeout: 10_000 });
}

/** Opens the AiVersionDrawer ("Generate AI Image") for an existing board card. */
export async function openAiDrawerForCard(page: Page, card: Locator) {
  await card.getByTestId("card-edit").click();
  await expect(card.getByTestId("card-generate-ai-image")).toBeVisible({ timeout: 10_000 });
  await card.getByTestId("card-generate-ai-image").click();
  await expect(page.getByTestId("ai-version-drawer")).toBeVisible({ timeout: 10_000 });
}

export async function uploadProductInPicker(page: Page, panel?: Locator, buffer: Buffer = TINY_RED_PNG) {
  const picker = panel ?? page.getByTestId("product-picker");
  const before = await pickerSelectedCount(page);
  const fileInput = picker.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1, { timeout: 10000 });
  await fileInput.setInputFiles({
    name: "product.png",
    mimeType: "image/png",
    buffer,
  });
  await expect.poll(async () => pickerSelectedCount(page), { timeout: 10000 }).toBe(before + 1);
}

export async function confirmAssetPicker(page: Page) {
  const confirm = page.getByTestId("asset-picker-confirm");
  await expect(confirm).toBeEnabled({ timeout: 10000 });
  await confirm.click();
}

export async function uploadReferenceInPicker(page: Page, panel?: Locator, buffer: Buffer = TINY_RED_PNG) {
  const picker = panel ?? page.getByTestId("reference-picker");
  const before = await pickerSelectedCount(page);
  const fileInput = picker.locator('input[type="file"]');
  await expect(fileInput).toHaveCount(1, { timeout: 10000 });
  await fileInput.setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer,
  });
  await expect.poll(async () => pickerSelectedCount(page), { timeout: 10000 }).toBe(before + 1);
}

/**
 * Board-v2: uploading a product image creates a full board card directly (no
 * page-level "selected-products" pool/count). Uses the real upload input
 * (`board-upload-input`), matching creative-intelligence-smoke.spec.ts's proven
 * pattern. Requires `**\/api/studio/upload` to be mocked (see StudioMockOptions
 * callers / installMocks in that smoke spec) — prepareStudioPage() alone does not
 * mock it.
 */
export async function uploadBoardImage(page: Page, buffer: Buffer = TINY_RED_PNG, filename = "product.png") {
  const before = await page.getByTestId("pin-board-card").count();
  const input = page.getByTestId("board-upload-input");
  await expect(input).toHaveCount(1, { timeout: 10000 });
  await input.setInputFiles({ name: filename, mimeType: "image/png", buffer });
  await expect.poll(async () => page.getByTestId("pin-board-card").count(), { timeout: 20000 }).toBe(before + 1);
}

/** @deprecated Board-v2 has no page-level product pool. Use uploadBoardImage(). */
export async function addProductViaUpload(page: Page) {
  await uploadBoardImage(page);
}

/** @deprecated Board-v2 has no page-level reference pool; references are selected
 * per-generation inside the AI drawer (openReferencePicker). No standalone
 * page-level equivalent exists. */
export async function addReferenceViaUpload(page: Page, buffer: Buffer = TINY_RED_PNG) {
  void buffer;
  throw new Error("addReferenceViaUpload has no board-v2 equivalent — references are selected per-generation inside AiVersionDrawer (see openReferencePicker + openAiDrawerForCard).");
}

/**
 * Board-v2 generation flow: upload a product (creates a card) -> open its AI
 * drawer -> generate. Mirrors creative-intelligence-smoke.spec.ts's proven
 * upload -> openAiDrawer -> generate pattern.
 *
 * NOTE: board-v2's AiVersionDrawer has NO free-text prompt input — the
 * `directionBrief` sent to /api/generate is auto-derived from product/reference
 * analysis and the selected creative direction/tags (see creativeControls.ts);
 * there is no editable textarea testid. The `prompt` param is therefore unused
 * and kept only for call-site compatibility with the old composer-driven signature.
 */
export async function generatePins(
  page: Page,
  prompt: string,
  opts: StudioMockOptions = {},
) {
  void prompt;
  await prepareStudioPage(page, opts);
  await gotoStudio(page);
  await uploadBoardImage(page);
  const card = page.getByTestId("pin-board-card").first();
  await openAiDrawerForCard(page, card);
  await expect(page.getByTestId("ai-version-generate")).toBeEnabled({ timeout: 10000 });
  await page.getByTestId("ai-version-generate").click();
  await expect(page.getByTestId("ai-version-drawer")).toHaveCount(0, { timeout: 10000 });
}

/** Board-v2: generated results land as `pin-board-card` entries on the board
 * (no separate "generated-pin-card" feed). */
export async function expectGeneratedPins(page: Page, min = 1) {
  const cards = page.getByTestId("pin-board-card");
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => cards.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(min);
}

/** Board-v2: a failed generation surfaces as a `pin-board-card` with
 * data-lifecycle="failed" under the Failed board filter (no separate feed tabs /
 * placeholder-card testid). */
export async function expectFailedCard(page: Page) {
  await page.getByTestId("board-filter-failed").click();
  await expect(page.locator('[data-testid="pin-board-card"][data-lifecycle="failed"]').first())
    .toBeVisible({ timeout: 30000 });
}

/** @deprecated kept as an alias so other (out-of-scope) spec files importing the old
 * name still compile. Use expectFailedCard(). */
export const expectFailedPlaceholder = expectFailedCard;

export function pickerTab(page: Page, tabId: "my_products" | "product_ideas" | "my_references" | "pin_ideas") {
  return page.getByTestId(`picker-tab-${tabId}`);
}

export async function waitForProductIdeasGrid(page: Page) {
  await pickerTab(page, "product_ideas").click();
  await expect(page.getByTestId("product-ideas-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("product-idea-skeleton")).toHaveCount(0, { timeout: 15000 });
  const cards = page.getByTestId("product-ideas-grid").getByTestId("asset-card");
  await expect(cards.first()).toBeVisible({ timeout: 15000 });
  return cards;
}

export async function waitForPinIdeasGrid(page: Page) {
  await pickerTab(page, "pin_ideas").click();
  await expect(page.getByTestId("pin-ideas-grid")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pin-ideas-grid").getByTestId("asset-card").first()).toBeVisible({ timeout: 15000 });
  return page.getByTestId("pin-ideas-grid").getByTestId("asset-card");
}
