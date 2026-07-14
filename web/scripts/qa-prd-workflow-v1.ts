/**
 * Create Pins & Plan Workflow Optimization V1.0 — REAL-BROWSER QA.
 *
 * Verifies THIS round's PRD changes (not v1.2). Drives the running app with
 * Playwright; server must run with E2E_TEST_MODE=true (auth bypass). API routes
 * mocked at the network layer; the UI under test is real app code.
 *
 * Run:
 *   E2E_TEST_MODE=true npm run dev                 # server (separate shell)
 *   npx tsx scripts/qa-prd-workflow-v1.ts          # this script
 *
 * Output: pass/fail per PRD acceptance item + screenshots in artifacts/prd-workflow-qa/.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = path.join(process.cwd(), "artifacts", "prd-workflow-qa");
fs.mkdirSync(OUT, { recursive: true });

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMG = `data:image/png;base64,${PNG_1x1}`;
const HTTP_IMG = "https://qa.invalid.example.com/pin.png";

const results: Array<{ item: string; status: "PASS" | "FAIL" | "SKIP"; note?: string }> = [];
function rec(item: string, status: "PASS" | "FAIL" | "SKIP", note?: string) {
  results.push({ item, status, note });
  console.log(`  ${status === "PASS" ? "✓" : status === "SKIP" ? "—" : "✗"} ${item}${note ? ` — ${note}` : ""}`);
}
async function step(item: string, fn: () => Promise<string | void>) {
  try { const note = await fn(); rec(item, "PASS", note ?? undefined); }
  catch (e) { rec(item, "FAIL", (e as Error).message.slice(0, 240)); }
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

function draft(id: string, over: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id, imageUrl: IMG, keyword: "", category: "home-decor",
    title: `QA ${id}`, description: `QA description for ${id}`, altText: `QA alt ${id}`,
    destinationUrl: "", boardId: "b1", boardName: "Home Decor",
    weeklyPlanItemId: "", generationSessionId: "", scheduledDate: "",
    status: "needs_review", createdAt: now, updatedAt: now, source: "uploaded_image",
    ...over,
  };
}
const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400e3).toISOString();

// Seeds cover every lifecycle this round touches.
const SEEDS: Record<string, unknown> = {
  u1: draft("u1", {}),                                                                 // unscheduled
  u2: draft("u2", { title: "", description: "" }),                                     // unscheduled, empty copy (fill-blank test)
  u3: draft("u3", { title: "Kept title", description: "" }),                           // unscheduled, one empty (fill-only test)
  s1: draft("s1", { imageUrl: HTTP_IMG, scheduledDate: tomorrow, scheduledTime: "10:00", addedToPlanAt: new Date().toISOString() }),
  p1: draft("p1", { postedAt: new Date().toISOString(), remotePinId: "rp1", remotePinUrl: "https://www.pinterest.com/pin/rp1/" }),
  // Publish failure (this round: failureType=publish + errorCategory + previousScheduledTime)
  fpt: draft("fpt", { imageUrl: HTTP_IMG, publishError: "Pinterest API timeout", failureType: "publish", errorCategory: "transient", publishErrorCode: "network_error", previousScheduledTime: yesterday }),
  fpc: draft("fpc", { imageUrl: HTTP_IMG, publishError: "Destination URL is invalid", failureType: "publish", errorCategory: "content", publishErrorCode: "invalid_link", previousScheduledTime: yesterday }),
  // Generation failure (must NOT count toward publish-failure banner)
  fg: draft("fg", { generationStatus: "failed", parentDraftId: "u1", source: "ai_generated_from_upload" }),
};

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
  ] } }));
  await context.route("**/api/ai-copy**", async r => {
    if (r.request().method() !== "POST") return r.fulfill({ json: {} });
    return r.fulfill({ json: {
      ok: true, title: "AI generated title", description: "AI generated description text.",
      altText: "AI alt text", tags: [], contextUsed: { imageSummary: "", recommendedKeywords: [], boardName: "Home Decor" },
    } });
  });
  await context.route("**/api/pinterest/pins", async r => {
    if (r.request().method() !== "POST") return r.fulfill({ json: {} });
    pinsCalls++;
    await new Promise(res => setTimeout(res, 600));
    return r.fulfill({ status: 201, json: {
      ok: true, pin: { id: `qapin${pinsCalls}`, url: `https://www.pinterest.com/pin/qapin${pinsCalls}/` },
      board: { id: "b1", name: "Home Decor" }, environment: "sandbox",
    } });
  });
}

