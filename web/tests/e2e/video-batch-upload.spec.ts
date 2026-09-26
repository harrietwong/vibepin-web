import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const VIDEO = readFileSync(path.join(__dirname, "fixtures", "video-fixture.mp4"));
const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const TEST_USER_ID = "988ca85e-923b-4771-840f-d5c0520c6d88";
const TEST_WORKSPACE = "default";

type VideoMockOptions = {
  failFinalizeCall?: number;
  hangUpload?: boolean;
  appearanceTheme?: "dark" | "light";
};

type VideoMockState = {
  options: VideoMockOptions;
  prepareCalls: number[];
  finalizeCalls: number[];
  uploadCalls: number[];
};

function fakeSession(appearanceTheme: "dark" | "light" = "dark") {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const user = {
    id: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "video-e2e@vibepin.test",
    user_metadata: { appearanceTheme },
    app_metadata: { provider: "email", providers: ["email"] },
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: TEST_USER_ID, user_metadata: user.user_metadata, role: "authenticated", exp: 4102444800 })}.e2e`;
  return {
    access_token: token,
    refresh_token: "e2e-refresh-token",
    expires_in: 3600,
    expires_at: 4102444800,
    token_type: "bearer",
    user,
  };
}

async function installAuthAndIsolation(page: Page, appearanceTheme: "dark" | "light" = "dark") {
  const baseOrigin = new URL(process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000").origin;
  const session = fakeSession(appearanceTheme);
  // @supabase/ssr uses chunkable base64url cookies in browser clients. Seed the
  // real storage contract before navigation so useSessionUser can bind the
  // owner-scoped Pin Draft store; localStorage alone only covers legacy clients.
  await page.context().addCookies([{
    name: "sb-127-auth-token",
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
    url: baseOrigin,
  }]);
  // getSession() is intentionally local-only in the app. Return a deterministic
  // test session for any Supabase storage key without creating a real auth user.
  await page.addInitScript((session) => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      const value = originalGetItem.call(this, key);
      if (!value && key.includes("auth-token")) return JSON.stringify(session);
      return value;
    };
    localStorage.setItem("vp:appearance_theme:v1", session.user.user_metadata.appearanceTheme);
  }, session);

  // This is the last-resort network fence: any provider, CDN, Pinterest, AI, or
  // unmocked external request fails immediately and can never leave the machine.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseOrigin) {
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const body = url.pathname === "/api/pin-drafts"
        ? { drafts: [], nextCursor: null }
        : url.pathname === "/api/user-store"
          ? { items: [], nextCursor: null }
          : { ok: true, items: [], data: [] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    await route.continue();
  });

  // Auth and REST are mocked even if the app was built with a real Supabase URL.
  await page.route("**/auth/v1/**", async (route) => {
    const request = route.request();
    if (request.url().includes("/user")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeSession(appearanceTheme).user) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
    }
  });
  await page.route("**/rest/v1/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

async function installVideoMocks(page: Page, options: VideoMockOptions = {}): Promise<VideoMockState> {
  const state: VideoMockState = { options, prepareCalls: [], finalizeCalls: [], uploadCalls: [] };
  await installAuthAndIsolation(page, options.appearanceTheme);

  await page.route("**/api/studio/video-upload/prepare", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { files?: Array<{ ordinal?: number }> };
    const ordinal = Number(body.files?.[0]?.ordinal ?? 0);
    state.prepareCalls.push(ordinal);
    const pathName = `${TEST_USER_ID}/videos/e2e/${ordinal}.mp4`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: `e2e_batch_${state.prepareCalls.length}`,
        requestId: `prepare_${state.prepareCalls.length}`,
        uploads: [{
          ordinal,
          path: pathName,
          token: `token_${ordinal}`,
          signedUrl: `https://e2e-video-storage.invalid/object/upload/sign/generated-private/${pathName}?token=token_${ordinal}`,
          contentType: "video/mp4",
          upsert: false,
        }],
      }),
    });
  });

  await page.route("**/object/upload/sign/**", async (route) => {
    const ordinal = Number(route.request().url().match(/videos\/e2e\/(\d+)\./)?.[1] ?? 0);
    state.uploadCalls.push(ordinal);
    if (options.hangUpload) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    } catch {
      // Cancellation aborts the browser request while this deterministic delay is
      // still pending; the aborted route is an expected part of this test.
    }
  });

  await page.route("**/api/studio/video-upload/finalize", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { ordinal?: number };
    const ordinal = Number(body.ordinal ?? 0);
    state.finalizeCalls.push(ordinal);
    if (options.failFinalizeCall === state.finalizeCalls.length) {
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "video_upload_failed" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, batchId: `e2e_batch_${state.finalizeCalls.length}`, ordinal, proxyUrl: `/api/storage-media?path=${TEST_USER_ID}/videos/e2e/${ordinal}.mp4`, requestId: `finalize_${state.finalizeCalls.length}` }),
    });
  });

  await page.route("**/api/studio/upload", async (route) => {
    const pathName = `studio/uploads/${TEST_USER_ID}/e2e.jpg`;
    const proxyUrl = `/api/storage-image?path=${encodeURIComponent(pathName)}`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, path: pathName, publicUrl: proxyUrl, proxyUrl, requestId: "poster_upload" }) });
  });
  await page.route("**/api/studio/upload/poster-operation", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/studio/upload/cleanup", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/storage-media**", async (route) => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
    await route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", body: VIDEO.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${VIDEO.length}` } : {}) } });
  });
  await page.route("**/api/storage-image**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: IMAGE });
  });
  return state;
}

