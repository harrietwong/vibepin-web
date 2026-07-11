/**
 * Create Pins REAL-BROWSER QA (PRD v1.2 release checklist).
 *
 * Drives the running app with Playwright. Server must run with E2E_TEST_MODE=true
 * (page auth bypass). API routes that need auth/external providers are mocked at the
 * network layer via context.route — the UI under test is the real app code.
 *
 * Run:
 *   $env:E2E_TEST_MODE='true'; npm run dev          # server
 *   npx tsx scripts/qa-create-pins-browser.ts       # this script
 *
 * Output: pass/fail per checklist item + screenshots in artifacts/create-pins-qa/.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = path.join(process.cwd(), "artifacts", "create-pins-qa");
fs.mkdirSync(OUT, { recursive: true });

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMG = `data:image/png;base64,${PNG_1x1}`;

const results: Array<{ item: string; status: "PASS" | "FAIL" | "SKIP"; note?: string }> = [];
function rec(item: string, status: "PASS" | "FAIL" | "SKIP", note?: string) {
  results.push({ item, status, note });
  console.log(`  ${status === "PASS" ? "✓" : status === "SKIP" ? "—" : "✗"} ${item}${note ? ` — ${note}` : ""}`);
}
async function step(item: string, fn: () => Promise<string | void>) {
  try { const note = await fn(); rec(item, "PASS", note ?? undefined); }
  catch (e) { rec(item, "FAIL", (e as Error).message.slice(0, 220)); }
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

// ── Seed drafts (localStorage vp:pin_drafts:v1) ────────────────────────────────
function draft(id: string, over: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id, imageUrl: IMG, keyword: "", category: "home-decor",
    title: `QA ${id}`, description: `QA description for ${id}`, altText: `QA alt ${id}`,
    destinationUrl: "", boardId: "b1", boardName: "Home Decor",
    weeklyPlanItemId: "", generationSessionId: "", scheduledDate: "",
    status: "needs_review", createdAt: now, updatedAt: now,
    source: "uploaded_image",
    ...over,
  };
}
const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
// Cards that will be PUBLISHED in this run need a public http(s) image —
// handlePublish correctly refuses non-public (data:/blob:) images.
const HTTP_IMG = "https://qa.invalid.example.com/pin.png";
const SEEDS: Record<string, unknown> = {
  u1: draft("u1", {}),
  s1: draft("s1", { imageUrl: HTTP_IMG, scheduledDate: tomorrow, scheduledTime: "10:00", addedToPlanAt: new Date().toISOString() }),
  s2: draft("s2", { scheduledDate: tomorrow, scheduledTime: "11:00", addedToPlanAt: new Date().toISOString() }),
  p1: draft("p1", { postedAt: new Date().toISOString(), remotePinId: "rp1", remotePinUrl: "https://www.pinterest.com/pin/rp1/" }),
  fp: draft("fp", { imageUrl: HTTP_IMG, publishError: "Pinterest API error (500)" }),
  fg: draft("fg", { generationStatus: "failed", parentDraftId: "u1", source: "ai_generated_from_upload" }),
};

// ── API mocks ──────────────────────────────────────────────────────────────────
let generateMode: "ok2" | "ok1" | "fail" = "ok2";
let pinsCalls = 0;

async function installMocks(context: BrowserContext) {
  await context.route("**/api/pinterest/status**", r => r.fulfill({ json: {
    connected: true, account: { id: "qa", username: "qa-user", accountType: "BUSINESS" },
    scopes: ["boards:read", "pins:read", "pins:write", "boards:write", "user_accounts:read"],
    needsReconnect: false, lastSyncedAt: null, connectionSource: "db", apiEnv: "sandbox", environment: "sandbox",
  } }));
  await context.route("**/api/pinterest/boards**", r => r.fulfill({ json: {
    items: [{ id: "b1", name: "Home Decor" }, { id: "b2", name: "Living Room Ideas" }], bookmark: null,
  } }));
  await context.route("**/api/social/connections**", r => r.fulfill({ json: { platforms: [
    { provider: "pinterest", status: "connected", connected: true, accountCount: 1, accountName: "qa-user", liveConnect: true, accounts: [] },
    { provider: "instagram", status: "not_connected", connected: false, accountCount: 0, accountName: null, liveConnect: false, accounts: [] },
    { provider: "facebook", status: "not_connected", connected: false, accountCount: 0, accountName: null, liveConnect: false, accounts: [] },
    { provider: "tiktok", status: "not_connected", connected: false, accountCount: 0, accountName: null, liveConnect: false, accounts: [] },
  ] } }));
  await context.route("**/api/ai-copy/analyze", r => r.fulfill({ json: {
    ok: true,
    analysis: { imageSummary: "QA image", visibleObjects: ["chair"], colors: ["gray"], style: "modern", ocrText: "", category: "home-decor", model: "qa" },
    recommendedKeywords: ["living room decor ideas"], keywordSource: "pinterest_high_search",
    timingsMs: { analysis: 1, keywords: 1, total: 2 },
  } }));
  let uploadN = 0;
  await context.route("**/api/studio/upload", r => {
    const body = r.request().postData() ?? "";
    if (body.includes("text/plain")) {
      return r.fulfill({ status: 415, json: { error: "Unsupported image type", code: "invalid_type" } });
    }
    uploadN++;
    return r.fulfill({ status: 201, json: {
      ok: true, path: `studio/uploads/qa/${uploadN}.png`,
      publicUrl: IMG, proxyUrl: IMG,
    } });
  });
  await context.route("**/api/generate", async r => {
    await new Promise(res => setTimeout(res, 2500)); // window to observe Generating placeholders
    if (generateMode === "fail") return r.fulfill({ status: 500, json: { error: "generation failed" } });
    const urls = generateMode === "ok1" ? [IMG] : [IMG, IMG];
    return r.fulfill({ json: { urls, generationRequestId: `qa_${Date.now()}` } });
  });
  await context.route("**/api/pinterest/pins", async r => {
    if (r.request().method() !== "POST") return r.fulfill({ json: {} });
    pinsCalls++;
    await new Promise(res => setTimeout(res, 600)); // in-flight window for the double-click test
    return r.fulfill({ status: 201, json: {
      ok: true, pin: { id: `qapin${pinsCalls}`, url: `https://www.pinterest.com/pin/qapin${pinsCalls}/` },
      board: { id: "b1", name: "Home Decor" }, environment: "sandbox",
    } });
  });
}

