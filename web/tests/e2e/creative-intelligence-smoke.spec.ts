import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Creative Intelligence — real-browser E2E smoke (Phase A/B/C + WP1/WP2).
 *
 * Exercises the upload→keyword→reference→generate→judge→admin chain in a live dev
 * server to surface runtime problems unit tests can't (DOM wiring, async ordering,
 * persistence). Every external dependency is intercepted at the BROWSER level via
 * page.route so NO application code is changed to accommodate the test.
 *
 * Auth model (matches account-sync.spec.ts):
 *  - E2E_TEST_MODE=true (.env.local) makes src/proxy.ts a no-op → /app/** reachable.
 *  - ENABLE_LOCAL_ADMIN_BYPASS=true (.env.local) → /admin/** reachable as super-admin.
 *  - A fake Supabase SSR session cookie is seeded so the analytics sink
 *    (POST /api/analytics/events → getUserIdFromCookieSession, LOCAL read, no network)
 *    accepts our events and lands them in analytics_events with the fake user id.
 *    The pin-drafts sync bearer still fails server verification (fake token) so the
 *    draft store stays pure-localStorage — exactly the signed-out-ish contract.
 *
 * Mocked routes: /api/studio/upload, /api/ai-copy/analyze, POST /api/reference-candidates,
 * /api/generate, /api/quality-judge, /api/pin-drafts, placehold.co, /api/storage-image.
 * NOT mocked (hit the real server): /api/analytics/events, /admin/creative-intelligence,
 * /api/admin/creative-intelligence/calibration.
 *
 * Run:  PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3000 npx playwright test \
 *         tests/e2e/creative-intelligence-smoke.spec.ts --project=chromium
 */

// ── Fake session (see header) ────────────────────────────────────────────────
const SUPABASE_REF = "jaxteelkecvlozdrdoog";
const AUTH_COOKIE_NAME = `sb-${SUPABASE_REF}-auth-token`;
const FAKE_USER_ID = "e2e00000-0000-4000-8000-0000000000c1";
const FAKE_EMAIL = "creative-intel-smoke@example.com";

function baseOrigin(): string {
  return process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000";
}

function buildFakeSessionCookie(): { name: string; value: string } {
  const session = {
    access_token: "e2e-fake-access-token-ci",
    refresh_token: "e2e-fake-refresh-token-ci",
    token_type: "bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: {
      id: FAKE_USER_ID, aud: "authenticated", role: "authenticated", email: FAKE_EMAIL,
      app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
    },
  };
  const encoded = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return { name: AUTH_COOKIE_NAME, value: `base64-${encoded}` };
}