async function gotoStudio(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  // The upload input is the actual interaction boundary. The page-level
  // `studio-interactive` marker is a dev-only post-effect signal and can lag behind
  // hydration while webpack is compiling the very large Studio bundle.
  await expect(page.getByTestId("board-upload-input")).toBeAttached({ timeout: 45_000 });
  // Video upload is owner-scoped. Wait for the authenticated app shell to bind the
  // Pin Draft store; seeing the SSR upload input alone is not sufficient.
  await expect.poll(
    () => page.evaluate(() => localStorage.getItem("vp:pin_drafts:v2:legacy_migrated")),
    { timeout: 20_000 },
  ).toBe("1");
}

async function requireVideoFlag(page: Page) {
  const accept = await page.getByTestId("board-upload-input").getAttribute("accept");
  test.skip(!accept?.includes("video/mp4"), "video flag is off; run the flag-off fallback test in this server configuration");
}

function video(name: string) {
  return { name, mimeType: "video/mp4", buffer: VIDEO };
}

// Video uploads render as placeholder cards in the board grid (no top-of-page panel).
const UPLOAD_PLACEHOLDERS = '[data-testid^="video-upload-item-"]';
const RETRY_BUTTONS = `${UPLOAD_PLACEHOLDERS} [data-testid^="video-upload-retry-"]`;
const CANCEL_BUTTONS = `${UPLOAD_PLACEHOLDERS} [data-testid^="video-upload-cancel-"]`;

