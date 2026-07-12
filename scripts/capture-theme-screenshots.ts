/**
 * Theme screenshot capture — drives the REAL running app via Playwright and
 * captures dark + light screenshots of every major route, plus the settings
 * modal, account dropdown, pin-details drawer and the appearance switcher.
 *
 * Prerequisites:
 *   • Dev/prod server running with E2E_TEST_MODE=true (bypasses Supabase auth).
 *   • Pass the base URL via BASE_URL (defaults to http://localhost:3100).
 *
 * Run:
 *   $env:E2E_TEST_MODE='true'; npm --prefix web run dev -- -p 3100   # in one shell
 *   $env:BASE_URL='http://localhost:3100'; npx tsx scripts/capture-theme-screenshots.ts
 *
 * Output: web/tmp/theme-light-dark/screenshots/{dark,light}-*.png
 *
 * Theme is forced per-run by seeding localStorage (the same key the app's
 * anti-FOUC script reads) before any page script executes, so every shot is a
 * genuine render of the app in that theme — no mockups, no image generation.
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const OUT_DIR = path.join(process.cwd(), "tmp", "theme-light-dark", "screenshots");
const THEME_KEY = "vp:appearance_theme:v1";
const VIEWPORT = { width: 1440, height: 900 };

type Theme = "dark" | "light";

type RouteShot = {
  name: string;        // file suffix, e.g. "dashboard"
  path: string;        // app route
  waitFor?: string;    // optional selector to wait for
};

// Routes that render a full page. `name` becomes `<theme>-<name>.png`.
const ROUTES: RouteShot[] = [
  { name: "dashboard",             path: "/app/dashboard" },
  { name: "opportunities",         path: "/app/workspace/home-decor" },
  { name: "create-pins",           path: "/app/studio" },
  { name: "weekly-plan",           path: "/app/plan" },
  { name: "my-pins",               path: "/app/history" },
  { name: "keyword-trends",        path: "/app/trends" },
  { name: "pin-ideas",             path: "/app/discover" },
  { name: "product-opportunities", path: "/app/products" },
];

const results: { shot: string; status: "ok" | "skipped" | "failed"; note?: string }[] = [];

function record(shot: string, status: "ok" | "skipped" | "failed", note?: string) {
  results.push({ shot, status, note });
  const icon = status === "ok" ? "✓" : status === "skipped" ? "—" : "✗";
  console.log(`  ${icon} ${shot}${note ? ` (${note})` : ""}`);
}

async function newPage(browser: Browser, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Seed the theme preference before any app script runs.
  await context.addInitScript(
    ([key, value]) => {
      try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
    },
    [THEME_KEY, theme],
  );
  return context.newPage();
}

async function gotoRoute(page: Page, route: RouteShot): Promise<void> {
  const res = await page.goto(BASE_URL + route.path, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (res && res.status() >= 500) throw new Error(`HTTP ${res.status()} at ${route.path}`);
  if (page.url().includes("/login")) {
    throw new Error(`redirected to /login — is E2E_TEST_MODE=true on the server at ${BASE_URL}?`);
  }
  // Sidebar is present on every /app page; its absence means the shell failed.
  await page.getByTestId("app-sidebar").waitFor({ state: "visible", timeout: 15_000 });
  if (route.waitFor) {
    await page.locator(route.waitFor).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  }
  // Let async data + fonts settle (heavy pages like the studio need a beat).
  await page.waitForTimeout(2500);
}

async function shoot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT_DIR, file) });
}

async function captureTheme(browser: Browser, theme: Theme): Promise<void> {
  console.log(`\n=== ${theme.toUpperCase()} MODE ===`);

  // ── Full-page routes ──
  for (const route of ROUTES) {
    const file = `${theme}-${route.name}.png`;
    const page = await newPage(browser, theme);
    try {
      await gotoRoute(page, route);
      await shoot(page, file);
      record(file, "ok");
    } catch (e) {
      record(file, "failed", (e as Error).message);
    } finally {
      await page.context().close();
    }
  }

  // ── Account dropdown + Settings modal + Appearance switcher + Billing ──
  // One sequence: open the account menu (screenshot it), then enter Settings.
  {
    const page = await newPage(browser, theme);
    try {
      await gotoRoute(page, { name: "x", path: "/app/studio" });
      const trigger = page.getByTestId("account-menu-trigger");
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      // Open the menu, retrying — the first click can land before hydration.
      let menuOpen = false;
      for (let attempt = 0; attempt < 4 && !menuOpen; attempt++) {
        await page.waitForTimeout(600);
        await trigger.click({ force: true });
        menuOpen = await page.getByTestId("account-menu-account").isVisible({ timeout: 2_500 }).catch(() => false);
      }
      if (!menuOpen) throw new Error("account dropdown did not open");
      await page.waitForTimeout(400);
      await shoot(page, `${theme}-account-dropdown.png`);
      record(`${theme}-account-dropdown.png`, "ok");

      await page.getByTestId("account-menu-account").click();
      await page.getByTestId("settings-modal").waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(500);
      await shoot(page, `${theme}-settings-modal.png`);
      record(`${theme}-settings-modal.png`, "ok");

      // Appearance tab → theme switcher
      await page.getByTestId("settings-tab-appearance").click();
      await page.getByTestId("appearance-theme-toggle").waitFor({ state: "visible", timeout: 5_000 });
      await page.waitForTimeout(400);
      await shoot(page, `${theme}-theme-switcher.png`);
      record(`${theme}-theme-switcher.png`, "ok");

      // Billing tab
      await page.getByTestId("settings-tab-billing").click();
      await page.waitForTimeout(500);
      await shoot(page, `${theme}-billing-or-upgrade.png`);
      record(`${theme}-billing-or-upgrade.png`, "ok");
    } catch (e) {
      record(`${theme}-settings-modal.png`, "failed", (e as Error).message);
    } finally {
      await page.context().close();
    }
  }

  // ── Pin details drawer/modal (best-effort — needs at least one pin) ──
  {
    const file = `${theme}-pin-details-modal-or-drawer.png`;
    const page = await newPage(browser, theme);
    try {
      await gotoRoute(page, { name: "x", path: "/app/history" });
      // Give the history feed time to load any pins from the API.
      await page.getByTestId("generated-pin-card").first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      // Try common pin triggers; the drawer carries data-theme so it's themed.
      const candidates = [
        '[data-testid="generated-pin-card"]',
        '[data-testid^="pin-card"]',
        "main img",
      ];
      let opened = false;
      for (const sel of candidates) {
        const el = page.locator(sel).first();
        if (await el.count() && await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 4_000 }).catch(() => {});
          const drawer = page.getByTestId("pin-details-drawer").first();
          if (await drawer.isVisible({ timeout: 4_000 }).catch(() => false)) { opened = true; break; }
        }
      }
      await page.waitForTimeout(800);
      if (opened) {
        await shoot(page, file);
        record(file, "ok");
      } else {
        await shoot(page, file);
        record(file, "skipped", "no pin available to open a drawer — captured My Pins page instead");
      }
    } catch (e) {
      record(file, "failed", (e as Error).message);
    } finally {
      await page.context().close();
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Capturing theme screenshots from ${BASE_URL}`);
  console.log(`Output: ${OUT_DIR}`);

  const browser = await chromium.launch();
  try {
    await captureTheme(browser, "dark");
    await captureTheme(browser, "light");
  } finally {
    await browser.close();
  }

  const ok = results.filter(r => r.status === "ok").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const failed = results.filter(r => r.status === "failed");
  console.log(`\n──────────────────────────────────────────`);
  console.log(`Captured: ${ok} ok, ${skipped} skipped, ${failed.length} failed`);
  if (failed.length) {
    console.log(`\nFailures:`);
    for (const f of failed) console.log(`  ✗ ${f.shot}: ${f.note}`);
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
