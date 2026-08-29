/**
 * Reference-recommendations REAL-BROWSER QA (P0-a / P0-b / P0-e).
 *
 * What this proves — and what it does not:
 *
 *   PROVES: the drawer's CLIENT behaviour in a real browser. Which requests it makes
 *   (and does NOT make), what it puts in them, and which of the three honest states it
 *   renders. Every API is mocked at the network layer, so nothing is written anywhere.
 *
 *   DOES NOT PROVE: the server half. Ranking, sampling, category canonicalization and
 *   the served block were verified separately against production data (read-only smoke,
 *   see docs/审查报告/0827 …-fable.md §10). A fully un-mocked end-to-end run belongs to
 *   the deploy session's preview QA.
 *
 * The states under test only exist for specific analysis states, so each case gets its
 * own seeded draft rather than trying to drive one draft through every state:
 *
 *   qa_never  imageAnalysisStatus absent   → backfill fires exactly once (P0-a)
 *   qa_failed status "failed"              → NO automatic retry, manual CTA offered (P0-a/b)
 *   qa_rate   failed + rate_limited + 3s   → countdown, then the CTA returns (P0-b)
 *   qa_ready  status "ready"               → "no strong match" + Show different ideas (P0-b/e)
 *
 * Run:
 *   $env:E2E_TEST_MODE='true'; npx next dev -p 3123      # server (from web/)
 *   npx tsx scripts/qa-reference-recs-browser.ts
 *
 * Output: pass/fail per item + screenshots in artifacts/reference-recs-qa/.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3123";
const OUT = path.join(process.cwd(), "artifacts", "reference-recs-qa");
fs.mkdirSync(OUT, { recursive: true });

const DRAFT_KEY = "vp:pin_drafts:v1";
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMG = `data:image/png;base64,${PNG_1x1}`;

// ── result bookkeeping ─────────────────────────────────────────────────────────
const results: Array<{ item: string; status: "PASS" | "FAIL"; note?: string }> = [];
function check(item: string, ok: boolean, note?: string) {
  results.push({ item, status: ok ? "PASS" : "FAIL", note });
  console.log(`  ${ok ? "✓" : "✗"} ${item}${note ? ` — ${note}` : ""}`);
}

// ── seeds ──────────────────────────────────────────────────────────────────────
const ANALYSIS = {
  imageSummary: "A cream matte ceramic vase holding dried pampas grass on a wooden side table",
  visibleObjects: ["ceramic vase", "pampas grass"],
  colors: ["cream", "beige"],
  style: "minimalist scandinavian",
  imageCategory: "home-decor",
};

function draft(id: string, title: string, day: number, extra: Record<string, unknown> = {}) {
  // Distinct createdAt: the store sorts by it, so the board order is deterministic.
  const at = `2026-08-0${day}T00:00:00.000Z`;
  return {
    id, pinId: id, source: "uploaded_image", category: "home-decor",
    imageUrl: IMG, title, keyword: "qa",
    createdAt: at, updatedAt: at,
    ...extra,
  };
}

const SEEDS: Record<string, Record<string, unknown>> = {
  // No analysis ever ran: the drawer must backfill it.
  qa_never: draft("qa_never", "QA NEVER ANALYSED", 4),
  // A previous analysis failed for a non-rate-limit reason: never auto-retried.
  qa_failed: draft("qa_failed", "QA ANALYSIS FAILED", 3, {
    imageAnalysisStatus: "failed", imageAnalysisError: "other",
  }),
  // Rate-limited with a server-supplied Retry-After.
  qa_rate: draft("qa_rate", "QA RATE LIMITED", 2, {
    imageAnalysisStatus: "failed", imageAnalysisError: "rate_limited", imageAnalysisRetryAfter: 3,
  }),
  // Analysed successfully — so a category_fallback answer means "nothing close", not
  // "we never looked", and the UI must say so without offering an analyse button.
  qa_ready: draft("qa_ready", "QA ANALYSED READY", 1, {
    imageAnalysisStatus: "ready", imageAnalysisUpdatedAt: "2026-08-01T00:00:00.000Z",
    ...ANALYSIS,
  }),
};

// ── recorded traffic ───────────────────────────────────────────────────────────
type RecRequest = { body: Record<string, unknown>; at: number };
const recRequests: RecRequest[] = [];
let analyzeCalls = 0;
const beacons: Array<{ event: string; payload: Record<string, unknown> }> = [];

const REF_A = ["ref-a1", "ref-a2", "ref-a3", "ref-a4", "ref-a5", "ref-a6"];
const REF_B = ["ref-b1", "ref-b2", "ref-b3", "ref-b4", "ref-b5", "ref-b6"];

function items(ids: string[]) {
  return ids.map((id, i) => ({
    id,
    imageUrl: IMG,
    title: `QA reference ${id}`,
    category: "Home decor",
    reason: `Home decor inspiration ${i + 1}`,
    source: "pinterest",
    sourceUrl: `https://www.pinterest.com/pin/${id}/`,
    pinterestUrl: `https://www.pinterest.com/pin/${id}/`,
    patternTags: { visualFormat: "lifestyle", compositionType: "scene" },
  }));
}

/** The server contract: a `served` block accompanies every successful answer. */
function served(ids: string[], requestId: unknown, excludedCount: number) {
  return {
    requestId: typeof requestId === "string" ? requestId : "qa-missing",
    categoryInput: "home-decor", categoryCanonical: "home-decor",
    poolMode: "single", poolSize: 300, poolHash: "qa00qa00qa00qa00",
    excludedCount, tier1Count: 0, tier2Count: ids.length, ids,
    recommendationBasis: "category_fallback",
  };
}

