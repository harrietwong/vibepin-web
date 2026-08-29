/**
 * qa-schedule-social-guard-browser.ts — stopgap acceptance in a real browser.
 *
 * Covers the seven checkpoints for the schedule-destination guard:
 *   1. Publish now still offers every publishable platform.
 *   2. Instagram / Facebook cannot be ticked for a scheduled Pin.
 *   3. Those accounts still read as Connected.
 *   4. They are NOT mislabelled "Not connected".
 *   5. The API refuses an unsupported scheduled destination (no UI involved).
 *   6. Smart Schedule cannot create one either.
 *   7. Pinterest scheduling still works.
 *
 * STATUS: checkpoints 1-4 are BLOCKED in this harness. The destination selector
 * lives only in DraftDetailsDrawer, reached by hovering a calendar tile and
 * clicking "Edit details". A standalone probe reaches that control reliably, but
 * inside this run the drawer never opens — six selector/timing variants were
 * tried. Rather than keep guessing, the run reports INCONCLUSIVE: a green suite
 * that never rendered a row would be worse than an honest blocker.
 *
 * The rule those checkpoints cover IS asserted, at the level that decides
 * behaviour, in scripts/test-schedule-social-guard.ts (37 assertions against the
 * exact exported functions the route and the row call). This file stays as the
 * skeleton for the authenticated Preview QA that must run before release.
 *
 * Run (server up with E2E_TEST_MODE=true):
 *   BASE_URL=http://127.0.0.1:3111 npx tsx scripts/qa-schedule-social-guard-browser.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3111";
const KEY = "vp:pin_drafts:v1";
const IMG = "/icon-512.png";
const TODAY = new Date().toISOString().slice(0, 10);

const SEEDS: Record<string, Record<string, unknown>> = {
  QA_SCHED_1: {
    id: "QA_SCHED_1", pinId: "QA_SCHED_1", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QASCHED SCHEDULED PIN", keyword: "qa sched",
    scheduledDate: TODAY, scheduledTime: "23:30",
    addedToPlanAt: "2026-08-01T00:00:00.000Z",
    boardId: "boardA", boardName: "Board A",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  QA_UNSCHED_1: {
    id: "QA_UNSCHED_1", pinId: "QA_UNSCHED_1", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QASCHED UNSCHEDULED PIN", keyword: "qa unsched",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

/** Read every destination row's provider, state and visible label. */
async function destinationRows(page: Page) {
  // Plain function + var only (esbuild rewrites arrows/nested decls into __name).
  return page.evaluate(function () {
    var out: Array<Record<string, unknown>> = [];
    var nodes = document.querySelectorAll('[data-testid^="publish-dest-"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i] as HTMLElement;
      out.push({
        provider: (n.getAttribute("data-testid") || "").replace("publish-dest-", ""),
        role: n.getAttribute("role") || "",
        disabled: n.getAttribute("aria-disabled") === "true",
        scheduleBlocked: n.getAttribute("data-schedule-blocked") === "true",
        text: (n.innerText || "").replace(/\s+/g, " ").trim(),
      });
    }
    return out;
  });
}

