/**
 * qa-tc-suite-0818.ts - test-case V1 (docs/prd/20260818) browser execution.
 *
 * VERIFY ONLY. Seeds synthetic fixtures into localStorage and reads the DOM.
 * Never writes to any database, never publishes, never touches Production.
 *
 * Covers the browser-observable cases: TC-010..015, TC-020/021, TC-030..034,
 * TC-040/041, TC-110..112, TC-150/151.
 *
 * Cases needing real provider accounts or a due-time cron tick (TC-050..056,
 * TC-060..074, TC-080..094, TC-100..102, TC-160..164, TC-170/171) are NOT
 * asserted here - they are reported from source/DB evidence instead.
 *
 * Run:  BASE_URL=http://127.0.0.1:3111 npx tsx scripts/qa-tc-suite-0818.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3111";
const KEY = "vp:pin_drafts:v1";
// A REAL, locally-servable asset. An unreachable fixture URL (the old fake
// pinimg path) is blocked by the browser (ERR_BLOCKED_BY_ORB), so the card
// correctly falls back to the placeholder - which makes TC-030 untestable and
// its result race-dependent. TC-030 asks whether the FINAL IMAGE is preferred,
// so the fixture image has to actually load.
const IMG = "/icon-512.png";
const BROKEN = "https://127.0.0.1:9/definitely-not-reachable.jpg";

const SEEDS: Record<string, Record<string, unknown>> = {
  TC_PIN_01: {
    id: "TC_PIN_01", pinId: "TC_PIN_01", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "TCPIN01 UNSCHEDULED", keyword: "tc01",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  TC_PIN_02: {
    id: "TC_PIN_02", pinId: "TC_PIN_02", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "TCPIN02 SCHEDULED", keyword: "tc02",
    scheduledDate: "2026-09-20", scheduledTime: "09:38", addedToPlanAt: "2026-08-01T00:00:00.000Z",
    boardId: "boardA", boardName: "Board A", targetConnectionId: "connA",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  TC_PIN_03: {
    id: "TC_PIN_03", pinId: "TC_PIN_03", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "TCPIN03 POSTED", keyword: "tc03",
    postedAt: "2026-08-15T09:38:00.000Z", remotePinId: "999111",
    remotePinUrl: "https://www.pinterest.com/pin/999111/",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-15T09:38:00.000Z",
  },
  // Publish failure that HAS a final image - TC-030 requires it be shown.
  TC_PIN_07: {
    id: "TC_PIN_07", pinId: "TC_PIN_07", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "TCPIN07 PUBLISH FAILED", keyword: "tc07",
    failureType: "publish", publishError: "Board unavailable", errorCategory: "content",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
    previousScheduledTime: "2026-08-15T09:38:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-15T09:38:00.000Z",
  },
  // Generation failure, no image at all - must hit the placeholder (TC-032).
  TC_PIN_08: {
    id: "TC_PIN_08", pinId: "TC_PIN_08", source: "ai_generated", category: "home",
    imageUrl: "", generationStatus: "failed", title: "TCPIN08 GENERATION FAILED", keyword: "tc08",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  // TC-033: unreachable URL - must degrade, not loop.
  TC_PIN_09: {
    id: "TC_PIN_09", pinId: "TC_PIN_09", source: "ai_generated", category: "home",
    imageUrl: BROKEN, failureType: "publish", publishError: "Network error",
    title: "TCPIN09 BROKEN URL", keyword: "tc09",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  // TC-034: historical failed record with no recoverable image.
  TC_PIN_10: {
    id: "TC_PIN_10", pinId: "TC_PIN_10", source: "ai_generated", category: "home",
    imageUrl: "", failureType: "publish", publishError: "Legacy failure",
    title: "TCPIN10 HISTORIC FAILED", keyword: "tc10",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  },
};

type R = "PASS" | "FAIL" | "BLOCKED" | "NOT IMPLEMENTED";
const results: Array<{ tc: string; r: R; note: string }> = [];
function rec(tc: string, r: R, note = "") {
  results.push({ tc, r, note });
  console.log(`  ${r.padEnd(16)} ${tc}${note ? ` - ${note}` : ""}`);
}
function verdict(tc: string, ok: boolean, note = "", failNote = "") {
  rec(tc, ok ? "PASS" : "FAIL", ok ? note : (failNote || note));
}

/**
 * Which drafts the canonical selector puts in Unscheduled (page-side recompute).
 * NOTE: plain function + var only - tsx/esbuild rewrites arrow functions and
 * nested declarations into __name(...) calls that do not exist in page context.
 */
