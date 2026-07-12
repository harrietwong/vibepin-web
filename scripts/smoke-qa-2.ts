/**
 * P1-B smoke QA pass 2 — targeted checks with longer waits
 * Focuses on: data hydration, History tab, Settings interactions,
 *             plan page after full load, needs_date label search
 */
import { chromium, type Page, type Browser } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3000";
const OUT  = join("scripts", "smoke-screenshots");
mkdirSync(OUT, { recursive: true });

let browser: Browser;
let page: Page;
let passed = 0;
const findings: string[] = [];

function ok(label: string)   { passed++; console.log(`  ✓ ${label}`); }
function note(label: string) { findings.push(label); console.log(`  ℹ ${label}`); }
function section(name: string) { console.log(`\n── ${name} ──`); }

async function ss(name: string) {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`    📸 ${p}`);
}

async function goto(path: string, wait = 2500) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
    page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 })
  );
  await page.waitForTimeout(wait);
}

// ── 1. Auth state ─────────────────────────────────────────────────────────────
async function checkAuth() {
  section("1. Auth / session state");
  await goto("/app/studio", 3000);

  const tokenBadge = await page.locator("text=/\\d+ Token/").first().textContent().catch(() => "");
  if (tokenBadge) {
    ok(`Authenticated — token balance: ${tokenBadge.trim()}`);
  } else {
    note("Token badge not found — may not be logged in");
  }

  const userAvatar = await page.locator('[class*="avatar"], [class*="user-icon"]').first().isVisible().catch(() => false);
  if (userAvatar) ok("User avatar/icon visible");

  // Check for any hydration/error overlay
  const errors = await page.locator("text=Application Error, text=Hydration failed").count();
  if (errors === 0) ok("No Application Error or Hydration error");
  else note(`Found ${errors} error overlay(s)`);
}

// ── 2. Studio — History tab ────────────────────────────────────────────────────
async function checkHistory() {
  section("2. Studio History tab");
  await goto("/app/studio", 2000);

  // Click History button
  const historyBtn = page.locator("button, a, [role=button]").filter({ hasText: /history/i }).first();
  if (await historyBtn.isVisible().catch(() => false)) {
    await historyBtn.click();
    await page.waitForTimeout(2000);
    await ss("history-tab");

    // Count pin images in history
    const imgs = await page.locator('img[src*="cdn"], img[src*="http"]').count();
    ok(`History tab opened — ${imgs} image(s) visible`);

    // Look for "Added to Plan" tab / filter
    const addedTab = page.locator("button, [role=tab]").filter({ hasText: /added to plan/i }).first();
    if (await addedTab.isVisible().catch(() => false)) {
      await addedTab.click();
      await page.waitForTimeout(1500);
      await ss("history-added-to-plan");
      const addedImgs = await page.locator('img[src*="cdn"], img[src*="http"]').count();
      ok(`Added to Plan filter — ${addedImgs} image(s) visible`);

      // Check for "Needs date" label in history cards
      const needsDateCount = await page.locator("text=Needs date").count();
      if (needsDateCount > 0) {
        ok(`"Needs date" badge visible ${needsDateCount} time(s) in History`);
        await ss("history-needs-date-badge");
      } else {
        note(`No "Needs date" badges found (may have no added-without-date pins)`);
      }

      // Check "Scheduled" not showing for needs-date pins
      const scheduledCount = await page.locator("text=Scheduled").count();
      note(`"Scheduled" label count in Added-to-Plan view: ${scheduledCount}`);
    } else {
      note("Added to Plan tab not found in History");
    }
  } else {
    note("History button not found on Studio page");
    await ss("studio-no-history");
  }
}

// ── 3. Weekly Plan — full wait ────────────────────────────────────────────────
async function checkPlanFull() {
  section("3. Weekly Plan — full hydration wait");
  await goto("/app/plan", 4000);

  // After full wait, re-check loading state
  const stillLoading = await page.locator("text=Loading...").isVisible().catch(() => false);
  if (stillLoading) {
    note("Plan page still shows 'Loading...' after 4 s — data may be empty or API-gated");
  } else {
    ok("Plan page finished loading");
  }

  await ss("plan-full-load");

  // Check week stats bar
  const statsBar = await page.locator("text=/\\d+ planned/").first().textContent().catch(() => "");
  if (statsBar) {
    ok(`Week stats bar visible: "${statsBar.trim()}"`);
  } else {
    note("Week stats bar not detected");
  }

  // Check calendar/grid structure
  const dayCells = await page.locator('[class*="day"], [class*="column"], td').count();
  if (dayCells >= 7) ok(`Calendar day cells visible (${dayCells})`);
  else note(`Fewer than 7 day cells found (${dayCells}) — calendar may use different selectors`);

  // Smart Schedule button
  const smartSchedule = await page.locator("button").filter({ hasText: /smart schedule/i }).first().isVisible().catch(() => false);
  if (smartSchedule) ok("Smart Schedule button visible");
  else note("Smart Schedule button not visible");

  // Edit Plan button
  const editPlan = await page.locator("button").filter({ hasText: /edit plan/i }).first().isVisible().catch(() => false);
  if (editPlan) ok("Edit Plan button visible");

  // Create Pin button
  const createPin = await page.locator("button").filter({ hasText: /create pin/i }).first().isVisible().catch(() => false);
  if (createPin) ok("Create Pin button visible in Weekly Plan");

  // Needs-date tray
  const needsDateTray = await page.locator("text=Needs date, text=assign date, text=In plan").count();
  if (needsDateTray > 0) {
    ok(`Needs-date tray/label found (${needsDateTray})`);
    await ss("plan-needs-date-tray");
  } else {
    note("No needs-date tray visible (expected if no such pins)");
  }
}