test.describe("video batch upload (fully mocked)", () => {
  test.describe.configure({ timeout: 90_000 });

  test("cover frame dialog cancels without mutation and confirms a captured replacement", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("cover.mp4")]);
    const card = page.getByTestId("pin-board-card");
    await expect(card).toHaveCount(1, { timeout: 30000 });
    const readCover = () => page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) => key.startsWith("vp:pin_drafts:v2:") && !key.includes("migrated"));
      return entry ? Object.values(JSON.parse(entry[1]).drafts)[0] as { imageUrl: string; media: Array<{ posterUrl?: string; coverFrameTimeMs?: number }> } : null;
    });
    const before = await readCover();
    let replacements = 0;
    let cleanupCalls = 0;
    let failUpload = true;
    await page.route("**/api/studio/upload/cleanup", async route => { cleanupCalls++; await route.fulfill({ status: 200, body: "{}" }); });
    await page.route("**/api/studio/upload", async route => {
      replacements++;
      const body = route.request().postDataBuffer()!.toString("latin1");
      expect(body).not.toContain('name="videoBatchId"');
      expect(body).not.toContain('name="videoOrdinal"');
      if (failUpload) { await route.fulfill({ status: 500, body: '{"code":"upload_failed"}' }); return; }
      const proxyUrl = `/api/storage-image?path=studio%2Fuploads%2F${TEST_USER_ID}%2Fselected.jpg`;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ proxyUrl, publicUrl: proxyUrl, path: `studio/uploads/${TEST_USER_ID}/selected.jpg` }) });
    });
    const choose = card.getByRole("button", { name: "Choose cover frame", exact: true });
    await choose.click();
    const dialog = page.getByRole("dialog", { name: "Choose cover frame", exact: true });
    await expect(dialog).toBeVisible();
    const preview = dialog.locator("video");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty("controls", false);
    await expect(preview).toHaveJSProperty("paused", true);
    await page.evaluate(() => {
      const captured: number[] = [];
      (window as unknown as { coverCaptureTimes: number[] }).coverCaptureTimes = captured;
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
        if (args[0] instanceof HTMLVideoElement) captured.push(args[0].currentTime);
        return Reflect.apply(drawImage, this, args);
      };
    });
    const slider = dialog.getByRole("slider", { name: "Cover frame time" });
    await slider.fill("1250");
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(slider).toHaveValue("1251");
    await expect.poll(() => preview.evaluate(video => (video as HTMLVideoElement).currentTime)).toBe(1.251);
    await slider.press("ArrowLeft");
    await expect(slider).toHaveValue("1250");
    await expect.poll(() => preview.evaluate(video => (video as HTMLVideoElement).currentTime)).toBe(1.25);
    await preview.click();
    await expect(preview).toHaveJSProperty("paused", true);
    expect(await readCover()).toEqual(before);
    expect(replacements).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(choose).toBeFocused();
    expect(await readCover()).toEqual(before);
    await choose.click();
    await slider.fill("1250");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("retry");
    expect(await readCover()).toEqual(before);
    failUpload = false;
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await readCover())!.media[0].coverFrameTimeMs).toBe(1250);
    expect((await readCover())!.imageUrl).toContain("selected.jpg");
    await expect(card.getByTestId("content-media-video").first()).toHaveAttribute("poster", /selected\.jpg/);
    expect(replacements).toBe(2);
    expect(cleanupCalls).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { coverCaptureTimes: number[] }).coverCaptureTimes)).toEqual([1.25, 1.25]);
  });

  test("cover frame dialog unmount during upload preserves the previous cover", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("unmount-cover.mp4")]);
    const card = page.getByTestId("pin-board-card");
    await expect(card).toHaveCount(1, { timeout: 30000 });
    const readCover = () => page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) => key.startsWith("vp:pin_drafts:v2:") && !key.includes("migrated"));
      return entry ? Object.values(JSON.parse(entry[1]).drafts)[0] : null;
    });
    const before = await readCover();
    let releaseUpload = () => {};
    let uploadStarted = false;
    const gate = new Promise<void>(resolve => { releaseUpload = resolve; });
    await page.route("**/api/studio/upload", async route => {
      uploadStarted = true;
      await gate;
      const proxyUrl = `/api/storage-image?path=studio%2Fuploads%2F${TEST_USER_ID}%2Fabandoned.jpg`;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ proxyUrl, publicUrl: proxyUrl, path: `studio/uploads/${TEST_USER_ID}/abandoned.jpg` }) });
    });
    await card.getByRole("button", { name: "Choose cover frame", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Choose cover frame", exact: true });
    await dialog.getByRole("slider", { name: "Cover frame time" }).fill("1250");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(() => uploadStarted).toBe(true);
    // Programmatic navigation simulates a parent route unmount while the modal
    // blocks ordinary outside clicks. Keep the same JS runtime and pending request.
    await page.getByRole("link", { name: "My Pins", exact: true }).evaluate(link => (link as HTMLElement).click());
    await expect(dialog).not.toBeVisible({ timeout: 45000 });
    const response = page.waitForResponse(r => r.url().endsWith("/api/studio/upload"));
    releaseUpload();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await readCover()).toEqual(before);
    await expect(page.getByRole("alert").filter({ hasText: "Could not save this cover" })).toHaveCount(0);
  });

  test("selecting multiple videos creates independent video drafts", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("alpha.mp4"), video("beta.mp4")]);

    const cards = page.getByTestId("pin-board-card");
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(0);
    await expect(page.getByTestId("video-upload-batch")).toHaveCount(0);
    await expect(cards.nth(0).getByTestId("content-media-video").first()).toBeVisible();
    await expect(cards.nth(1).getByTestId("content-media-video").first()).toBeVisible();
    const drafts = await page.evaluate(() => {
      const entries = Object.entries(localStorage);
      const values = entries.filter(([key]) => key.includes("pin_drafts") || key.includes("pin-drafts"));
      return values.flatMap(([, value]) => {
        try { return Object.values((JSON.parse(value) as { drafts?: Record<string, { media?: Array<{ kind?: string }> }> }).drafts ?? {}); } catch { return []; }
      }).map(draft => draft.media?.[0]?.kind);
    });
    expect(drafts.filter(kind => kind === "video")).toHaveLength(2);
  });

  test("mixed selection keeps image separate and exposes partial failure with retry", async ({ page }) => {
    const state = await installVideoMocks(page, { failFinalizeCall: 2 });
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([
      { name: "image.png", mimeType: "image/png", buffer: IMAGE },
      video("good.mp4"),
      video("needs-retry.mp4"),
    ]);

    await expect(page.locator(`${UPLOAD_PLACEHOLDERS}[data-video-upload-state="failed"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("video-upload-batch-failed")).toBeVisible();
    await expect(page.locator(RETRY_BUTTONS)).toBeVisible();
    await expect(page.getByTestId("pin-board-card")).toHaveCount(2, { timeout: 20_000 });
    expect(state.uploadCalls).toEqual([0, 0]);

    await page.locator(RETRY_BUTTONS).click();
    await expect(page.getByTestId("pin-board-card")).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(0);
  });

  test("cancel stops an in-flight batch and does not create drafts", async ({ page }) => {
    const state = await installVideoMocks(page, { hangUpload: true });
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("cancel-me.mp4")]);
    await expect(page.locator(CANCEL_BUTTONS)).toBeVisible({ timeout: 30_000 });
    await page.locator(CANCEL_BUTTONS).click();
    // A cancelled item leaves no spinning placeholder behind.
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(0);
    expect(state.finalizeCalls).toEqual([]);
  });

  test("keeps the picker enabled and appends a later selection while uploads are active", async ({ page }) => {
    await installVideoMocks(page, { hangUpload: true });
    await gotoStudio(page);
    await requireVideoFlag(page);
    const input = page.getByTestId("board-upload-input");
    await input.setInputFiles([video("first.mp4")]);
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(1, { timeout: 30_000 });
    await expect(input).toBeEnabled();
    await input.setInputFiles([video("second.mp4")]);
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(2, { timeout: 30_000 });
    await page.getByTestId("video-upload-cancel-all").click();
    await expect(page.locator(UPLOAD_PLACEHOLDERS)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("video-upload-batch")).toHaveCount(0);
  });

  test("reload recovers a finalized receipt into its original owner draft", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.evaluate(({ userId, workspace }) => {
      const scopeKey = `${userId}:${workspace}`;
      localStorage.setItem("vibepin:video-batch-recovery:v1", JSON.stringify({ [scopeKey]: [{
        version: 1,
        logicalId: "recovery-batch:0",
        draftIdempotencyKey: "video:recovery-batch:0",
        owner: { ownerUserId: userId, workspaceId: workspace },
        filename: "recovered.mp4",
        title: "recovered",
        inspection: { width: 320, height: 240, durationMs: 1000 },
        attempt: { id: "attempt_0_1", batchId: "e2e_recovery_batch", ordinal: 0, phase: "finalize_pending" },
        createdAt: new Date().toISOString(),
      }] }));
    }, { userId: TEST_USER_ID, workspace: TEST_WORKSPACE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("pin-board-card").getByTestId("content-media-video").first()).toBeVisible();
    await expect.poll(() => page.evaluate(({ userId, workspace }) => {
      const raw = localStorage.getItem("vibepin:video-batch-recovery:v1");
      const value = raw ? JSON.parse(raw) : {};
      return value[`${userId}:${workspace}`] ?? null;
    }, { userId: TEST_USER_ID, workspace: TEST_WORKSPACE })).toEqual([]);
  });

  test("desktop dark theme smoke keeps the upload control usable", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("board-upload-input")).toBeAttached();
  });

  test("flag off preserves the image-only multi-upload choice flow", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    const accept = await page.getByTestId("board-upload-input").getAttribute("accept");
    test.skip(accept?.includes("video/mp4"), "run this case with NEXT_PUBLIC_VIDEO_PIN_UPLOAD disabled");
    await page.getByTestId("board-upload-input").setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: IMAGE },
      { name: "two.png", mimeType: "image/png", buffer: IMAGE },
    ]);
    await expect(page.getByTestId("multi-upload-modal")).toBeVisible();
    await expect(page.getByRole("button", { name: /Publish separately/i })).toBeVisible();
  });
});

test.describe("video batch upload — mobile light smoke", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "light" });

  test("keeps the upload control usable", async ({ page }) => {
    await installVideoMocks(page, { appearanceTheme: "light" });
    await gotoStudio(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("board-upload-input")).toBeAttached();
  });
});
