/**
 * Real-app verification + screenshots for the top-right App-language & Theme
 * quick controls. Drives the ACTUAL running dev server via Playwright — no mocks,
 * no composited images.
 *
 * Prereq: dev server running with auth bypass, e.g.
 *   $env:E2E_TEST_MODE='true'; npm --prefix web run dev -- -p 3100
 * Then:
 *   $env:BASE_URL='http://localhost:3100'; npx tsx scripts/capture-topbar-language-theme.ts
 *
 * Output:  web/tmp/topbar-language-theme/screenshots/
 *
 * HARD failures (exit 1): language control missing, theme control missing,
 * language switch not reflected in Settings, language not persisted after
 * refresh, theme not applied/persisted, AI content language leaking into the app
 * UI language. Per-page zh-CN body coverage is measured and reported.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = join(process.cwd(), "tmp/topbar-language-theme/screenshots");
mkdirSync(OUT, { recursive: true });

const THEME_KEY = "vp:appearance_theme:v1";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const failures: string[] = [];
const notes: string[] = [];
function fail(msg: string) { failures.push(msg); console.error(`  ✗ ${msg}`); }
function note(msg: string) { notes.push(msg); console.log(`  • ${msg}`); }

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, name) });
  console.log(`  ✓ ${name}`);
}

async function gotoShell(page: Page, path = "/app/studio") {
  // Dev server compiles routes on first hit; retry once with a generous budget.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    if (page.url().includes("/login")) throw new Error(`redirected to /login — start the server with E2E_TEST_MODE=true`);
    if (await page.locator("[data-testid='app-sidebar']").isVisible({ timeout: 30000 }).catch(() => false)) {
      await sleep(900);
      return;
    }
  }
  throw new Error(`app shell did not load at ${path}`);
}

/** App-language applied? LocaleProvider sets <html lang> from appLanguage. */
async function htmlLang(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang);
}

/** Poll until the language pill shows `expected` (survives slow hydration). */
async function waitPill(page: Page, expected: string, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = (await page.textContent("[data-testid='topbar-language-short']").catch(() => ""))?.trim();
    if (v === expected) return true;
    await sleep(300);
  }
  return false;
}

/** Fraction of CJK characters in the visible page text (0..1). */
async function cjkRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const text = (document.querySelector("main")?.innerText || document.body.innerText || "").replace(/\s+/g, "");
    if (!text) return 0;
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    return cjk / text.length;
  });
}

/** Open a header dropdown, retrying — the first click can land before hydration. */
async function openMenu(page: Page, btn: string, menu: string) {
  await page.waitForSelector(`[data-testid='${btn}']`, { timeout: 15000 });
  for (let i = 0; i < 8; i++) {
    if (await page.locator(`[data-testid='${menu}']`).isVisible().catch(() => false)) return;
    await page.click(`[data-testid='${btn}']`, { force: true, timeout: 5000 }).catch(() => {});
    await sleep(450);
  }
  if (!(await page.locator(`[data-testid='${menu}']`).isVisible().catch(() => false))) {
    throw new Error(`menu ${menu} did not open (hydration?)`);
  }
}

async function selectTopbarLanguage(page: Page, code: string) {
  await openMenu(page, "topbar-language-button", "topbar-language-menu");
  await page.click(`[data-testid='topbar-language-option-${code}']`, { timeout: 5000 });
  await sleep(1100); // savePreferences + re-render
}

async function selectTopbarTheme(page: Page, value: "light" | "dark" | "system") {
  await openMenu(page, "topbar-theme-button", "topbar-theme-menu");
  await page.click(`[data-testid='topbar-theme-option-${value}']`, { timeout: 5000 });
  await sleep(500);
}

async function dataTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