// ── 4. Settings tabs ──────────────────────────────────────────────────────────
async function checkSettings() {
  section("4. Settings — tab navigation");
  await goto("/app/settings", 2000);
  await ss("settings-pinterest");

  // Pinterest spinner resolves?
  await page.waitForTimeout(2000);
  const stillChecking = await page.locator("text=Checking connection...").isVisible().catch(() => false);
  if (stillChecking) {
    note("Pinterest still shows 'Checking connection...' — Pinterest API likely 401");
  } else {
    const connectBtn = await page.locator("button").filter({ hasText: /connect|reconnect/i }).first().isVisible().catch(() => false);
    const disconnectBtn = await page.locator("button").filter({ hasText: /disconnect/i }).first().isVisible().catch(() => false);
    if (connectBtn) ok("Pinterest Connect/Reconnect button visible");
    if (disconnectBtn) ok("Pinterest Disconnect button visible");
    await ss("settings-pinterest-resolved");
  }

  // Profile tab
  const profileTab = page.locator("a, button, [role=tab]").filter({ hasText: /profile/i }).first();
  if (await profileTab.isVisible().catch(() => false)) {
    await profileTab.click();
    await page.waitForTimeout(1000);
    await ss("settings-profile");
    ok("Profile settings tab loaded");
  }

  // Billing tab
  const billingTab = page.locator("a, button, [role=tab]").filter({ hasText: /billing|credit/i }).first();
  if (await billingTab.isVisible().catch(() => false)) {
    await billingTab.click();
    await page.waitForTimeout(1500);
    await ss("settings-billing");
    const billingContent = await page.locator("text=Billing, text=Credits, text=Plan, text=Upgrade").count();
    if (billingContent > 0) ok("Billing/Credits section loaded");

    // Check no fake checkout / placeholder
    const fakeCheckout = await page.locator("text=TODO, text=placeholder, text=coming soon").count();
    if (fakeCheckout === 0) ok("No fake/placeholder billing content");
    else note(`${fakeCheckout} placeholder text(s) in Billing`);
  } else {
    note("Billing tab not found in Settings nav");
  }

  // Language tab
  const langTab = page.locator("a, button, [role=tab]").filter({ hasText: /language|region/i }).first();
  if (await langTab.isVisible().catch(() => false)) {
    await langTab.click();
    await page.waitForTimeout(800);
    await ss("settings-language");
    ok("Language & Region tab loaded");
  }

  // Support tab
  const supportTab = page.locator("a, button, [role=tab]").filter({ hasText: /support/i }).first();
  if (await supportTab.isVisible().catch(() => false)) {
    await supportTab.click();
    await page.waitForTimeout(800);
    await ss("settings-support");
    ok("Support tab loaded");
  }
}

// ── 5. Console error audit ────────────────────────────────────────────────────
async function checkConsoleFull() {
  section("5. Console error audit (cross-route)");
  const errors: string[] = [];
  const warnings: string[] = [];

  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  for (const route of ["/app/studio", "/app/plan", "/app/settings"]) {
    await goto(route, 1500);
  }

  const authErrors = errors.filter(e => e.includes("401") || e.includes("Unauthorized"));
  const realErrors = errors.filter(e => !e.includes("401") && !e.includes("Unauthorized") && !e.includes("400"));

  ok(`Total console errors: ${errors.length} (${authErrors.length} auth/401, ${realErrors.length} other)`);
  if (realErrors.length > 0) {
    note(`Non-auth errors:`);
    realErrors.slice(0, 5).forEach(e => note(`  ${e.slice(0, 180)}`));
  }
  if (warnings.length > 0) {
    note(`Console warnings: ${warnings.length} (first: ${warnings[0]?.slice(0, 100)})`);
  }
}

// ── 6. Dark theme integrity ────────────────────────────────────────────────────
async function checkTheme() {
  section("6. Dark theme integrity");
  await goto("/app/studio", 1500);

  // Check background color of body/main
  const bgColor = await page.evaluate(() => {
    const el = document.body;
    return window.getComputedStyle(el).backgroundColor;
  });
  note(`Body background: ${bgColor}`);
  if (bgColor && !bgColor.includes("255, 255, 255")) {
    ok("Body background is not white — dark theme active");
  } else {
    note("Body appears white — theme check inconclusive");
  }

  // Check nav is visible
  const nav = await page.locator('[class*="sidebar"], [class*="nav"], nav').first().isVisible().catch(() => false);
  if (nav) ok("Navigation sidebar visible");

  // No visible white flash or light-mode class
  const lightMode = await page.locator('[class*="light-mode"], [data-theme="light"]').count();
  if (lightMode === 0) ok("No light-mode class detected");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  P1-B Smoke QA Pass 2 — Targeted");
  console.log("═══════════════════════════════════════");

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Persist localStorage by using a state file if it exists
  });
  page = await ctx.newPage();

  try {
    await checkAuth();
    await checkHistory();
    await checkPlanFull();
    await checkSettings();
    await checkTheme();
    await checkConsoleFull();
  } finally {
    await browser.close();
  }

  console.log("\n═══════════════════════════════════════");
  console.log(`  Pass 2: ${passed} verified`);
  if (findings.length) {
    console.log(`\n  Notes (${findings.length}):`);
    findings.forEach(f => console.log(`    ℹ ${f}`));
  }
  console.log(`  Screenshots: ${OUT}/`);
  console.log("═══════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exit(1); });