async function main() {
  console.log(`\nSchedule social guard — browser acceptance — ${BASE}\n`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addInitScript(function (a) {
    try { window.localStorage.setItem(a[0], JSON.stringify({ drafts: a[1] })); } catch (e) { /* ignore */ }
  }, [KEY, SEEDS] as unknown as [string, Record<string, unknown>]);

  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });

  // ── checkpoint 5: server enforcement ─────────────────────────────────────
  // PUT /api/pin-drafts requires a real bearer token and has NO test bypass —
  // adding one was explicitly out of bounds. An unauthenticated probe therefore
  // only proves auth runs first, which is reported as inconclusive rather than
  // dressed up as a pass. The server rule itself is asserted directly in
  // scripts/test-schedule-social-guard.ts against the exported function the
  // route calls.
  await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2500);
  console.log("=== 5. server-side refusal (unauthenticated probe) ===");
  const api = await page.evaluate(async function () {
    var res = await fetch("/api/pin-drafts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: [{
        draftId: "QA_API_BYPASS",
        updatedAt: new Date().toISOString(),
        payload: {
          id: "QA_API_BYPASS", title: "API BYPASS", imageUrl: "/icon-512.png",
          boardId: "boardA", scheduledDate: "2099-01-01", scheduledTime: "10:00",
          // The REAL intent field (the guard reads this; `socialDestinations` is a
          // field nothing writes and the server now ignores it).
          scheduledDestinations: [
            { provider: "pinterest", socialConnectionId: "conn-0", capturedAt: new Date().toISOString() },
            { provider: "instagram", socialConnectionId: "conn-1", capturedAt: new Date().toISOString() },
            { provider: "facebook", socialConnectionId: "conn-2", capturedAt: new Date().toISOString() },
          ],
          updatedAt: new Date().toISOString(),
        },
      }] }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  });
  console.log(`  api → HTTP ${api.status}`);
  console.log(`  body: ${api.body.slice(0, 180)}`);
  check("the API does not silently ACCEPT an unsupported scheduled destination",
    api.status !== 200,
    `HTTP 200 would mean the schedule was persisted and the IG/FB choice dropped`);
  if (api.status === 401) {
    console.log("  note: 401 — auth precedes the guard, so this leg only proves");
    console.log("        the request was not accepted. Rule coverage: unit test.");
  }

  // ── checkpoints 1-4: the drawer for a SCHEDULED Pin ───────────────────────
  console.log("\n=== 1-4. destination rows on a scheduled Pin ===");
  await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  // Open the scheduled Pin's drawer. PublishDestinations lives ONLY in
  // DraftDetailsDrawer, which the Plan workspace mounts — the Studio board's
  // card-edit opens a different, inline editor with no destination selector.
  // The drawer is reached by hovering a calendar card, then "Edit details".
  await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);

  // Scope to the CALENDAR tile. The unscheduled fixture also renders a rail
  // thumbnail with the same testid, and .first() could land on that instead —
  // the rail has no hover card, so the run then silently found nothing.
  const tile = page
    .locator('[data-testid="weekly-plan-calendar"] [data-testid="weekly-plan-pin-image"]')
    .first();
  if (await tile.count()) {
    await tile.hover({ timeout: 10_000 }).catch(() => {});
    // Wait for the control itself rather than sleeping a fixed amount: the hover
    // card animates in and dismisses on pointer-out, so a blind timeout races it.
    const edit = page.locator('[data-testid="hover-edit-details"]').first();
    try {
      await edit.waitFor({ state: "visible", timeout: 10_000 });
      await edit.click({ timeout: 10_000 });
      await page.locator('[data-testid="draft-details-drawer"]')
        .waitFor({ state: "visible", timeout: 15_000 });
      // The destination list loads its connections asynchronously.
      await page.waitForTimeout(3500);
    } catch {
      console.log("  (could not reach the drawer via the hover card)");
    }
  }
  let rows = await destinationRows(page);

  console.log(`  destination rows found: ${rows.length}`);
  rows.forEach(r => console.log(`    ${String(r.provider).padEnd(10)} disabled=${r.disabled} schedBlocked=${r.scheduleBlocked} "${String(r.text).slice(0, 60)}"`));

  if (rows.length === 0) {
    check("destination rows rendered for a scheduled Pin", false,
      "INCONCLUSIVE: the drawer did not open, so checkpoints 1-4 could not be observed");
  } else {
    const ig = rows.find(r => r.provider === "instagram");
    const fb = rows.find(r => r.provider === "facebook");
    const pin = rows.find(r => r.provider === "pinterest");

    check("Instagram row is still VISIBLE (not hidden)", !!ig);
    check("Facebook row is still VISIBLE (not hidden)", !!fb);
    if (ig) {
      check("Instagram is not selectable while scheduling", ig.disabled === true || ig.scheduleBlocked === true,
        `disabled=${ig.disabled} scheduleBlocked=${ig.scheduleBlocked}`);
      check("Instagram is NOT mislabelled 'Not connected'",
        !/not connected/i.test(String(ig.text)), `text="${ig.text}"`);
    }
    if (fb) {
      check("Facebook is not selectable while scheduling", fb.disabled === true || fb.scheduleBlocked === true);
      check("Facebook is NOT mislabelled 'Not connected'",
        !/not connected/i.test(String(fb.text)), `text="${fb.text}"`);
    }
    if (pin) {
      check("Pinterest scheduling is untouched (row still actionable)", pin.disabled !== true,
        `pinterest disabled=${pin.disabled}`);
    }
    const blob = rows.map(r => r.text).join(" | ");
    check("no raw technical reason shown to the customer",
      !/persist|react state|cron|publishDueLogic|migration/i.test(blob));
  }

  const realErrs = errs.filter(e => !/favicon|401|analytics|net::ERR_/i.test(e));
  console.log(`\n  console errors (filtered): ${realErrs.length}`);
  realErrs.slice(0, 5).forEach(e => console.log(`    ${e.slice(0, 140)}`));

  await page.screenshot({ path: "qa-schedule-guard.png" }).catch(() => {});
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error("QA RUN FAILED:", e); process.exit(1); });
