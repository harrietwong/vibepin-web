/**
 * qa-plan-image-fallback.ts — Phase A: the Plan-side image fallbacks.
 *
 * The lifecycle suite covers the Create Pins board. These two surfaces are on the
 * Plan side and had their own, worse, fallback behaviour:
 *
 *   PlanListView        broken image faded to opacity 0.3 → a ghost of the
 *                       browser's broken-image glyph, unlabelled.
 *   PlanPinArea (Week)  broken image faded to opacity 0   → a completely blank
 *                       block with nothing to explain it.
 *
 * Both now fall back to a labelled placeholder. This asserts that in a browser,
 * using a deliberately unreachable image URL.
 *
 * Run (server must be up with E2E_TEST_MODE=true):
 *   BASE_URL=http://127.0.0.1:3111 npx tsx scripts/qa-plan-image-fallback.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3111";
const KEY = "vp:pin_drafts:v1";
const BROKEN = "https://127.0.0.1:9/unreachable-plan-thumb.jpg";

/**
 * Today, as YYYY-MM-DD. The Plan calendar opens on the CURRENT week, so a fixture
 * dated months out is never rendered — and every DOM assertion then passes
 * against an empty calendar. The fixture must land in the visible week.
 */
const CUR_WEEK_DAY = new Date().toISOString().slice(0, 10);

/** Two scheduled Pins so they land on the calendar/list, both with a dead image. */
const SEEDS: Record<string, Record<string, unknown>> = {
  QA_PLAN_BROKEN_1: {
    id: "QA_PLAN_BROKEN_1", pinId: "QA_PLAN_BROKEN_1", source: "ai_generated", category: "home",
    imageUrl: BROKEN, title: "QAPLAN BROKEN ONE", keyword: "qa plan broken 1",
    scheduledDate: CUR_WEEK_DAY, scheduledTime: "09:38",
    addedToPlanAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  QA_PLAN_BROKEN_2: {
    id: "QA_PLAN_BROKEN_2", pinId: "QA_PLAN_BROKEN_2", source: "ai_generated", category: "home",
    imageUrl: BROKEN, title: "QAPLAN BROKEN TWO", keyword: "qa plan broken 2",
    scheduledDate: CUR_WEEK_DAY, scheduledTime: "11:00",
    addedToPlanAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

/**
 * Every element that is meant to stand in for an image must have a non-empty
 * accessible name. A blank block with no name is exactly the defect being fixed.
 * Plain function + var only (esbuild __name instrumentation).
 */
async function fallbackAudit(page: Page) {
  return page.evaluate(function () {
    var out = { fallbacks: 0, unnamed: 0, ghosts: 0, names: [] as string[] };
    var nodes = document.querySelectorAll('[data-testid="pin-thumbnail-fallback"], [data-testid="plan-list-thumb-placeholder"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] as HTMLElement;
      out.fallbacks++;
      var name = n.getAttribute("aria-label") || (n.innerText || "").trim();
      if (!name) out.unnamed++;
      else if (out.names.indexOf(name) === -1) out.names.push(name);
    }
    // A "ghost" is a still-present <img> that failed to decode but was left in the
    // page at reduced/zero opacity — the previous behaviour on both surfaces.
    var imgs = document.querySelectorAll("img");
    for (var j = 0; j < imgs.length; j++) {
      var im = imgs[j] as HTMLImageElement;
      if (im.complete && im.naturalWidth === 0 && im.src.indexOf("unreachable-plan-thumb") !== -1) {
        out.ghosts++;
      }
    }
    return out;
  });
}

async function main() {
  console.log(`\nPlan image fallback — ${BASE}\n`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(function (a) {
    try { window.localStorage.setItem(a[0], JSON.stringify({ drafts: a[1] })); } catch (e) { /* ignore */ }
  }, [KEY, SEEDS] as unknown as [string, Record<string, unknown>]);

  const page = await ctx.newPage();
  const errs: string[] = [];
  let brokenRequests = 0;
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  page.on("request", r => {
    if (r.url().includes("unreachable-plan-thumb")) brokenRequests++;
  });

  // The Plan workspace renders the week strip (PlanPinArea) and can switch to List.
  await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(6000);

  const body = ((await page.locator("body").innerText().catch(() => "")) || "");
  check('Plan shows no bare "No image"', !/\bno image\b/i.test(body));

  const week = await fallbackAudit(page);
  // Guard against a vacuous pass. The week strip renders thumbnails only (no Pin
  // title text), so presence is measured by the fallback tiles themselves: if the
  // fixture never rendered there would be zero, and "no unlabelled fallback" would
  // be trivially true.
  check("the broken-image fixture actually rendered in the week view", week.fallbacks > 0,
    `fallbacks=${week.fallbacks} — the week assertions below would be vacuous`);
  console.log(`  [week view] fallbacks=${week.fallbacks} unnamed=${week.unnamed} ghosts=${week.ghosts} names=${JSON.stringify(week.names)}`);
  check("no unlabelled image fallback in the week view", week.unnamed === 0,
    `${week.unnamed} fallback element(s) had no accessible name`);
  check("no faded/blank broken <img> left in the week view", week.ghosts === 0,
    `${week.ghosts} broken image(s) still in the DOM`);

  // Switch to the List view, which is where PlanListView renders.
  const listBtn = page.locator('[data-testid="view-mode-list"]').first();
  if (await listBtn.count()) {
    await listBtn.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(4500);
  }
  const rows = await page.locator('[data-testid="plan-list-row"]').count();
  console.log(`  [list view] rows=${rows}`);
  if (rows > 0) {
    const list = await fallbackAudit(page);
    console.log(`  [list view] fallbacks=${list.fallbacks} unnamed=${list.unnamed} ghosts=${list.ghosts} names=${JSON.stringify(list.names)}`);
    check("every list thumbnail fallback is labelled", list.unnamed === 0,
      `${list.unnamed} unlabelled`);
    check("no faded broken <img> left in the list view", list.ghosts === 0,
      `${list.ghosts} broken image(s) still in the DOM`);
    check("at least one labelled fallback actually rendered", list.fallbacks > 0,
      `fallbacks=${list.fallbacks} (if 0, the assertions above are vacuous)`);
  } else {
    console.log("  (list view not reachable in this build — week-view assertions still apply)");
  }

  // No retry storm on either surface.
  await page.waitForTimeout(2500);
  check("unreachable thumb did not trigger a retry loop", brokenRequests <= 6,
    `${brokenRequests} request(s) for the dead URL`);

  const realErrs = errs.filter(e => !/favicon|401|analytics|net::ERR_/i.test(e));
  console.log(`\n  console errors (filtered): ${realErrs.length}`);
  realErrs.slice(0, 5).forEach(e => console.log(`    ${e.slice(0, 150)}`));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("QA RUN FAILED:", e); process.exit(1); });