async function installMocks(context: BrowserContext) {
  // Recommendations: the A set normally, the B set once the client starts excluding.
  await context.route("**/api/reference-candidates", async r => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(r.request().postData() ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
    recRequests.push({ body, at: Date.now() });
    const excludeIds = Array.isArray(body.excludeIds) ? (body.excludeIds as string[]) : [];
    const ids = excludeIds.length ? REF_B : REF_A;
    return r.fulfill({ json: {
      items: items(ids), itemCount: ids.length,
      source: "reference_candidates_product_aware",
      recommendationBasis: "category_fallback",
      served: served(ids, body.requestId, excludeIds.length),
    } });
  });

  // Image analysis: counted, and slow enough that "pending" is observable.
  await context.route("**/api/ai-copy/analyze", async r => {
    analyzeCalls++;
    await new Promise(res => setTimeout(res, 400));
    return r.fulfill({ json: {
      ok: true,
      analysis: { ...ANALYSIS, category: "home-decor", ocrText: "", model: "qa" },
      recommendedKeywords: ["living room decor ideas"], keywordSource: "pinterest_high_search",
      timingsMs: { analysis: 1, keywords: 1, total: 2 },
    } });
  });

  // Analytics beacons carry the client half of the requestId join.
  await context.route("**/api/analytics/events", async r => {
    try {
      const parsed = JSON.parse(r.request().postData() ?? "{}") as { events?: unknown };
      const list = Array.isArray(parsed.events) ? parsed.events : [];
      for (const e of list as Array<Record<string, unknown>>) {
        beacons.push({ event: String(e.event ?? ""), payload: (e.payload ?? {}) as Record<string, unknown> });
      }
    } catch { /* a malformed beacon is the app's problem, not this mock's */ }
    return r.fulfill({ status: 204, body: "" });
  });

  // Ambient endpoints the board touches — mocked only to keep the page quiet.
  await context.route("**/api/pinterest/status**", r => r.fulfill({ json: {
    connected: true, account: { id: "qa", username: "qa-user", accountType: "BUSINESS" },
    scopes: ["boards:read", "pins:read", "pins:write", "boards:write"],
    needsReconnect: false, lastSyncedAt: null, connectionSource: "db",
    apiEnv: "sandbox", environment: "sandbox",
  } }));
  await context.route("**/api/pinterest/boards**", r => r.fulfill({ json: {
    items: [{ id: "b1", name: "Home Decor" }], bookmark: null,
  } }));
  await context.route("**/api/social/connections**", r => r.fulfill({ json: { platforms: [
    { provider: "pinterest", status: "connected", connected: true, accountCount: 1,
      accountName: "qa-user", liveConnect: true, accounts: [] },
  ] } }));
  await context.route("**/api/pin-drafts**", r => r.fulfill({ json: { ok: true, drafts: [] } }));
}

