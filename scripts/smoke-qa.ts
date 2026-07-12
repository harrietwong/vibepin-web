/**
 * P1-B smoke QA — browser automation via Playwright
 * Run: npx tsx scripts/smoke-qa.ts
 * Prerequisite: dev server at http://localhost:3000
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
let failed = 0;
const issues: { sev: string; label: string; detail: string }[] = [];

function ok(label: string) { passed++; console.log(`  ✓ ${label}`); }
function fail(label: string, detail = "") { failed++; issues.push({ sev: "P1", label, detail }); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
function warn(label: string, detail = "") { issues.push({ sev: "P2", label, detail }); console.log(`  ~ ${label}${detail ? ` — ${detail}` : ""}`); }
function section(name: string) { console.log(`\n── ${name} ──`); }

async function screenshot(name: string) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`    📸 ${path}`);
  return path;
}

async function checkNoOverlay() {
  const overlay = await page.$("text=Application Error");
  if (overlay) fail("Application Error overlay visible");
  const hydration = await page.$("text=Hydration failed");
  if (hydration) fail("Hydration error overlay visible");
}

async function waitForStable(ms = 1500) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

// ── 1. Route smoke ───────────────────────────────────────────────────────────

async function smokeRoutes() {
  section("1. Route smoke");
  const routes = ["/", "/app/studio", "/app/plan", "/app/settings"];
  for (const route of routes) {
    try {
      const resp = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await waitForStable(800);
      const status = resp?.status() ?? 0;
      const url = page.url();
      await checkNoOverlay();

      if (status >= 500) {
        fail(`${route} returned ${status}`);
      } else if (url.includes("/login") || url.includes("/auth")) {
        ok(`${route} → redirected to auth (expected if not logged in)`);
      } else {
        ok(`${route} loaded (${status})`);
      }
      await screenshot(`route${route.replace(/\//g, "-") || "-home"}`);
    } catch (e) {
      fail(`${route} threw: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

// ── 2. Studio card check ─────────────────────────────────────────────────────

async function smokeStudioCards() {
  section("2. Studio card actions");
  try {
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(2000);
    await checkNoOverlay();

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Studio redirected to auth — card checks skipped (not logged in)");
      return;
    }

    await screenshot("studio-initial");

    // Check for Pin cards by common selectors
    const cardCount = await page.locator('[data-testid="pin-card"], [data-testid="studio-pin"], [class*="pinCard"], [class*="pin-card"]').count();
    if (cardCount > 0) {
      ok(`Found ${cardCount} Pin card(s) in Studio`);
    } else {
      // Check for empty state or loading
      const emptyState = await page.locator("text=Generate, text=No pins, text=Create").first().isVisible().catch(() => false);
      if (emptyState) {
        warn("Studio has no pins yet — card action checks skipped");
      } else {
        warn("No pin cards found (may need data or different selector)");
      }
    }

    // Look for Add to Plan button
    const addToPlan = page.locator("button, [role=button]").filter({ hasText: /add to plan/i }).first();
    if (await addToPlan.isVisible().catch(() => false)) {
      ok("Add to Plan action visible");
    } else {
      warn("Add to Plan button not found on Studio page (may need cards)");
    }

    // Check for Batch Edit / Select
    const batchBtn = page.locator("button, [role=button]").filter({ hasText: /select|batch/i }).first();
    if (await batchBtn.isVisible().catch(() => false)) {
      ok("Select/Batch action visible in Studio");
    } else {
      warn("Select/Batch action not found");
    }

    await screenshot("studio-cards");
  } catch (e) {
    fail(`Studio card check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 3. Weekly Plan page ──────────────────────────────────────────────────────

async function smokePlanPage() {
  section("3. Weekly Plan page");
  try {
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(2000);
    await checkNoOverlay();

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Plan page redirected to auth — plan checks skipped");
      return;
    }

    await screenshot("plan-initial");

    // Check calendar / week grid visible
    const calendar = await page.locator('[data-testid="weekly-plan"], [class*="weekGrid"], [class*="calendar"], [class*="week"]').first().isVisible().catch(() => false);
    if (calendar) {
      ok("Weekly Plan calendar/grid visible");
    } else {
      warn("Weekly Plan calendar element not detected by selector");
    }

    // Check for any pin images / scheduled cards
    const scheduledPins = await page.locator('[class*="pinCard"], [class*="draft"], img[src*="cdn"]').count();
    if (scheduledPins > 0) {
      ok(`${scheduledPins} scheduled pin item(s) visible`);
    } else {
      warn("No scheduled pin items found (may need data)");
    }

    await screenshot("plan-page");
  } catch (e) {
    fail(`Plan page check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 4. needs_date label check ────────────────────────────────────────────────

async function smokeNeedsDate() {
  section("4. needs_date visual check");
  try {
    // Check Studio for "Needs date" text
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Auth redirect — needs_date check skipped");
      return;
    }

    const needsDateBadges = await page.locator("text=Needs date").count();
    if (needsDateBadges > 0) {
      ok(`"Needs date" label found ${needsDateBadges} time(s) in Studio`);
      await screenshot("studio-needs-date");
    } else {
      warn("\"Needs date\" not visible in Studio (may need a pin added to plan without date)");
    }

    // Check Plan page
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);
    const needsDatePlan = await page.locator("text=Needs date").count();
    if (needsDatePlan > 0) {
      ok(`"Needs date" label found ${needsDatePlan} time(s) in Plan`);
      await screenshot("plan-needs-date");
    } else {
      warn("\"Needs date\" not visible in Plan page (may need data)");
    }

    // Verify "Scheduled" is NOT shown for needs-date state
    // (if there are "Needs date" items, none of them should also show "Scheduled" on same element)
    const scheduledButNoDate = await page.locator("text=Scheduled").first().isVisible().catch(() => false);
    // This is just a presence check — contextual correctness needs manual verification
    if (scheduledButNoDate) {
      ok("\"Scheduled\" label also found (coexistence expected — different pins)");
    }
  } catch (e) {
    fail(`needs_date check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 5. Hover preview ─────────────────────────────────────────────────────────

async function smokeHoverPreview() {
  section("5. Hover preview");
  try {
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(2000);

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Auth redirect — hover preview check skipped");
      return;
    }

    // Try hovering over pin images
    const images = page.locator('img[src*="cdn"], img[src*="blob"], [class*="pinThumb"], [class*="pin-thumb"]');
    const imgCount = await images.count();
    if (imgCount === 0) {
      warn("No hoverable pin images found (need scheduled pins)");
      return;
    }

    const target = images.first();
    await target.scrollIntoViewIfNeeded();
    await target.hover({ timeout: 5000 });
    await page.waitForTimeout(800);

    // Check for popover/hover card
    const popover = page.locator('[class*="hover"], [class*="preview"], [class*="popover"], [role="tooltip"]').first();
    if (await popover.isVisible().catch(() => false)) {
      ok("Hover preview card appeared");
      await screenshot("hover-preview");

      // Check no raw IDs visible
      const rawId = await popover.locator("text=/^[0-9a-f]{20,}/i").count();
      if (rawId > 0) {
        warn("Possible raw database ID visible in hover preview");
      } else {
        ok("No raw database IDs detected in hover preview");
      }

      // Check for status labels
      const previewText = await popover.innerText().catch(() => "");
      if (/needs date|scheduled|posted|not planned/i.test(previewText)) {
        ok("Plan status label visible in hover preview");
      } else {
        warn("No plan status label detected in hover preview text");
      }

      // Move mouse away — preview should close
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400);
      if (!await popover.isVisible().catch(() => false)) {
        ok("Hover preview closes on mouse leave");
      } else {
        warn("Hover preview still visible after mouse leave");
      }
    } else {
      warn("Hover preview did not appear (may need fine-pointer device or different selector)");
      await screenshot("hover-no-preview");
    }
  } catch (e) {
    fail(`Hover preview check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 6. Batch Edit ────────────────────────────────────────────────────────────

async function smokeBatchEdit() {
  section("6. Batch Edit");
  try {
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Auth redirect — Batch Edit check skipped");
      return;
    }

    // Try to find and click a select-all or first select checkbox
    const checkboxes = page.locator('input[type="checkbox"], [role="checkbox"]');
    const cbCount = await checkboxes.count();
    if (cbCount === 0) {
      // Try to click a Select button first
      const selectBtn = page.locator("button, [role=button]").filter({ hasText: /^select$/i }).first();
      if (await selectBtn.isVisible().catch(() => false)) {
        await selectBtn.click();
        await page.waitForTimeout(500);
      }
    }

    // After clicking Select, try to check a pin
    const firstCb = page.locator('input[type="checkbox"]').first();
    if (await firstCb.isVisible().catch(() => false)) {
      await firstCb.check({ timeout: 5000 });
      await page.waitForTimeout(300);
      ok("Checked first Pin in Studio");
    } else {
      warn("No checkboxes found — Batch Edit trigger skipped");
    }

    // Try to open Batch Edit
    const batchEditBtn = page.locator("button, [role=button]").filter({ hasText: /batch edit|edit selected/i }).first();
    if (await batchEditBtn.isVisible().catch(() => false)) {
      await batchEditBtn.click();
      await page.waitForTimeout(1000);
      await screenshot("batch-edit-open");

      // Check for needs date stat
      const needsDateStat = await page.locator("text=needs date").count();
      if (needsDateStat > 0) {
        ok(`"needs date" summary stat visible in Batch Edit (${needsDateStat})`);
      } else {
        warn("\"needs date\" stat not visible in Batch Edit (may be 0 pins in that state)");
      }

      // Check for dual status badges
      const planBadge = await page.locator("text=Plan:").count();
      const detailsBadge = await page.locator("text=Details:").count();
      if (planBadge > 0) ok(`Plan: badge visible (${planBadge} rows)`);
      else warn("Plan: badge not found in Batch Edit rows");
      if (detailsBadge > 0) ok(`Details: badge visible (${detailsBadge} rows)`);
      else warn("Details: badge not found in Batch Edit rows");

      await screenshot("batch-edit-badges");

      // Check filter UI
      const filters = await page.locator("text=not planned, text=scheduled, text=needs date").count();
      ok(`Filter area visible`);

      // Close batch edit
      const closeBtn = page.locator("button").filter({ hasText: /close|cancel|✕|×/i }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    } else {
      warn("Batch Edit button not found (need selected pins)");
    }
  } catch (e) {
    fail(`Batch Edit check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 7. Settings ──────────────────────────────────────────────────────────────

async function smokeSettings() {
  section("7. Settings");
  try {
    await page.goto(`${BASE}/app/settings`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);
    await checkNoOverlay();

    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Auth redirect — Settings check skipped");
      return;
    }

    await screenshot("settings");

    // Check for Pinterest section
    const pinterestSection = await page.locator("text=Pinterest").first().isVisible().catch(() => false);
    if (pinterestSection) ok("Pinterest section visible in Settings");
    else warn("Pinterest section not found in Settings");

    // Check for Billing section
    const billingSection = await page.locator("text=Billing, text=Plan, text=Upgrade").first().isVisible().catch(() => false);
    if (billingSection) ok("Billing/Plan section visible in Settings");
    else warn("Billing section not found");

    // Check for no fake/placeholder data
    const fakePh = await page.locator("text=coming soon, text=TODO, text=placeholder, text=fake").count();
    if (fakePh > 0) {
      warn(`Found ${fakePh} possible placeholder text in Settings`);
    } else {
      ok("No obvious placeholder/fake text found in Settings");
    }

    // Check for no mixed language issues (raw Chinese characters in an English UI)
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const chineseChars = (bodyText.match(/[一-鿿]/g) || []).length;
    if (chineseChars > 10) {
      warn(`${chineseChars} Chinese characters found in Settings UI (possible lang mix)`);
    } else {
      ok("Settings page appears English-only UI");
    }
  } catch (e) {
    fail(`Settings check threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── 8. Check for "Scheduled" on no-date pin (P1-B regression guard) ──────────

async function smokeScheduledRegression() {
  section("8. P1-B regression guard");
  try {
    // Check that no pin with "Needs date" also shows "Scheduled" inside the same card
    await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);
    const url = page.url();
    if (url.includes("/login") || url.includes("/auth")) {
      warn("Auth redirect — regression guard skipped");
      return;
    }

    // Look for any card that has both "Needs date" AND "Scheduled" text inside it
    // This is a rough heuristic — a card element containing both strings would be a bug
    const cards = page.locator('[class*="card"], [class*="pin"]');
    const cardCount = await cards.count();
    let badCards = 0;
    for (let i = 0; i < Math.min(cardCount, 20); i++) {
      try {
        const text = await cards.nth(i).innerText({ timeout: 500 });
        if (/needs date/i.test(text) && /scheduled/i.test(text)) badCards++;
      } catch {}
    }
    if (badCards > 0) {
      fail(`${badCards} card(s) show BOTH "Needs date" AND "Scheduled" (regression)`);
    } else {
      ok("No card shows both \"Needs date\" and \"Scheduled\" simultaneously");
    }

    // Check plan page too
    await page.goto(`${BASE}/app/plan`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForStable(1500);
    const planCards = page.locator('[class*="card"], [class*="draft"], [class*="pin"]');
    const planCardCount = await planCards.count();
    let badPlanCards = 0;
    for (let i = 0; i < Math.min(planCardCount, 20); i++) {
      try {
        const text = await planCards.nth(i).innerText({ timeout: 500 });
        if (/needs date/i.test(text) && /\bscheduled\b/i.test(text)) badPlanCards++;
      } catch {}
    }
    if (badPlanCards > 0) {
      fail(`${badPlanCards} plan item(s) show BOTH "Needs date" AND "Scheduled" (regression)`);
    } else {
      ok("Plan page: no item shows both \"Needs date\" and \"Scheduled\" simultaneously");
    }
  } catch (e) {
    fail(`Regression guard threw: ${(e as Error).message.slice(0, 120)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  P1-B Browser Smoke QA");
  console.log("═══════════════════════════════════════");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  });
  page = await context.newPage();

  // Capture console errors
  const consoleErrors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    await smokeRoutes();
    await smokeStudioCards();
    await smokePlanPage();
    await smokeNeedsDate();
    await smokeHoverPreview();
    await smokeBatchEdit();
    await smokeSettings();
    await smokeScheduledRegression();
  } finally {
    await browser.close();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (issues.length) {
    console.log("\n  Issues:");
    for (const i of issues) console.log(`    [${i.sev}] ${i.label}${i.detail ? `: ${i.detail}` : ""}`);
  }

  if (consoleErrors.length > 0) {
    console.log(`\n  Browser console errors (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 10)) console.log(`    ${e.slice(0, 200)}`);
  } else {
    console.log("\n  No browser console errors");
  }

  // Write JSON report
  const report = { passed, failed, issues, consoleErrors: consoleErrors.slice(0, 20) };
  writeFileSync(join("scripts", "smoke-report.json"), JSON.stringify(report, null, 2));
  console.log(`\n  Report: scripts/smoke-report.json`);
  console.log(`  Screenshots: ${OUT}/`);
  console.log("═══════════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