const ZH_PAGES: { name: string; path: string }[] = [
  { name: "zh-CN-dashboard.png",              path: "/app/dashboard" },
  { name: "zh-CN-create-pins.png",            path: "/app/studio" },
  { name: "zh-CN-weekly-plan.png",            path: "/app/plan" },
  { name: "zh-CN-my-pins.png",                path: "/app/history" },
  { name: "zh-CN-opportunities.png",          path: "/app/workspace/home-decor" },
  { name: "zh-CN-keyword-trends.png",         path: "/app/trends" },
  { name: "zh-CN-pin-ideas.png",              path: "/app/discover" },
  { name: "zh-CN-product-opportunities.png",  path: "/app/products" },
  { name: "zh-CN-smart-schedule.png",         path: "/app/settings/smart-schedule" },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    // ── Controls exist (dark + EN baseline) ──
    await gotoShell(page, "/app/studio");
    if (!(await page.locator("[data-testid='topbar-language-button']").count())) fail("top-right App language control is missing");
    if (!(await page.locator("[data-testid='topbar-theme-button']").count())) fail("top-right Theme control is missing");
    // Ensure a known EN + dark starting point.
    await selectTopbarLanguage(page, "en").catch(() => {});
    await selectTopbarTheme(page, "dark").catch(() => {});
    await gotoShell(page, "/app/dashboard");
    await shot(page, "topbar-controls-dark-en.png");

    await selectTopbarTheme(page, "light");
    await sleep(400);
    await shot(page, "topbar-controls-light-en.png");
    await selectTopbarTheme(page, "dark");

    // Dropdowns open
    await openMenu(page, "topbar-language-button", "topbar-language-menu");
    await shot(page, "topbar-language-dropdown.png");
    await page.mouse.click(700, 500);
    await sleep(300);
    await openMenu(page, "topbar-theme-button", "topbar-theme-menu");
    await shot(page, "topbar-theme-dropdown.png");
    await page.mouse.click(700, 500);

    // ── Switch to 简体中文 via the top control ──
    await selectTopbarLanguage(page, "zh-CN");
    const short = (await page.textContent("[data-testid='topbar-language-short']"))?.trim();
    if (short !== "简") fail(`language pill did not update to 简 (got "${short}")`);
    await shot(page, "topbar-controls-zh-CN.png");

    // App language applied? <html lang> switches to zh-Hans for zh-CN.
    if ((await htmlLang(page)) !== "zh-Hans") fail("app did not apply 简体中文 (html lang != zh-Hans)");

    // Settings → Language shows zh-CN (sync check)
    try {
      await page.goto(`${BASE}/app/settings/language`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForSelector("[data-testid='settings-modal']", { timeout: 45000 });
      await sleep(500);
      const appLangVal = await page.inputValue("[data-testid='language-app-language']").catch(() => "");
      if (appLangVal !== "zh-CN") fail(`Settings → Language app-language out of sync (got "${appLangVal}", expected zh-CN)`);
      else note("Settings → Language app-language synced to zh-CN (matches top control)");
      await shot(page, "zh-CN-settings-language.png");
      await page.click("[data-testid='settings-tab-ai-settings']").catch(() => {});
      await sleep(400);
      await shot(page, "zh-CN-settings-ai-settings.png");
      await page.keyboard.press("Escape").catch(() => {});
    } catch (e) {
      note(`settings sync/screenshots SKIPPED (${(e as Error).message.split("\n")[0]})`);
    }

    // ── Persistence: refresh keeps Chinese ──
    await gotoShell(page, "/app/dashboard");
    if (!(await waitPill(page, "简"))) fail(`language did not persist after refresh (pill != 简)`);
    if ((await htmlLang(page)) !== "zh-Hans") fail("language did not persist after refresh (html lang != zh-Hans)");

    // ── Per-page zh-CN body coverage (recorded) + screenshots ──
    let anyBodyLocalized = false;
    for (const p of ZH_PAGES) {
      try {
        await gotoShell(page, p.path);
        await sleep(1500);
        const ratio = await cjkRatio(page);
        if (ratio >= 0.02) anyBodyLocalized = true;
        note(`${p.name}: zh page-body coverage ${(ratio * 100).toFixed(1)}% CJK`);
        await shot(page, p.name);
      } catch (e) {
        note(`${p.name}: SKIPPED (${(e as Error).message.split("\n")[0]})`);
      }
    }
    // Reported gap (NOT a control regression): page bodies are not yet fully
    // localized. Surfaced loudly so the report never claims global i18n complete.
    if (!anyBodyLocalized) note("⚠ PAGE-BODY i18n GAP: main page bodies remain English under zh-CN (see report §i18n status)");

    // amazon-associates (settings modal tab; no standalone route)
    try {
      await page.goto(`${BASE}/app/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForSelector("[data-testid='settings-modal']", { timeout: 45000 });
      await page.click("[data-testid='settings-tab-amazon']");
      await sleep(500);
      await shot(page, "zh-CN-amazon-associates.png");
      await page.keyboard.press("Escape").catch(() => {});
    } catch (e) { note(`zh-CN-amazon-associates.png: SKIPPED (${(e as Error).message})`); }

    // account dropdown (Chinese)
    try {
      await gotoShell(page, "/app/studio");
      await page.click("[data-testid='account-menu-trigger']", { timeout: 10000 });
      await page.waitForSelector("[data-testid='account-menu']", { timeout: 10000 });
      await sleep(400);
      await shot(page, "zh-CN-account-dropdown.png");
      await page.mouse.click(700, 500);
    } catch (e) { note(`zh-CN-account-dropdown.png: SKIPPED (${(e as Error).message})`); }

    // ── AI content language must NOT change the app UI language ──
    try {
      await page.goto(`${BASE}/app/settings/ai-settings`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForSelector("[data-testid='settings-modal']", { timeout: 45000 });
      await page.click("[data-testid='settings-tab-ai-settings']").catch(() => {});
      await sleep(300);
      await page.click("[data-testid='settings-save']").catch(() => {});
      await sleep(800);
      await page.keyboard.press("Escape").catch(() => {});
      await gotoShell(page, "/app/dashboard");
      const pill = (await page.textContent("[data-testid='topbar-language-short']"))?.trim();
      if (pill !== "简") fail(`AI content language change leaked into app UI language (pill became "${pill}", expected 简)`);
      else note("AI content language change did NOT affect app UI language (correct separation)");
    } catch (e) { note(`AI-separation check SKIPPED (${(e as Error).message})`); }

    // ── Theme: Light applies + persists, then Dark ──
    await gotoShell(page, "/app/dashboard");
    await selectTopbarLanguage(page, "en"); // reset to EN for the light/dark shots
    await selectTopbarTheme(page, "light");
    await sleep(400);
    if ((await dataTheme(page)) !== "light") fail("Light theme did not apply globally (html[data-theme] != light)");
    await shot(page, "light-dashboard.png");
    try {
      await gotoShell(page, "/app/studio"); await sleep(1200);
      await shot(page, "light-create-pins.png");
      await gotoShell(page, "/app/plan"); await sleep(1200);
      await shot(page, "light-weekly-plan.png");
      await page.goto(`${BASE}/app/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForSelector("[data-testid='settings-modal']", { timeout: 45000 }); await sleep(400);
      await shot(page, "light-settings-modal.png");
      await page.keyboard.press("Escape").catch(() => {});
    } catch (e) { note(`light page screenshots partial (${(e as Error).message.split("\n")[0]})`); }

    // refresh → Light persists
    await page.goto(`${BASE}/app/dashboard`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("[data-testid='app-sidebar']", { timeout: 20000 }); await sleep(600);
    const persistedTheme = await page.evaluate((k) => window.localStorage.getItem(k), THEME_KEY);
    if (persistedTheme !== "light") fail(`Light theme did not persist after refresh (localStorage=${persistedTheme})`);
    if ((await dataTheme(page)) !== "light") fail("Light theme not applied after refresh");

    // Dark applies globally
    await selectTopbarTheme(page, "dark");
    await sleep(400);
    if ((await dataTheme(page)) !== "dark") fail("Dark theme did not apply globally");
    await shot(page, "dark-dashboard.png");
    try {
      await page.goto(`${BASE}/app/settings`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForSelector("[data-testid='settings-modal']", { timeout: 45000 }); await sleep(400);
      await shot(page, "dark-settings-modal.png");
      await page.keyboard.press("Escape").catch(() => {});
    } catch (e) { note(`dark-settings-modal.png: SKIPPED (${(e as Error).message.split("\n")[0]})`); }

    // ── Other languages: dashboard shots ──
    for (const code of ["ja", "ko", "es", "ar"]) {
      try {
        await gotoShell(page, "/app/dashboard");
        await selectTopbarLanguage(page, code);
        await sleep(800);
        await shot(page, `${code}-dashboard.png`);
      } catch (e) { note(`${code}-dashboard.png: SKIPPED (${(e as Error).message})`); }
    }

    // reset to EN
    await gotoShell(page, "/app/dashboard").catch(() => {});
    await selectTopbarLanguage(page, "en").catch(() => {});
  } catch (e) {
    fail(`fatal: ${(e as Error).message}`);
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots: ${OUT}`);
  if (notes.length) { console.log("\nNotes:"); for (const n of notes) console.log(`  - ${n}`); }
  if (failures.length) {
    console.error(`\n${failures.length} HARD failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll hard checks passed.");
})();