// ── drawer helpers ─────────────────────────────────────────────────────────────
/** Board cards carry their title in an input VALUE, not as text, so find by value. */
async function cardIndexByTitle(page: Page, title: string): Promise<number> {
  return page.locator('[data-testid="pin-board-card"]').evaluateAll((nodes, t) =>
    nodes.findIndex(n => {
      const input = n.querySelector('[data-testid="board-card-title"]') as HTMLInputElement | null;
      return !!input && input.value === t;
    }), title);
}

async function openDrawer(page: Page, draftId: string) {
  const title = SEEDS[draftId].title as string;
  const idx = await cardIndexByTitle(page, title);
  if (idx < 0) throw new Error(`no board card titled "${title}"`);
  const card = page.locator('[data-testid="pin-board-card"]').nth(idx);
  // Both card-regenerate-image and card-generate-ai-image call the same handler; this
  // baseline renders the former on the expanded card.
  const trigger = card.getByTestId("card-regenerate-image");
  const alt = card.getByTestId("card-generate-ai-image");
  if (await trigger.count()) await trigger.first().click({ timeout: 20_000 });
  else await alt.first().click({ timeout: 20_000 });
  await page.getByTestId("ai-version-drawer").waitFor({ state: "visible", timeout: 30_000 });
  // The recommendation effect runs on open; give it a beat before assertions read state.
  await page.waitForTimeout(300);
}

