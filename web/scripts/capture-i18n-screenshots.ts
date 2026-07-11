/**
 * Real-app i18n screenshot capture (Playwright).
 *
 * Drives the actual running dev server: it opens Settings, switches the App
 * language through the real in-app control (Appearance -> Language ->
 * LanguageRegionPanel -> Save), verifies the UI text actually changed, then
 * captures screenshots. Nothing here is mocked or composited.
 *
 * Prereq: dev server running on http://localhost:3000 (npm --prefix web run dev).
 * Run:    npx tsx scripts/capture-i18n-screenshots.ts
 *
 * Output:
 *   web/tmp/i18n-global/screenshots/
 *   web/tmp/i18n-app-language/screenshots/
 */

import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const GLOBAL_DIR = join(process.cwd(), "tmp/i18n-global/screenshots");
const APPLANG_DIR = join(process.cwd(), "tmp/i18n-app-language/screenshots");
mkdirSync(GLOBAL_DIR, { recursive: true });
mkdirSync(APPLANG_DIR, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Expected localized "Settings" title per locale — used to assert the UI
// actually switched language before we trust a screenshot.
const SETTINGS_TITLE: Record<string, string> = {
  en: "Settings", "zh-CN": "设置", "zh-TW": "設定", es: "Ajustes", fr: "Paramètres",
  de: "Einstellungen", pt: "Configurações", ja: "設定", ko: "설정", it: "Impostazioni",
  nl: "Instellingen", pl: "Ustawienia", tr: "Ayarlar", id: "Pengaturan", vi: "Cài đặt",
  th: "การตั้งค่า", hi: "सेटिंग्स", ar: "الإعدادات", ru: "Настройки",
};

const BETA = ["it", "nl", "pl", "tr", "id", "vi", "th", "hi", "ar", "ru"];

/** Load a working app page so the shell (sidebar + top bar) is present. */
async function gotoAppShell(page: Page) {
  await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("[data-testid='app-sidebar']", { timeout: 30000 });
  await sleep(1000);
}

async function openSettings(page: Page) {
  // Route-based open: /app/settings auto-opens the modal (account tab). More
  // reliable than driving the account menu across many iterations.
  await page.goto(`${BASE}/app/settings`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("[data-testid='settings-modal']", { timeout: 30000 });
  await sleep(500);
}

async function clickTestId(page: Page, id: string) {
  await page.click(`[data-testid='${id}']`, { timeout: 8000 });
  await sleep(300);
}

/** Switch app language through the real in-app control and verify it took effect. */
async function selectAppLanguage(page: Page, code: string) {
  await openSettings(page);
  await clickTestId(page, "settings-tab-appearance");
  await sleep(300);
  if (BETA.includes(code)) {
    await clickTestId(page, "lang-more-languages"); // reveal the beta languages
  }
  await clickTestId(page, `lang-app-${code}`);
  await clickTestId(page, "lang-save-button");
  await sleep(900);

  // Verify: the Settings title now renders in the target language.
  const expected = SETTINGS_TITLE[code];
  const title = (await page.textContent("[data-testid='settings-modal'] h1")) ?? "";
  if (expected && title.trim() !== expected) {
    throw new Error(`Language switch to ${code} did not take effect — Settings title was "${title}", expected "${expected}"`);
  }
}

async function shot(page: Page, dir: string, name: string) {
  await page.screenshot({ path: join(dir, name) });
  console.log(`  ${name}`);
}

/**
 * The dashboard (workspace) page has a dev-only SSR quirk on direct GET, so we
 * reach it via in-app client navigation (clicking the Opportunities nav item),
 * which renders it without a server round-trip — exactly how a user gets there.
 */
async function captureDashboard(page: Page, dir: string, name: string) {
  await gotoAppShell(page);
  await page.click("[data-testid='nav-opportunities']").catch(() => {});
  await sleep(2500);
  await shot(page, dir, name);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const failures: string[] = [];

  try {
    // ── English baseline ──
    console.log("en");
    try {
    await selectAppLanguage(page, "en");
    await shot(page, GLOBAL_DIR, "en-settings-appearance.png");
    await shot(page, APPLANG_DIR, "appearance-app-language-english.png");
    await clickTestId(page, "settings-tab-ai-settings");
    await shot(page, GLOBAL_DIR, "en-settings-ai-settings.png");
    await captureDashboard(page, GLOBAL_DIR, "en-dashboard.png");
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(1800); await shot(page, GLOBAL_DIR, "en-create-pins.png");
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(1800); await shot(page, GLOBAL_DIR, "en-weekly-plan.png");
    } catch (e) { failures.push(`en: ${(e as Error).message}`); console.error(`  FAILED en: ${(e as Error).message}`); }

    // ── Simplified Chinese (headline) ──
    console.log("zh-CN");
    try {
    await selectAppLanguage(page, "zh-CN");
    await shot(page, GLOBAL_DIR, "zh-CN-settings-appearance.png");
    await shot(page, APPLANG_DIR, "appearance-app-language-zh-CN.png");
    await shot(page, APPLANG_DIR, "zh-CN-settings-modal.png");
    await clickTestId(page, "settings-tab-ai-settings");
    await shot(page, GLOBAL_DIR, "zh-CN-settings-ai-settings.png");
    await shot(page, APPLANG_DIR, "ai-settings-content-language-only.png");
    await captureDashboard(page, GLOBAL_DIR, "zh-CN-dashboard.png");
    await shot(page, APPLANG_DIR, "zh-CN-dashboard.png");
    await shot(page, GLOBAL_DIR, "zh-CN-sidebar.png");
    await shot(page, APPLANG_DIR, "zh-CN-sidebar.png");
    // create pins / weekly plan
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForSelector("[data-testid='app-sidebar']", { timeout: 30000 }).catch(() => {});
    await sleep(1800); await shot(page, GLOBAL_DIR, "zh-CN-create-pins.png");
    // account dropdown (open from the reliable studio shell)
    await page.click("[data-testid='account-menu-trigger']", { timeout: 10000 });
    await page.waitForSelector("[data-testid='account-menu']", { timeout: 10000 });
    await sleep(400);
    await shot(page, GLOBAL_DIR, "zh-CN-account-dropdown.png");
    await shot(page, APPLANG_DIR, "zh-CN-account-dropdown.png");
    await page.mouse.click(1430, 870); // dismiss the dropdown via outside click
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await sleep(1800); await shot(page, GLOBAL_DIR, "zh-CN-weekly-plan.png");
    } catch (e) { failures.push(`zh-CN: ${(e as Error).message}`); console.error(`  FAILED zh-CN: ${(e as Error).message}`); }

    // ── Languages that need dashboard + settings-appearance ──
    for (const code of ["zh-TW", "es", "ja", "ko", "ar"]) {
      console.log(code);
      try {
        await selectAppLanguage(page, code);
        await shot(page, GLOBAL_DIR, `${code}-settings-appearance.png`);
        await captureDashboard(page, GLOBAL_DIR, `${code}-dashboard.png`);
      } catch (e) { failures.push(`${code}: ${(e as Error).message}`); console.error(`  FAILED ${code}: ${(e as Error).message}`); }
    }

    // ── Every other locale: at least settings-appearance ──
    for (const code of ["fr", "de", "pt", "it", "nl", "pl", "tr", "id", "vi", "th", "hi", "ru"]) {
      console.log(code);
      try {
        await selectAppLanguage(page, code);
        await shot(page, GLOBAL_DIR, `${code}-settings-appearance.png`);
      } catch (e) { failures.push(`${code}: ${(e as Error).message}`); console.error(`  FAILED ${code}: ${(e as Error).message}`); }
    }

    // Reset back to English so the test account isn't left in another language.
    await selectAppLanguage(page, "en").catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\nGlobal:   ${GLOBAL_DIR}`);
  console.log(`AppLang:  ${APPLANG_DIR}`);
  if (failures.length) {
    console.error(`\n${failures.length} locale(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll locales captured and language switch verified.");
})();