async function traySet(page: Page): Promise<string[]> {
  return page.evaluate(function (k) {
    var raw = window.localStorage.getItem(k);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    var drafts = (parsed && parsed.drafts) || {};
    var out = [];
    for (var id in drafts) {
      var d = drafts[id];
      var arch = typeof d.archivedAt === "string" ? d.archivedAt.trim() : "";
      var sch = typeof d.scheduledDate === "string" ? d.scheduledDate.trim() : "";
      var add = typeof d.addedToPlanAt === "string" ? d.addedToPlanAt.trim() : "";
      var po = typeof d.postedAt === "string" ? d.postedAt.trim() : "";
      var rp = typeof d.remotePinId === "string" ? d.remotePinId.trim() : "";
      var pe = typeof d.publishError === "string" ? d.publishError.trim() : "";
      if (arch) continue;
      if (sch) continue;
      if (add) continue;
      if (d.source === "uploaded_image" || d.source === "ai_generated_from_upload") continue;
      if (po || rp) continue;
      if (d.failureType === "publish" && pe) continue;
      if (d.generationStatus === "failed") continue;
      out.push(String(d.id));
    }
    return out;
  }, KEY);
}

/** Titles of rendered pin-board cards on the current filter. */
async function cardTitles(page: Page): Promise<string[]> {
  const loc = page.locator('[data-testid="pin-board-card"]');
  const n = await loc.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(((await loc.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim());
  }
  return out;
}

async function gotoFilter(page: Page, f: string) {
  await page.goto(`${BASE}/app/studio?filter=${f}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3800);
}

async function main() {
  console.log(`\n=== TC suite (docs/prd 20260818 V1) - ${BASE} ===\n`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(function (a) {
    try { window.localStorage.setItem(a[0], JSON.stringify({ drafts: a[1] })); } catch (e) { /* ignore */ }
  }, [KEY, SEEDS] as unknown as [string, Record<string, unknown>]);

  const page = await ctx.newPage();
  const errs: string[] = [];
  const imgReqs: Record<string, number> = {};
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  page.on("request", r => {
    if (r.resourceType() === "image") imgReqs[r.url()] = (imgReqs[r.url()] ?? 0) + 1;
  });

  // -- section 5: lifecycle mutual exclusion --------------------------------
  console.log("--- 5. Create Pins lifecycle ---");
  await gotoFilter(page, "unscheduled");
  const tray = await traySet(page);
  const unschList = await cardTitles(page);
  const unschCards = unschList.join(" | ").toUpperCase();
  console.log(`      [rendered unscheduled cards: ${unschList.length}]`);

  verdict("TC-010", tray.includes("TC_PIN_01") && unschCards.includes("TCPIN01"),
    `tray=${JSON.stringify(tray)}; DOM shows the draft`,
    `new draft missing from Unscheduled; tray=${JSON.stringify(tray)} dom="${unschCards.slice(0, 140)}"`);
  verdict("TC-011", !tray.includes("TC_PIN_02") && !unschCards.includes("TCPIN02"),
    "scheduled Pin absent from Unscheduled (selector + DOM)");
  verdict("TC-012", !tray.includes("TC_PIN_03") && !unschCards.includes("TCPIN03"),
    "posted Pin absent from Unscheduled (selector + DOM)",
    "P0: posted Pin re-entered Unscheduled");
  verdict("TC-013", !tray.includes("TC_PIN_07") && !unschCards.includes("TCPIN07"),
    "publish-failed absent from Unscheduled (selector + DOM)");
  verdict("TC-014", !tray.includes("TC_PIN_08") && !unschCards.includes("TCPIN08"),
    "generation-failed absent from Unscheduled (selector + DOM)");

  // TC-015: each fixture appears under exactly one lifecycle tab (All excluded).
  const membership: Record<string, string[]> = {};
  for (const f of ["unscheduled", "scheduled", "posted", "failed"]) {
    await gotoFilter(page, f);
    const blob = (await cardTitles(page)).join(" | ").toUpperCase();
    for (const t of ["TCPIN01", "TCPIN02", "TCPIN03", "TCPIN07", "TCPIN08"]) {
      if (blob.includes(t)) (membership[t] ??= []).push(f);
    }
  }
  const multi = Object.entries(membership).filter(([, v]) => v.length > 1);
  verdict("TC-015", multi.length === 0,
    `single-lifecycle map: ${JSON.stringify(membership)}`,
    `overlap: ${JSON.stringify(multi)} full=${JSON.stringify(membership)}`);

  // -- section 6: Plan right rail -------------------------------------------
  console.log("\n--- 6. Plan right-side Unscheduled ---");
  await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4200);
  const planText = ((await page.locator("body").innerText().catch(() => "")) || "").toUpperCase();
  const planTray = await traySet(page);
  verdict("TC-020",
    !planTray.some(id => ["TC_PIN_02", "TC_PIN_03", "TC_PIN_07", "TC_PIN_08"].includes(id))
      && !planText.includes("TCPIN03 POSTED"),
    `plan tray=${JSON.stringify(planTray)}; no posted title in page text`);

  // TC-021 refresh half only; the live post-publish half needs a real publish.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4000);
  const after = await traySet(page);
  verdict("TC-021", JSON.stringify([...after].sort()) === JSON.stringify([...planTray].sort()),
    `refresh-stable: ${JSON.stringify(after)} (live removal without refresh: see report)`);

  // -- section 7: Failed images ---------------------------------------------
  console.log("\n--- 7. Failed images ---");
  await gotoFilter(page, "failed");
  const failedBody = ((await page.locator("body").innerText().catch(() => "")) || "");
  const failedCards = await cardTitles(page);
  console.log(`      [rendered failed cards: ${failedCards.length}]`);

  // TC-030: the publish-failure card with a final image must render that image.
  const img07n = await page.locator('img[src*="icon-512.png"]').count();
  verdict("TC-030", img07n > 0 && failedCards.join(" ").toUpperCase().includes("TCPIN07"),
    `final image rendered (${img07n} img node(s) with the seeded src)`,
    `publish-failure card did not render the final image (imgs=${img07n}, cards=${failedCards.length})`);

  // TC-032: generation failure with no image -> labelled placeholder.
  // Only the placeholder DIV carries the label; the sibling testid is the <img>
  // used when a source image DOES resolve, and an <img> has no innerText - unioning
  // the two selectors made .first() land on the image and read as unlabelled.
  const ph = page.locator('[data-testid="card-generation-failed-placeholder"]');
  const phn = await ph.count();
  const phText = phn ? (((await ph.first().innerText().catch(() => "")) || "").trim()) : "";
  const phAria = phn ? ((await ph.first().getAttribute("aria-label")) ?? "") : "";
  verdict("TC-032", phn > 0 && !!(phText || phAria) && !/^no image$/i.test(phText),
    `placeholder n=${phn} text="${phText}" aria="${phAria}"`,
    `no labelled placeholder for generation failure (n=${phn})`);

  // TC-034: historical failed record with nothing recoverable.
  verdict("TC-034", !/\bno image\b/i.test(failedBody),
    "historic failed record shows no bare 'No image'");

  // TC-033: broken URL must not retry forever.
  await page.waitForTimeout(3000);
  const brokenCount = Object.entries(imgReqs)
    .filter(([u]) => u.includes("definitely-not-reachable"))
    .reduce((a, [, n]) => a + n, 0);
  verdict("TC-033", brokenCount <= 3 && !/\bno image\b/i.test(failedBody),
    `broken-url image requests=${brokenCount} (no retry storm); safe fallback rendered`,
    `possible retry loop: ${brokenCount} requests for the unreachable URL`);

  // -- section 8: Failed copy -----------------------------------------------
  console.log("\n--- 8. Failed copy ---");
  const reconnectN = await page.locator("text=/reconnect/i").count();
  verdict("TC-041", reconnectN === 0,
    "content/network failures do NOT offer Reconnect",
    `Reconnect shown for a non-auth failure (n=${reconnectN})`);
  const rawLeak = /(42P01|stack trace|undefined is not|TypeError|ECONN)/i.test(failedBody);
  verdict("TC-040", !rawLeak, "no raw provider/internal response in the failure copy");

  // -- section 16: card visual state ----------------------------------------
  console.log("\n--- 16. Card visual state ---");
  const visual: Array<[string, string]> = [["TC-110", "scheduled"], ["TC-111", "posted"], ["TC-112", "failed"]];
  for (const [tc, f] of visual) {
    await gotoFilter(page, f);
    const badge = page.locator('[data-testid="card-status-badge"]');
    const bn = await badge.count();
    const btxt = bn ? (((await badge.first().innerText().catch(() => "")) || "").trim()) : "";
    const svgN = bn ? await badge.first().locator("svg").count() : 0;
    // Text present = not colour-only. Icon presence recorded, not asserted as PASS gate.
    verdict(tc, bn > 0 && btxt.length > 0,
      `badge text="${btxt}" icon_svg=${svgN}${svgN === 0 ? " (TEXT-ONLY: no icon inside badge)" : ""}`,
      `no status badge text on the ${f} card (n=${bn})`);
  }

  // -- section 20: Plan entry -----------------------------------------------
  console.log("\n--- 20. Plan entry ---");
  await gotoFilter(page, "all");
  const tabs = page.locator('[data-testid="board-filters"] a, [data-testid="board-filters"] button');
  const tn = await tabs.count();
  const tabLabels: string[] = [];
  for (let i = 0; i < tn; i++) {
    tabLabels.push((((await tabs.nth(i).innerText()) || "").replace(/\s+/g, " ").trim()));
  }
  const planIsTab = (await page.locator('[data-testid="board-filter-plan"]').count()) > 0;
  verdict("TC-150", !planIsTab,
    `tabs=${JSON.stringify(tabLabels)}`,
    `Plan still sits inside the lifecycle tab row: ${JSON.stringify(tabLabels)}`);

  await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3500);
  const planUrl = page.url().replace(BASE, "");
  const boardStillThere = (await page.locator('[data-testid="pin-board-card"]').count()) > 0;
  verdict("TC-151", boardStillThere,
    `Plan keeps the board workspace visible at ${planUrl}`,
    `Plan replaces the Create Pins workspace (navigated to ${planUrl}); expected a right-side panel`);

  const realErrs = errs.filter(e => !/favicon|401|analytics|net::ERR_/i.test(e));
  console.log(`\n  console errors (filtered): ${realErrs.length}`);
  realErrs.slice(0, 6).forEach(e => console.log(`    ${e.slice(0, 150)}`));

  await page.screenshot({ path: "qa-tc-plan-view.png", fullPage: false }).catch(() => {});
  await browser.close();

  const c = (r: R) => results.filter(x => x.r === r).length;
  console.log(`\n=== TOTAL ${results.length} | PASS ${c("PASS")} | FAIL ${c("FAIL")} | BLOCKED ${c("BLOCKED")} | NOT IMPLEMENTED ${c("NOT IMPLEMENTED")} ===`);
  const fails = results.filter(r => r.r === "FAIL");
  console.log(fails.length ? fails.map(r => `  FAIL ${r.tc}: ${r.note}`).join("\n") : "  (no FAIL)");
  process.exit(0);
}

main().catch(e => { console.error("SUITE CRASH:", e); process.exit(1); });