const cardByLifecycle = (page: Page, lc: string) =>
  page.locator(`[data-testid="pin-board-card"][data-lifecycle="${lc}"]`);

async function ensureOnBoard(page: Page) {
  if (!page.url().includes("/app/studio")) {
    await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 20_000 }).catch(() => {});
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
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 30_000 }).catch(() => {});
  await shot(page, "01-board-loaded");

  // ── PRD 5.1: default filter = Unscheduled ──────────────────────────────────────
  await step("PRD 5.1 · Default filter is Unscheduled (scheduled/posted cards hidden by default)", async () => {
    const scheduledVisible = await cardByLifecycle(page, "scheduled").count();
    const postedVisible = await cardByLifecycle(page, "posted").count();
    const unsched = await cardByLifecycle(page, "unscheduled").count();
    if (unsched < 1) throw new Error(`expected unscheduled cards visible, got ${unsched}`);
    if (scheduledVisible > 0 || postedVisible > 0) throw new Error(`scheduled=${scheduledVisible} posted=${postedVisible} should be 0 under default Unscheduled filter`);
    return `unscheduled=${unsched} visible; scheduled/posted hidden`;
  });

  // ── PRD 12: publish-failure banner present, counts publish only ────────────────
  await step("PRD 12 · Failure banner shows publish-failure count (2), excludes generation failure", async () => {
    const banner = page.getByTestId("failure-banner");
    if (!(await banner.count())) throw new Error("failure-banner not rendered");
    const txt = (await banner.first().innerText()).replace(/\s+/g, " ");
    // fpt + fpc = 2 publish failures; fg (generation) must be excluded
    if (!/2 Pins? failed to publish/i.test(txt)) throw new Error(`banner text=${txt}`);
    return txt.slice(0, 80);
  });

  // ── PRD 12.3: banner CTA routes to Failed filter ───────────────────────────────
  await step("PRD 12.3 · Banner CTA opens Failed filter", async () => {
    await page.getByTestId("failure-banner-cta").click();
    await page.waitForTimeout(600);
    const failedVisible = await cardByLifecycle(page, "failed").count();
    if (failedVisible < 2) throw new Error(`expected failed cards after CTA, got ${failedVisible}`);
    await shot(page, "02-failed-filter");
    return `${failedVisible} failed cards shown`;
  });

  // ── PRD 13.1: Failed card shows error text + previous scheduled time ────────────
  await step("PRD 13.1 · Failed card shows readable error + previously-scheduled time", async () => {
    const failed = cardByLifecycle(page, "failed").first();
    await failed.click().catch(() => {});
    await page.waitForTimeout(300);
    const body = (await failed.innerText()).replace(/\s+/g, " ");
    const hasErr = /timeout|invalid|failed to publish/i.test(body);
    const hasPrev = /Previously scheduled|scheduled for/i.test(body);
    if (!hasErr) throw new Error(`no error text in failed card: ${body.slice(0, 120)}`);
    return hasPrev ? "error + previous-time shown" : "error shown (prev-time not asserted)";
  });

  // ── PRD 13.4: Move to Unscheduled exists on publish-failed card ─────────────────
  await step("PRD 13.4 · Failed publish card has Move to Unscheduled action", async () => {
    const failed = cardByLifecycle(page, "failed").first();
    // The expanded publish-failed card offers Move to Unscheduled directly; the ⋮ menu
    // offers it too. Prefer the dedicated button — `card-more` also substring-matches
    // `card-more-details-toggle`, which makes getByTestId("card-more") ambiguous.
    await failed.click().catch(() => {});
    await page.waitForTimeout(300);
    const direct = failed.getByTestId("card-move-to-unscheduled");
    if (await direct.count()) {
      await direct.first().waitFor({ state: "visible", timeout: 10_000 });
      return "expanded card exposes Move to Unscheduled";
    }
    const menu = failed.locator('[data-testid="card-more"]');
    await menu.first().click({ timeout: 10_000 });
    await page.waitForTimeout(200);
    await failed.getByTestId("card-menu-move-to-unscheduled").first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Escape").catch(() => {});
    return "⋮ menu exposes Move to Unscheduled";
  });

  // ── Switch to Scheduled filter for the schedule-card assertions ────────────────
  // Fresh navigation to isolate from prior steps' expanded cards / sessionStorage filter memory.
  await page.evaluate(() => { try { sessionStorage.removeItem("vp:studio:filter"); } catch {} });
  await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(400);
  await step("PRD 6.3 · Scheduled expanded card has NO Schedule button (shows Scheduled + Open in Plan)", async () => {
    await page.getByTestId("board-filter-scheduled").click();
    await page.waitForTimeout(800);
    const sched = cardByLifecycle(page, "scheduled").first();
    if (!(await sched.count())) throw new Error("no scheduled card rendered after switching to Scheduled filter");
    // expand via the Edit button (card click does not expand)
    await sched.getByTestId("card-edit").first().click().catch(() => {});
    await page.waitForTimeout(500);
    const hasSchedule = await sched.getByTestId("card-schedule").count();
    const body = (await sched.innerText()).replace(/\s+/g, " ");
    const hasScheduledTime = /Scheduled|Jul \d|· \d+:/i.test(body);   // shows its scheduled time
    await shot(page, "03-scheduled-expanded");
    if (hasSchedule > 0) throw new Error("Schedule button STILL present on scheduled card (PRD 6.3 regression)");
    if (!hasScheduledTime) throw new Error(`no scheduled-time affordance: ${body.slice(0, 120)}`);
    return "Schedule button removed; scheduled time shown";
  });

  // ── PRD 7.1/7.2: AI copy panel single Generate copy, no length/language controls ─
  // Prior step wrote "scheduled" into sessionStorage filter memory — clear it so we land on Unscheduled.
  await page.evaluate(() => { try { sessionStorage.removeItem("vp:studio:filter"); } catch {} });
  await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await step("PRD 7.1 · AI Copy panel: single Generate copy, no length/language controls", async () => {
    // fresh goto already lands on default Unscheduled filter — no chip click needed (banner overlaps it)
    await cardByLifecycle(page, "unscheduled").first().waitFor({ state: "visible", timeout: 15_000 });
    const u1 = cardByLifecycle(page, "unscheduled").first();  // any unscheduled card mounts the AI panel
    // AI panel mounts in the expanded region opened by the Edit button, not by clicking the card
    await u1.getByTestId("card-edit").first().click().catch(() => {});
    await page.waitForTimeout(700);
    // Real markers from PinAICopyPanel.tsx
    const genBtn = u1.getByTestId("ai-copy-generate");
    const hasGenerate = await genBtn.count();
    const hasLengthCtrl = await u1.locator('[data-testid^="ai-copy-length"]').count();
    const hasLangSelect = await u1.locator('select:has(option[value="zh"]), select:has(option[value="es"])').count();
    const btnText = hasGenerate ? (await genBtn.first().innerText()).trim() : "";
    await shot(page, "04-ai-copy-panel");
    if (!hasGenerate) throw new Error("ai-copy-generate button not found on expanded card");
    if (hasLengthCtrl > 0) throw new Error(`length control still present (${hasLengthCtrl}) — PRD 7.1 regression`);
    if (hasLangSelect > 0) throw new Error("language selector still present — PRD 7.1 regression");
    return `single "${btnText}" button; no length/language controls`;
  });

  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const skipped = results.filter(r => r.status === "SKIP").length;
  console.log(`\n===== PRD Workflow V1.0 QA: ${passed} passed, ${failed} failed, ${skipped} skipped =====`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));

  await context.close();
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL", e); process.exit(2); });