async function closeDrawer(page: Page) {
  const drawer = page.getByTestId("ai-version-drawer");
  if (await drawer.count()) {
    await page.getByTestId("ai-version-close").click().catch(() => {});
    await drawer.waitFor({ state: "detached", timeout: 8_000 }).catch(() => {});
  }
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nReference-recommendations browser QA — ${BASE_URL}\n`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });

  // Plain function + var: esbuild's __name helper is not defined in the page.
  await context.addInitScript(function (arg) {
    try {
      window.localStorage.setItem(arg[0], JSON.stringify({ drafts: arg[1] }));
    } catch { /* a browser without localStorage cannot run this QA anyway */ }
  }, [DRAFT_KEY, SEEDS] as unknown as [string, Record<string, unknown>]);

  await installMocks(context);

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  // Dev-mode first paint compiles the client bundle; wait for the board itself, not a clock.
  await page.getByTestId("studio-board").waitFor({ state: "visible", timeout: 180_000 });
  await page.waitForSelector('[data-testid="pin-board-card"]', { timeout: 60_000 });

  const cards = await page.locator('[data-testid="pin-board-card"]').count();
  check("the four seeded drafts render as board cards", cards >= 4, `cards=${cards}`);

  // ── 1. Backfill fires exactly once for a never-analysed draft (P0-a) ─────────
  console.log("\n=== 1. backfill: a never-analysed draft is analysed on open ===");
  analyzeCalls = 0;
  await openDrawer(page, "qa_never");
  await page.waitForTimeout(2500);
  check("opening the drawer analyses the draft exactly once", analyzeCalls === 1, `analyze calls=${analyzeCalls}`);
  await shot(page, "1-backfill");
  await closeDrawer(page);
  await page.waitForTimeout(500);

  // ── 2. A failed analysis is NOT retried automatically; the CTA is offered ────
  console.log("\n=== 2. failed analysis: no auto-retry, manual CTA instead ===");
  const beforeFailed = analyzeCalls;
  await openDrawer(page, "qa_failed");
  await page.waitForTimeout(2500);
  check("a failed analysis is never re-sent automatically (no cost loop)",
    analyzeCalls === beforeFailed, `calls before=${beforeFailed} after=${analyzeCalls}`);
  const cta = page.getByTestId("recommended-analyze-cta");
  check("the manual 'Analyze this product' button is offered instead", await cta.count() > 0);
  await shot(page, "2-failed-cta");

  // clicking it DOES analyse (the manual half of the backfill)
  if (await cta.count()) {
    const beforeClick = analyzeCalls;
    await cta.first().click();
    await page.waitForTimeout(2500);
    check("clicking the CTA runs the analysis", analyzeCalls === beforeClick + 1,
      `calls before=${beforeClick} after=${analyzeCalls}`);
  }
  await closeDrawer(page);
  await page.waitForTimeout(500);

  // ── 3. Rate limited: a countdown, not a retry button (P0-b) ─────────────────
  console.log("\n=== 3. rate limited: countdown from the server's Retry-After ===");
  const beforeRate = analyzeCalls;
  await openDrawer(page, "qa_rate");
  await page.waitForTimeout(1200);
  const rl = page.getByTestId("recommended-rate-limited");
  const rlShown = await rl.count() > 0;
  check("the rate-limit notice is shown", rlShown);
  check("a rate-limited draft is not analysed automatically", analyzeCalls === beforeRate,
    `calls before=${beforeRate} after=${analyzeCalls}`);
  let firstText = "";
  if (rlShown) {
    firstText = (await rl.first().innerText()).trim();
    check("the notice names the seconds the server asked for", /\d/.test(firstText), `text="${firstText}"`);
    check("no analyse button while the countdown runs",
      await page.getByTestId("recommended-analyze-cta").count() === 0);
  }
  await shot(page, "3-rate-limited");
  await page.waitForTimeout(4200); // outlive the 3s Retry-After
  check("after the countdown expires the analyse button returns",
    await page.getByTestId("recommended-analyze-cta").count() > 0);
  check("and the countdown notice is gone", await page.getByTestId("recommended-rate-limited").count() === 0);
  await shot(page, "3-rate-limit-expired");
  await closeDrawer(page);
  await page.waitForTimeout(500);

  // ── 4. Analysed but nothing close: honest "no strong match" (P0-b) ──────────
  console.log("\n=== 4. analysed + category_fallback: 'no strong match', no button ===");
  recRequests.length = 0;
  await openDrawer(page, "qa_ready");
  await page.waitForTimeout(3000);
  check("the recommendation request carried the draft's analysis",
    recRequests.length > 0 && recRequests[0].body.analysisStatus === "ready"
      && recRequests[0].body.analysisSource === "draft",
    `status=${String(recRequests[0]?.body?.analysisStatus)} source=${String(recRequests[0]?.body?.analysisSource)}`);
  check("the heading reports Category inspiration (honest basis)",
    await page.getByTestId("recommended-heading").getAttribute("data-basis") === "category_fallback");
  check("the 'no strong match' line is shown",
    await page.getByTestId("recommended-no-strong-match").count() > 0);
  check("no analyse button — this product WAS analysed",
    await page.getByTestId("recommended-analyze-cta").count() === 0);
  await shot(page, "4-no-strong-match");

  // ── 5. requestId / imageKey contract (Codex blockers 1 & 2) ────────────────
  console.log("\n=== 5. request contract: SHA imageKey, ids that join up ===");
  const first = recRequests[0]?.body ?? {};
  check("the FIRST request already carries a 16-hex SHA-256 imageKey (not the 8-hex fallback)",
    typeof first.imageKey === "string" && /^[0-9a-f]{16}$/.test(first.imageKey as string),
    `imageKey=${String(first.imageKey)}`);
  check("the request carries a requestId", typeof first.requestId === "string" && (first.requestId as string).length > 0);
  check("the request carries the day's seed",
    typeof first.seed === "string" && /:\d{4}-\d{2}-\d{2}$/.test(first.seed as string), `seed=${String(first.seed)}`);
  const requestedBeacon = beacons.filter(b => b.event === "reference_recs_requested").pop();
  check("a reference_recs_requested beacon was sent with the same requestId",
    !!requestedBeacon && requestedBeacon.payload.requestId === first.requestId,
    `beacon=${String(requestedBeacon?.payload?.requestId)} request=${String(first.requestId)}`);

  // ── 6. Show different ideas: selected cards keep their slots (P0-e) ─────────
  console.log("\n=== 6. Show different ideas: excludes what was shown, keeps what was picked ===");
  const cardsBefore = page.getByTestId("recommended-reference-card");
  const nBefore = await cardsBefore.count();
  check("recommendation cards are rendered", nBefore > 0, `cards=${nBefore}`);
  // Pick the second card so a保位 failure is visible as a position change, not just a set change.
  await cardsBefore.nth(1).locator("button").first().click();
  await page.waitForTimeout(800);
  const beaconsBefore = beacons.length;
  const reqBefore = recRequests.length;
  await page.getByTestId("recommended-show-different").click();
  await page.waitForTimeout(3000);
  check("the refresh issued a new request", recRequests.length === reqBefore + 1,
    `requests ${reqBefore} → ${recRequests.length}`);
  const refreshReq = recRequests[recRequests.length - 1]?.body ?? {};
  const excl = Array.isArray(refreshReq.excludeIds) ? (refreshReq.excludeIds as string[]) : [];
  check("the refresh request excludes what was already shown",
    REF_A.every(id => excl.includes(id)), `excludeIds=${JSON.stringify(excl)}`);
  check("the excludeIds list stays within the 72 cap", excl.length <= 72, `n=${excl.length}`);
  const refreshedBeacon = beacons.slice(beaconsBefore).find(b => b.event === "reference_refreshed");
  check("reference_refreshed carries the requestId of the request it triggered",
    !!refreshedBeacon && refreshedBeacon.payload.requestId === refreshReq.requestId,
    `beacon=${String(refreshedBeacon?.payload?.requestId)} request=${String(refreshReq.requestId)}`);
  // The picked card must still be there, and the rest must have changed.
  const shownIds = await page.getByTestId("recommended-reference-card").evaluateAll(nodes =>
    nodes.map(n => (n.querySelector("img") as HTMLImageElement | null)?.alt ?? ""));
  const keptPick = shownIds.some(alt => alt.includes(REF_A[1]));
  check("the card the user picked is still on screen", keptPick, `alts=${JSON.stringify(shownIds)}`);
  const fromB = shownIds.filter(alt => REF_B.some(id => alt.includes(id))).length;
  check("the unpicked slots were replaced with new ideas", fromB > 0, `new=${fromB}/${shownIds.length}`);
  await shot(page, "6-show-different");

  // ── console hygiene ────────────────────────────────────────────────────────
  const realErrors = consoleErrors.filter(e =>
    !/favicon|Download the React DevTools|hydration|Warning:/i.test(e));
  check("no unexpected console errors", realErrors.length === 0,
    realErrors.length ? realErrors.slice(0, 2).join(" | ").slice(0, 200) : undefined);

  await closeDrawer(page);
  await browser.close();

  // ── report ─────────────────────────────────────────────────────────────────
  const failed = results.filter(r => r.status === "FAIL");
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ✗ ${f.item}${f.note ? ` — ${f.note}` : ""}`);
  }
  console.log(`\nScreenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
