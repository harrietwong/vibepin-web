/**
 * WP0.1 acceptance §8 + §9, in a real browser, through the REAL Generate flow:
 *   §8 a Pin that is still generating appears immediately on the DEFAULT board
 *   §9 it does NOT appear under Scheduled / Posted / Failed
 *
 * /api/generate is stubbed to hang, so the board stays in exactly the state the user
 * sees while waiting on the provider. Nothing is written behind the store's back —
 * the cards come from the app's own Generate handler.
 */
import { chromium } from "@playwright/test";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GEN = '[data-testid="pin-board-card"][data-lifecycle="generating"]';

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  // Hang the generator: the request never resolves, so drafts stay "generating".
  await ctx.route("**/api/generate", () => { /* never fulfil */ });
  await ctx.route("**/api/ai-copy/**", r => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));


  const now = new Date().toISOString();
  const mk = (id: string, over: Record<string, unknown>) => ({
    id, imageUrl: PNG, keyword: "", category: "home-decor",
    title: `QA ${id}`, description: "d", altText: "a", destinationUrl: "",
    boardId: "b1", boardName: "Home Decor", weeklyPlanItemId: "",
    generationSessionId: "", scheduledDate: "", status: "needs_review",
    createdAt: now, updatedAt: now, source: "uploaded_image", ...over,
  });
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  // A resting card in each settled bucket, so "generating is absent" is proven against
  // a NON-empty filter view rather than an empty board.
  await ctx.addInitScript(([k, s]) => {
    try { window.localStorage.setItem(k as string, JSON.stringify({ drafts: s })); } catch { /* ignore */ }
  }, ["vp:pin_drafts:v1", {
    u1: mk("u1", {}),
    s1: mk("s1", { scheduledDate: tomorrow, scheduledTime: "10:00", addedToPlanAt: now }),
    p1: mk("p1", { postedAt: now, remotePinId: "rp1" }),
    f1: mk("f1", { publishError: "boom", failureType: "publish" }),
  }] as const);

  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:3000/app/studio", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="studio-board"]', { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Drive the real Generate flow from the seeded upload card (board-create-with-ai only
  // exists on an EMPTY board; with cards present, the AI entry point lives on the card).
  const card = page.locator('[data-testid="pin-board-card"][data-lifecycle="unscheduled"]').first();
  await card.click();                                   // expand
  await page.waitForTimeout(800);
  await card.getByTestId("card-generate-ai-image").first().click({ timeout: 15_000 });
  await page.waitForTimeout(1500);

  const gen = page.getByTestId("ai-version-generate");
  await gen.waitFor({ state: "visible", timeout: 15_000 });
  await gen.click({ timeout: 10_000 });
  await page.waitForTimeout(2000);

  // Close the drawer so the board is what we are looking at.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1200);

  const checks: Array<[string, boolean, boolean]> = [];

  // §8 — the default landing filter, untouched.
  const onDefault = await page.locator(GEN).count();
  checks.push(["§8 default board (unscheduled)", true, onDefault > 0]);
  await page.screenshot({ path: "artifacts/wp01-generating-default.png" });

  // §9 — absent from every settled bucket.
  for (const f of ["scheduled", "posted", "failed"] as const) {
    const tab = page.getByTestId(`board-filter-${f}`);
    if (await tab.count() === 0) { checks.push([`§9 ${f} — TAB MISSING`, false, true]); continue; }
    await tab.click();
    await page.waitForTimeout(1000);
    const present = await page.locator(GEN).count();
    const total = await page.locator('[data-testid="pin-board-card"]').count();
    checks.push([`§9 ${f} filter (${total} card(s) visible)`, false, present > 0]);
    await page.screenshot({ path: `artifacts/wp01-generating-${f}.png` });
  }

  console.log("\n=== WP0.1 §8/§9 — generating-card visibility (real browser, real Generate) ===");
  let bad = 0;
  for (const [name, want, got] of checks) {
    const ok = want === got;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} want ${want ? "VISIBLE" : "hidden"}, got ${got ? "VISIBLE" : "hidden"}`);
  }
  console.log(bad === 0 ? "\nAll checks passed." : `\n${bad} check(s) FAILED.`);
  await browser.close();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(e => { console.error("FATAL", e); process.exit(2); });
