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
  failOrdinal?: number;
  hangUpload?: boolean;
};

type VideoMockState = {
  options: VideoMockOptions;
  prepareCalls: number[];
  finalizeCalls: number[];
  uploadCalls: number[];
};

function fakeSession() {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const user = {
    id: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "video-e2e@vibepin.test",
    user_metadata: { appearanceTheme: "dark" },
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

async function installAuthAndIsolation(page: Page) {
  // getSession() is intentionally local-only in the app. Return a deterministic
  // test session for any Supabase storage key without creating a real auth user.
  await page.addInitScript((session) => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      const value = originalGetItem.call(this, key);
      if (!value && key.includes("auth-token")) return JSON.stringify(session);
      return value;
    };
    localStorage.setItem("vp:appearance_theme:v1", "dark");
  }, fakeSession());

  const baseOrigin = new URL(process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000").origin;
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
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeSession().user) });
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
  await installAuthAndIsolation(page);

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
    if (options.failOrdinal === ordinal && state.finalizeCalls.filter(value => value === ordinal).length === 1) {
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "video_upload_failed" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, batchId: `e2e_batch_${state.finalizeCalls.length}`, ordinal, proxyUrl: `/api/storage-video?path=${TEST_USER_ID}/videos/e2e/${ordinal}.mp4`, requestId: `finalize_${state.finalizeCalls.length}` }),
    });
  });

  await page.route("**/api/studio/upload", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, path: `${TEST_USER_ID}/posters/e2e.jpg`, publicUrl: "/api/storage-image?path=e2e", proxyUrl: "/api/storage-image?path=e2e", requestId: "poster_upload" }) });
  });
  await page.route("**/api/studio/upload/poster-operation", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/studio/upload/cleanup", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/storage-video**", async (route) => {
    await route.fulfill({ status: 200, contentType: "video/mp4", body: VIDEO });
  });
  await page.route("**/api/storage-image**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: IMAGE });
  });
  return state;
}

async function gotoStudio(page: Page) {
  await page.goto("/app/studio", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await expect(page.getByTestId("studio-interactive")).toBeAttached({ timeout: 20_000 });
  await expect(page.getByTestId("board-upload-input")).toBeAttached({ timeout: 20_000 });
}

async function requireVideoFlag(page: Page) {
  const accept = await page.getByTestId("board-upload-input").getAttribute("accept");
  test.skip(!accept?.includes("video/mp4"), "video flag is off; run the flag-off fallback test in this server configuration");
}

function video(name: string) {
  return { name, mimeType: "video/mp4", buffer: VIDEO };
}

test.describe("video batch upload (fully mocked)", () => {
  test.describe.configure({ timeout: 90_000 });

  test("selecting multiple videos creates independent video drafts", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("alpha.mp4"), video("beta.mp4")]);

    await expect(page.getByTestId("video-upload-batch")).toContainText("completed", { timeout: 30_000 });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId("content-media-video")).toHaveCount(2);
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
    const state = await installVideoMocks(page, { failOrdinal: 1 });
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([
      { name: "image.png", mimeType: "image/png", buffer: IMAGE },
      video("good.mp4"),
      video("needs-retry.mp4"),
    ]);

    await expect(page.getByTestId("video-upload-batch")).toContainText("partial", { timeout: 30_000 });
    await expect(page.getByTestId("video-upload-retry")).toBeVisible();
    await expect(page.getByTestId("pin-board-card")).toHaveCount(2, { timeout: 20_000 });
    expect(state.uploadCalls).toEqual(expect.arrayContaining([0, 1]));

    await page.getByTestId("video-upload-retry").click();
    await expect(page.getByTestId("video-upload-batch")).toContainText("completed", { timeout: 30_000 });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(3, { timeout: 20_000 });
  });

  test("cancel stops an in-flight batch and does not create drafts", async ({ page }) => {
    const state = await installVideoMocks(page, { hangUpload: true });
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.getByTestId("board-upload-input").setInputFiles([video("cancel-me.mp4")]);
    await expect(page.getByTestId("video-upload-cancel")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("video-upload-cancel").click();
    await expect(page.getByTestId("video-upload-batch")).toContainText("cancelled", { timeout: 15_000 });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(0);
    expect(state.finalizeCalls).toEqual([]);
  });

  test("reload recovers a finalized receipt into its original owner draft", async ({ page }) => {
    await installVideoMocks(page);
    await gotoStudio(page);
    await requireVideoFlag(page);
    await page.evaluate(({ userId, workspace }) => {
      localStorage.setItem("vibepin:video-batch-recovery:v1", JSON.stringify([{
        version: 1,
        logicalId: "recovery-batch:0",
        draftIdempotencyKey: "video:recovery-batch:0",
        owner: { ownerUserId: userId, workspaceId: workspace },
        filename: "recovered.mp4",
        title: "recovered",
        inspection: { width: 320, height: 240, durationMs: 1000 },
        attempt: { id: "attempt_0_1", batchId: "e2e_recovery_batch", ordinal: 0, phase: "finalize_pending" },
        createdAt: new Date().toISOString(),
      }]));
    }, { userId: TEST_USER_ID, workspace: TEST_WORKSPACE });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pin-board-card")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("content-media-video")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vibepin:video-batch-recovery:v1"))).toBe("[]");
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
    await installVideoMocks(page);
    await page.addInitScript(() => localStorage.setItem("vp:appearance_theme:v1", "light"));
    await gotoStudio(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByTestId("board-upload-input")).toBeAttached();
  });
});