async function seedFakeSession(context: BrowserContext): Promise<void> {
  const cookie = buildFakeSessionCookie();
  await context.addCookies([{ ...cookie, url: baseOrigin(), sameSite: "Lax" }]);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const TINY_RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const UPLOAD_PUBLIC_URL = "https://placehold.co/600x750/8B5CF6/white?text=Uploaded";

// Generated URLs (order matters — placeholders[i] receives urls[i]).
const GEN_URLS = [
  "https://placehold.co/400x600/EF4444/white?text=Gen0", // → invalid verdict
  "https://placehold.co/400x600/7C3AED/white?text=Gen1", // → ok, overall 92 (Top pick)
  "https://placehold.co/400x600/10B981/white?text=Gen2", // → ok, overall 70
];

const RECOMMENDED_KEYWORDS = ["boho home decor", "woven storage basket", "neutral living room", "rattan accents"];

const REFERENCE_ITEMS = [
  {
    id: "ref-1",
    imageUrl: "https://placehold.co/300x450/7C3AED/white?text=Ref1",
    title: "Cozy neutral living room",
    category: "Home decor",
    reason: "Popular home-decor pin with a similar warm, minimal styling.",
    source: "pinterest",
    sourceUrl: "https://www.pinterest.com/pin/ref-1",
    pinterestUrl: "https://www.pinterest.com/pin/ref-1",
    patternTags: {
      visualFormat: "single_product",
      compositionType: "styled_scene",
      humanPresence: "none",
      textOverlayLevel: "none",
      sceneStyleWords: ["warm", "minimal", "natural light"],
    },
  },
  {
    id: "ref-2",
    imageUrl: "https://placehold.co/300x450/FF4D8D/white?text=Ref2",
    title: "Rattan accents flat lay",
    category: "Home decor",
    reason: "Trending flat-lay composition that fits woven textures.",
    source: "pinterest",
    sourceUrl: "https://www.pinterest.com/pin/ref-2",
    pinterestUrl: "https://www.pinterest.com/pin/ref-2",
    patternTags: {
      visualFormat: "flat_lay",
      compositionType: "flat_lay",
      humanPresence: "none",
      textOverlayLevel: "light",
      sceneStyleWords: ["earthy", "textured"],
    },
  },
];

type MockOpts = {
  keywords?: string[];
  referenceItems?: unknown[];
  analyzeFail?: boolean;
};

/** Judge verdict keyed off the generated image URL. */
function judgeForUrl(imageUrl: string): Record<string, unknown> {
  if (imageUrl.includes("Gen0")) {
    return { ok: true, verdict: "invalid", overall: 22, scores: { safety: 18, realism: 30, artifacts: 15, productPreservation: 25 }, judgeVersion: "qj_v1" };
  }
  if (imageUrl.includes("Gen1")) {
    return { ok: true, verdict: "ok", overall: 92, scores: { safety: 100, realism: 95, artifacts: 90, productPreservation: 92, composition: 90, pinterestFit: 92, sceneFit: 90 }, judgeVersion: "qj_v1" };
  }
  // Gen2 and any other → ok, mid overall
  return { ok: true, verdict: "ok", overall: 70, scores: { safety: 100, realism: 72, artifacts: 70, productPreservation: 70, composition: 68, pinterestFit: 70, sceneFit: 70 }, judgeVersion: "qj_v1" };
}

async function installMocks(page: Page, opts: MockOpts = {}) {
  const keywords = opts.keywords ?? RECOMMENDED_KEYWORDS;
  const refItems = opts.referenceItems ?? REFERENCE_ITEMS;

  // Board image upload → stable hosted URLs.
  await page.route("**/api/studio/upload", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ path: "studio/e2e.png", publicUrl: UPLOAD_PUBLIC_URL, proxyUrl: UPLOAD_PUBLIC_URL }),
    });
  });

  // Image analysis → structured analysis + recommended keywords (drives chips + recs eligibility).
  await page.route("**/api/ai-copy/analyze", async route => {
    if (opts.analyzeFail) {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "provider_down", userMessage: "Analysis unavailable." }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        analysis: {
          imageSummary: "A woven rattan storage basket on a neutral background.",
          visibleObjects: ["basket", "rattan", "handle"],
          colors: ["beige", "brown"],
          style: "minimal",
          ocrText: "",
          category: "home-decor",
          model: "gemini-2.5-flash",
        },
        recommendedKeywords: keywords,
        timingsMs: { total: 5 },
      }),
    });
  });

  // Product-aware reference recommendations (POST). GET is left to the real server.
  await page.route("**/api/reference-candidates", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: refItems, itemCount: (refItems as unknown[]).length, source: "reference_candidates_product_aware" }),
    });
  });

  // Image generation → placeholder URLs (external generator is not running locally).
  await page.route("**/api/generate", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, urls: GEN_URLS }) });
  });

  // Quality judge → per-image verdicts (controls invalid + Top-pick behaviour).
  await page.route("**/api/quality-judge", async route => {
    let imageUrl = "";
    try { imageUrl = (route.request().postDataJSON() as { imageUrl?: string })?.imageUrl ?? ""; } catch { /* ignore */ }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(judgeForUrl(imageUrl)) });
  });

  // Pin-draft sync: keep it inert so the store stays pure-localStorage (no clobber).
  await page.route("**/api/pin-drafts**", async route => {
    const m = route.request().method();
    if (m === "GET") { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [] }) }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  // Image hosts → tiny PNG so nothing 404s / hangs on decode.
  await page.route("https://placehold.co/**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });
  await page.route("**/api/storage-image**", async route => {
    await route.fulfill({ status: 200, contentType: "image/png", body: TINY_RED_PNG });
  });
}

const SHOT_DIR = "artifacts/creative-intelligence-smoke";

async function gotoFreshStudio(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 20_000 });
  // Start from a clean board, then reload so the store re-hydrates empty.
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 20_000 });
}