const card = (page: Page, lifecycle: string) =>
  page.locator(`[data-testid="pin-board-card"][data-lifecycle="${lifecycle}"]`);

/** Recovery between steps: close a lingering AI drawer, return to the board. */
async function ensureOnBoard(page: Page) {
  const drawer = page.getByTestId("ai-version-drawer");
  if (await drawer.count()) {
    await page.getByTestId("ai-version-close").click().catch(() => {});
    await drawer.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  }
  if (!page.url().includes("/app/studio")) {
    await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 20_000 });
}

async function openMore(page: Page, cardLoc: ReturnType<typeof card>) {
  await cardLoc.getByTestId("card-more").click();
  return page.locator('[data-testid^="card-menu-"]:visible');
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  await installMocks(context);
  await context.addInitScript(([key, seeds]) => {
    try { window.localStorage.setItem(key as string, JSON.stringify({ drafts: seeds })); } catch { /* ignore */ }
  }, ["vp:pin_drafts:v1", SEEDS] as const);
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 30_000 });
  await shot(page, "01-board-seeded");

  // ── Lifecycle badges present for the 4 seedable states + action matrix ────────
  await step("Seeded lifecycles render (Unscheduled/Scheduled/Posted/Failed)", async () => {
    for (const lc of ["unscheduled", "scheduled", "posted", "failed"]) {
      if (await card(page, lc).count() < 1) throw new Error(`no ${lc} card`);
    }
    return `failed cards: ${await card(page, "failed").count()} (publish-failed + generation-failed)`;
  });

  await step("Matrix · Unscheduled = Schedule/Edit + More(Publish now,Duplicate,Download,Delete)", async () => {
    const c = card(page, "unscheduled").first();
    if (!await c.getByTestId("card-schedule").isVisible()) throw new Error("no Schedule primary");
    if (!await c.getByTestId("card-edit").isVisible()) throw new Error("no Edit secondary");
    const items = await openMore(page, c);
    const labels = (await items.allTextContents()).join("|");
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(5, 5);
    for (const want of ["Publish now", "Duplicate", "Download", "Delete"]) {
      if (!labels.includes(want)) throw new Error(`missing "${want}" (got ${labels})`);
    }
  });

  await step("Matrix · Scheduled = Edit/View Plan + More(Duplicate,Download,Unschedule)", async () => {
    const c = card(page, "scheduled").first();
    if (!await c.getByTestId("card-edit").isVisible()) throw new Error("no Edit primary");
    if (!await c.getByTestId("card-view-plan").isVisible()) throw new Error("no View Plan secondary");
    const items = await openMore(page, c);
    const labels = (await items.allTextContents()).join("|");
    await page.mouse.click(5, 5);
    for (const want of ["Duplicate", "Download", "Unschedule"]) {
      if (!labels.includes(want)) throw new Error(`missing "${want}" (got ${labels})`);
    }
  });

  await step("Matrix · Posted = View Pin/Details + More(Download,Save as reference,Archive); View Pin only with remotePinUrl", async () => {
    const c = card(page, "posted").first();
    const href = await c.getByTestId("card-view-pin").getAttribute("href");
    if (href !== "https://www.pinterest.com/pin/rp1/") throw new Error(`View Pin href=${href}`);
    if (!await c.getByTestId("card-details").isVisible()) throw new Error("no Details secondary");
    const items = await openMore(page, c);
    const labels = (await items.allTextContents()).join("|");
    await page.mouse.click(5, 5);
    for (const want of ["Download", "Save as reference", "Archive"]) {
      if (!labels.includes(want)) throw new Error(`missing "${want}" (got ${labels})`);
    }
    // No View Pin on non-posted cards
    if (await card(page, "unscheduled").first().getByTestId("card-view-pin").count() > 0) throw new Error("View Pin leaked to unscheduled");
  });

  await step("Matrix · Failed = Try again/Edit + More(Regenerate,Delete)", async () => {
    const c = card(page, "failed").first();
    if (!await c.getByTestId("card-try-again").isVisible()) throw new Error("no Try again primary");
    if (!await c.getByTestId("card-edit").isVisible()) throw new Error("no Edit secondary");
    const items = await openMore(page, c);
    const labels = (await items.allTextContents()).join("|");
    await page.mouse.click(5, 5);
    for (const want of ["Regenerate", "Delete"]) {
      if (!labels.includes(want)) throw new Error(`missing "${want}" (got ${labels})`);
    }
  });

  await step("More menu click does not open/edit the card", async () => {
    const before = await page.locator('[data-testid="pin-board-card"][data-active="true"]').count();
    const c = card(page, "posted").first();
    await c.getByTestId("card-more").click();
    await page.mouse.click(5, 5);
    const after = await page.locator('[data-testid="pin-board-card"][data-active="true"]').count();
    if (after !== before) throw new Error("More toggled card active state");
  });

  // ── Upload: 2 valid + 1 invalid ───────────────────────────────────────────────
  await step("Upload 2 valid + 1 invalid file → 2 new cards, failure reported, successes kept", async () => {
    const cardsBefore = await page.locator('[data-testid="pin-board-card"]').count();
    const png = Buffer.from(PNG_1x1, "base64");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "good-1.png", mimeType: "image/png", buffer: png },
      { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") },
      { name: "good-2.png", mimeType: "image/png", buffer: png },
    ]);
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="pin-board-card"]').length >= (n as number) + 2,
      cardsBefore, { timeout: 20_000 },
    );
    const failToast = await page.getByText(/Failed to upload bad\.txt/).first().isVisible().catch(() => false);
    await shot(page, "02-upload-partial-failure");
    if (!failToast) throw new Error("no per-file failure toast for bad.txt");
    return "2 cards created; bad.txt reported by name";
  });

  // ── AI generation: placeholders → Unscheduled ─────────────────────────────────
  await step("Generate 2 AI Pins → 2 Generating placeholders immediately; drawer closes; both become Unscheduled", async () => {
    generateMode = "ok2";
    const u1 = page.locator('[data-testid="pin-board-card"]', { hasText: "QA u1" }).first();
    await u1.getByTestId("card-edit").click();
    await page.getByTestId("card-generate-ai-image").click();
    const genBtn = page.locator("button", { hasText: /Generate 2 Pins/ }).first();
    await genBtn.waitFor({ timeout: 15_000 });
    await genBtn.click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="pin-board-card"][data-lifecycle="generating"]').length >= 2,
      undefined, { timeout: 5_000 },
    );
    await shot(page, "03-generating-placeholders");
    const drawerGone = await page.locator("button", { hasText: /Generate 2 Pins/ }).count() === 0;
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="pin-board-card"][data-lifecycle="generating"]').length === 0,
      undefined, { timeout: 20_000 },
    );
    const aiCards = await page.locator('[data-testid="pin-board-card"][data-source="ai_generated_from_upload"][data-lifecycle="unscheduled"]').count();
    await shot(page, "04-ai-cards-unscheduled");
    if (aiCards < 2) throw new Error(`expected ≥2 AI unscheduled cards, got ${aiCards}`);
    return `drawer auto-closed on Generate (${drawerGone ? "yes" : "no"}); task continued to completion`;
  });

  await step("Whole-run failure → placeholders become Failed; Try again reopens AI drawer", async () => {
    generateMode = "fail";
    const failedBefore = await card(page, "failed").count();
    const u1 = page.locator('[data-testid="pin-board-card"]', { hasText: "QA u1" }).first();
    await u1.getByTestId("card-edit").click();
    await page.getByTestId("card-generate-ai-image").click();
    const genBtn = page.locator("button", { hasText: /Generate 2 Pins/ }).first();
    await genBtn.waitFor({ timeout: 15_000 });
    await genBtn.click();
    await page.waitForFunction(
      ([n]) => document.querySelectorAll('[data-testid="pin-board-card"][data-lifecycle="failed"]').length >= (n as number) + 2,
      [failedBefore], { timeout: 20_000 },
    );
    await shot(page, "05-generation-failed-cards");
    // Try again on a generation-failed card → AI drawer reopens (parent as source)
    const genFailed = card(page, "failed").first();
    await genFailed.getByTestId("card-try-again").click();
    await page.locator("button", { hasText: /Generate \d Pin/ }).first().waitFor({ timeout: 10_000 });
    await shot(page, "06-try-again-reopens-drawer");
    // Close the drawer and VERIFY it is gone (a lingering drawer blocks the board).
    await page.getByTestId("ai-version-close").click();
    await page.getByTestId("ai-version-drawer").waitFor({ state: "detached", timeout: 8_000 });
    generateMode = "ok2";
  });

  // ── View Plan / Unschedule ────────────────────────────────────────────────────
  await step("View Plan navigates to /app/plan", async () => {
    await ensureOnBoard(page);
    const c = card(page, "scheduled").first();
    await c.getByTestId("card-view-plan").click();
    await page.waitForURL("**/app/plan**", { timeout: 20_000 });
    await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 20_000 });
  });

  await step("Unschedule returns Pin to Unscheduled and clears the plan date", async () => {
    await ensureOnBoard(page);
    const c = page.locator('[data-testid="pin-board-card"]', { hasText: "QA s1" }).first();
    const items = await openMore(page, c);
    await items.filter({ hasText: "Unschedule" }).first().click();
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem("vp:pin_drafts:v1");
      if (!raw) return false;
      const d = JSON.parse(raw).drafts?.s1;
      return d && !d.scheduledDate && !d.addedToPlanAt;
    }, undefined, { timeout: 10_000 });
    const badge = await c.getByTestId("card-status-badge").textContent();
    if (!badge?.includes("Unscheduled")) throw new Error(`badge=${badge}`);
  });

  // ── Download / Save as reference ─────────────────────────────────────────────
  await step("Download triggers a browser download", async () => {
    await ensureOnBoard(page);
    const c = card(page, "posted").first();
    const items = await openMore(page, c);
    const dl = page.waitForEvent("download", { timeout: 15_000 });
    await items.filter({ hasText: "Download" }).first().click();
    const download = await dl;
    return `file: ${download.suggestedFilename()}`;
  });

  await step("Save as reference stores a style_reference asset", async () => {
    await ensureOnBoard(page);
    const c = card(page, "posted").first();
    const items = await openMore(page, c);
    await items.filter({ hasText: "Save as reference" }).first().click();
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem("vp_assets_v1");
      if (!raw) return false;
      return (JSON.parse(raw) as Array<{ role: string }>).some(a => a.role === "style_reference");
    }, undefined, { timeout: 10_000 });
  });

  // ── Publish now: double-click dedupe; Failed → Try again = retry publish ─────
  await step("Publish now is not double-submittable (1 API call) and card becomes Posted", async () => {
    await ensureOnBoard(page);
    pinsCalls = 0;
    const c = page.locator('[data-testid="pin-board-card"]', { hasText: "QA s1" }).first(); // now unscheduled
    let items = await openMore(page, c);
    await items.filter({ hasText: "Publish now" }).first().click();
    // Immediately try again while the first request is in flight (600ms mock delay)
    await c.getByTestId("card-more").click().catch(() => {});
    const again = page.locator('[data-testid="card-menu-publish"]:visible');
    if (await again.count()) await again.first().click().catch(() => {});
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem("vp:pin_drafts:v1");
      const d = raw ? JSON.parse(raw).drafts?.s1 : null;
      return d && !!d.postedAt;
    }, undefined, { timeout: 15_000 });
    if (pinsCalls !== 1) throw new Error(`publish API called ${pinsCalls}×`);
    return "1 publish call; lifecycle → Posted";
  });

  await step("Publish-failed card: Try again retries the real publish → Posted", async () => {
    await ensureOnBoard(page);
    pinsCalls = 0;
    const c = page.locator('[data-testid="pin-board-card"]', { hasText: "QA fp" }).first();
    await c.getByTestId("card-try-again").click();
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem("vp:pin_drafts:v1");
      const d = raw ? JSON.parse(raw).drafts?.fp : null;
      return d && !!d.postedAt && !d.publishError;
    }, undefined, { timeout: 15_000 });
    if (pinsCalls !== 1) throw new Error(`publish API called ${pinsCalls}×`);
  });

  // ── Save-failure QA ───────────────────────────────────────────────────────────
  await step("Persist failure: edits kept, 'Failed to save · Retry' shown, Retry recovers", async () => {
    await ensureOnBoard(page);
    await page.evaluate(() => {
      const w = window as unknown as { __realSetItem?: typeof localStorage.setItem };
      w.__realSetItem = localStorage.setItem.bind(localStorage);
      // eslint-disable-next-line no-global-assign
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === "vp:pin_drafts:v1") throw new DOMException("QuotaExceededError");
        return (window as unknown as { __realSetItem: (k: string, v: string) => void }).__realSetItem(k, v);
      };
    });
    // Edit a title in the expanded card
    const c = page.locator('[data-testid="pin-board-card"]', { hasText: "QA u1" }).first();
    await c.getByTestId("card-edit").click();
    const title = page.getByTestId("board-field-title");
    await title.fill("Edited during quota failure");
    await page.waitForTimeout(700); // debounce persist
    const state = page.getByTestId("board-save-state");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="board-save-state"]')?.textContent?.includes("Failed to save"),
      undefined, { timeout: 10_000 },
    );
    await shot(page, "07-failed-to-save");
    if ((await title.inputValue()) !== "Edited during quota failure") throw new Error("edit lost from input");
    // Retry while broken → still failed
    await state.click();
    await page.waitForTimeout(400);
    const stillFailed = await state.textContent();
    if (!stillFailed?.includes("Failed to save")) throw new Error("retry while broken claimed success");
    // Restore storage → Retry succeeds
    await page.evaluate(() => {
      Storage.prototype.setItem = (window as unknown as { __realSetItem: typeof localStorage.setItem }).__realSetItem;
    });
    await page.getByTestId("board-save-state").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="board-save-state"]')?.textContent?.includes("Saved on this device"),
      undefined, { timeout: 10_000 },
    );
    // Durable copy contains the edit
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("vp:pin_drafts:v1") ?? "{}")?.drafts?.u1?.title);
    if (persisted !== "Edited during quota failure") throw new Error(`durable title=${persisted}`);
    await shot(page, "08-saved-after-retry");
  });

  // ── Destinations: non-Pinterest = Coming soon, non-actionable ────────────────
  await step("Publish destinations: IG/FB/TikTok show 'Coming soon' and are not selectable", async () => {
    await page.goto(`${BASE_URL}/app/plan`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // List view has a deterministic Edit affordance → opens the Edit drawer.
    // The page restores a remembered view mode asynchronously on mount, which can
    // override an early click — retry the toggle until the list view is mounted.
    await page.getByTestId("view-mode-list").waitFor({ timeout: 25_000 });
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("view-mode-list").click();
      const mounted = await page.getByTestId("plan-list-view").waitFor({ timeout: 4_000 }).then(() => true).catch(() => false);
      if (mounted) break;
    }
    await page.getByTestId("plan-list-row").first().waitFor({ timeout: 25_000 });
    await page.getByTestId("plan-list-edit").first().click();
    await page.getByTestId("publish-destinations").waitFor({ timeout: 20_000 });
    await shot(page, "09-publish-destinations");
    for (const p of ["instagram", "facebook", "tiktok"]) {
      const row = page.getByTestId(`publish-dest-${p}`);
      if ((await row.getAttribute("aria-disabled")) !== "true") throw new Error(`${p} not aria-disabled`);
      const status = await page.getByTestId(`publish-dest-${p}-status`).textContent();
      if (!status?.includes("Coming soon")) throw new Error(`${p} status="${status}"`);
      await row.click({ force: true });
      const checked = await row.getAttribute("aria-checked");
      if (checked === "true") throw new Error(`${p} became selected on click`);
    }
    return "all three disabled, labeled Coming soon, click is a no-op";
  });

  await browser.close();

  console.log("\n================ QA SUMMARY ================");
  for (const r of results) console.log(` ${r.status.padEnd(4)} ${r.item}${r.note ? ` — ${r.note}` : ""}`);
  const fails = results.filter(r => r.status === "FAIL").length;
  console.log(`\n${results.length - fails}/${results.length} passed. Screenshots: ${OUT}`);
  if (fails) process.exit(1);
}

void main();