async function uploadImage(page: Page) {
  const input = page.getByTestId("board-upload-input");
  await expect(input).toHaveCount(1, { timeout: 15_000 });
  await input.setInputFiles({ name: "product.png", mimeType: "image/png", buffer: TINY_RED_PNG });
  await expect(page.getByTestId("pin-board-card").first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Deterministically flush the analytics beacon buffer before the context is torn
 * down. analytics.ts flushes on `visibilitychange → hidden` and `pagehide`; Playwright's
 * context.close() does not reliably fire those, so events emitted in the last ~2s
 * (the flush debounce window) would otherwise be lost. Dispatching them here both
 * flushes the buffer AND exercises the real lifecycle-flush path.
 */
async function flushAnalytics(page: Page) {
  // Await the beacon's actual network response before returning, so context teardown
  // can't kill the browser mid-send (a fixed sleep races the socket).
  const settled = page
    .waitForResponse(r => r.url().includes("/api/analytics/events"), { timeout: 5_000 })
    .catch(() => null);
  await page.evaluate(() => {
    try {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    } catch { /* ignore */ }
  });
  await settled;
  await page.waitForTimeout(300);
}

/** Open the AI Image drawer for the first (uploaded) card. */
async function openAiDrawer(page: Page) {
  const card = page.getByTestId("pin-board-card").first();
  await card.getByTestId("card-edit").click();
  await expect(page.getByTestId("card-generate-ai-image")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("card-generate-ai-image").click();
  await expect(page.getByTestId("ai-version-drawer")).toBeVisible({ timeout: 10_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
test.beforeEach(async ({ context }) => {
  await seedFakeSession(context);
});

// A. Upload → keyword chips → copy → remove
test("A: upload produces keyword chips with copy + remove", async ({ page }) => {
  await installMocks(page);
  await gotoFreshStudio(page);
  await uploadImage(page);

  const card = page.getByTestId("pin-board-card").first();
  const chips = card.getByTestId("card-keyword-chips");
  await expect(chips).toBeVisible({ timeout: 20_000 });

  const chip = card.getByTestId("card-keyword-chip");
  await expect.poll(async () => chip.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const initialCount = await chip.count();
  await page.screenshot({ path: `${SHOT_DIR}/A1-keyword-chips.png`, fullPage: false });

  // Copy feedback.
  await chip.first().click();
  await expect(card.getByText("Copied", { exact: true })).toBeVisible({ timeout: 5_000 });

  // Hover → × → remove. (Wait out the 1.2s "Copied" flash so the × is present.)
  await expect(card.getByText("Copied", { exact: true })).toHaveCount(0, { timeout: 4_000 });
  const target = chip.nth(1);
  await target.hover();
  const removeBtn = target.getByTestId("card-keyword-remove");
  await expect(removeBtn).toBeVisible({ timeout: 5_000 });
  await removeBtn.click();
  await expect.poll(async () => chip.count(), { timeout: 5_000 }).toBe(initialCount - 1);
  await page.screenshot({ path: `${SHOT_DIR}/A2-after-remove.png`, fullPage: false });
  await flushAnalytics(page);
});

// B. AI Image Drawer — creative directions + recommended references
test("B: AI drawer shows directions and recommended references", async ({ page }) => {
  await installMocks(page);
  await gotoFreshStudio(page);
  await uploadImage(page);

  // Wait for analysis-ready (keyword chips are the visible proxy) so recs are eligible.
  await expect(page.getByTestId("card-keyword-chips").first()).toBeVisible({ timeout: 20_000 });

  await openAiDrawer(page);

  // Creative directions render and are selectable.
  const directionsSection = page.locator("section", { has: page.getByRole("heading", { name: "Recommended directions" }) });
  const directionBtn = directionsSection.getByRole("button");
  await expect(directionBtn.first()).toBeVisible({ timeout: 10_000 });
  await directionBtn.nth(1).click(); // select a non-default direction — must not error

  // Recommended references group.
  const recs = page.getByTestId("recommended-references");
  await expect(recs).toBeVisible({ timeout: 10_000 });
  await expect(recs.getByText("Recommended for this product")).toBeVisible();
  const recCards = page.getByTestId("recommended-reference-card");
  await expect.poll(async () => recCards.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect(recCards.first().getByText("Pinterest", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/B1-recommended-refs.png`, fullPage: false });

  // Select a recommendation → Style cues + linkback appear.
  await recCards.first().getByRole("button").first().click();
  await expect(page.getByTestId("reference-style-cues").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Style cues used:").first()).toBeVisible();
  await expect(recCards.first().getByRole("link", { name: /View on Pinterest/i })).toHaveAttribute("href", /pinterest\.com/);
  await page.screenshot({ path: `${SHOT_DIR}/B2-style-cues.png`, fullPage: false });
  await flushAnalytics(page);
});

// B-empty. No reference data → the group must NOT render an empty shell.
test("B-empty: no reference data renders no empty shell", async ({ page }) => {
  await installMocks(page, { referenceItems: [] });
  await gotoFreshStudio(page);
  await uploadImage(page);
  await expect(page.getByTestId("card-keyword-chips").first()).toBeVisible({ timeout: 20_000 });
  await openAiDrawer(page);
  // Drawer is up; directions render but the recommended-references section is absent.
  await expect(page.getByRole("heading", { name: "Recommended directions" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("recommended-references")).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/B3-empty-recs.png`, fullPage: false });
});

// C. Generate → judge → card behaviours (invalid hide + Show anyway + Top pick)
test("C: generate, judge, quality-hide + Top pick", async ({ page }) => {
  await installMocks(page);
  await gotoFreshStudio(page);
  await uploadImage(page);
  await expect(page.getByTestId("card-keyword-chips").first()).toBeVisible({ timeout: 20_000 });

  await openAiDrawer(page);
  await page.getByTestId("ai-version-count").selectOption("3");
  await expect(page.getByTestId("ai-version-generate")).toBeEnabled();
  await page.getByTestId("ai-version-generate").click();

  // Drawer closes; generated cards materialise (original upload + 3 generated).
  await expect(page.getByTestId("ai-version-drawer")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => page.getByTestId("pin-board-card").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);

  // Exactly one card is hidden by the invalid verdict.
  const hidden = page.getByTestId("card-quality-hidden");
  await expect(hidden.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Didn't meet the quality bar").first()).toBeVisible();
  await expect.poll(async () => hidden.count(), { timeout: 10_000 }).toBe(1);
  await page.screenshot({ path: `${SHOT_DIR}/C1-quality-hidden.png`, fullPage: false });

  // Show anyway → overlay clears.
  await page.getByTestId("card-show-anyway").first().click();
  await expect(page.getByTestId("card-quality-hidden")).toHaveCount(0, { timeout: 5_000 });

  // Exactly one Top pick badge (the overall-92 card).
  const topPick = page.getByTestId("card-top-pick");
  await expect(topPick.first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => topPick.count(), { timeout: 5_000 }).toBe(1);
  await page.screenshot({ path: `${SHOT_DIR}/C2-top-pick.png`, fullPage: false });
  await flushAnalytics(page);
});

// D. Admin creative-intelligence page renders + calibration section present.
test("D: admin creative-intelligence renders", async ({ page }) => {
  await installMocks(page);
  await page.goto("/admin/creative-intelligence", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page).not.toHaveURL(/\/login|admin=forbidden/);
  await expect(page.getByRole("heading", { name: "Creative Intelligence", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Creative funnel (event counts)")).toBeVisible();

  // Funnel event cards render with numeric counts.
  const funnelNums = page.locator("p.tabular-nums");
  await expect.poll(async () => funnelNums.count(), { timeout: 10_000 }).toBeGreaterThan(0);

  // Judge calibration section is present (Agree/Disagree UI, data-dependent).
  await expect(page.getByRole("heading", { name: "Judge calibration" })).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/D1-admin-page.png`, fullPage: true });

  // If real DB-backed judged drafts exist, exercise Agree → Recorded. Otherwise note-only.
  const agree = page.getByRole("button", { name: "Agree" });
  if (await agree.count() > 0) {
    await agree.first().click();
    await expect(page.getByText(/Recorded agree/i).first()).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: `${SHOT_DIR}/D2-calibration-recorded.png`, fullPage: false });
  }
});

// E. Persistence across reload (localStorage-backed store).
test("E: keyword removal persists across reload", async ({ page }) => {
  await installMocks(page);
  await gotoFreshStudio(page);
  await uploadImage(page);

  const card = page.getByTestId("pin-board-card").first();
  await expect(card.getByTestId("card-keyword-chips")).toBeVisible({ timeout: 20_000 });
  const chip = card.getByTestId("card-keyword-chip");
  const before = await chip.count();
  expect(before).toBeGreaterThanOrEqual(2);

  const removedText = (await chip.nth(1).innerText()).trim();
  await chip.nth(1).hover();
  await card.getByTestId("card-keyword-remove").click();
  await expect.poll(async () => chip.count(), { timeout: 5_000 }).toBe(before - 1);

  // Reload — NO storage clear here; the draft must re-hydrate from localStorage.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("studio-board")).toBeVisible({ timeout: 20_000 });
  const card2 = page.getByTestId("pin-board-card").first();
  const chips2 = card2.getByTestId("card-keyword-chip");
  await expect.poll(async () => chips2.count(), { timeout: 15_000 }).toBe(before - 1);
  await expect(card2.getByText(removedText, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/E1-persisted.png`, fullPage: false });
});
