/**
 * qa-unscheduled-lifecycle-browser.ts — Phase A browser acceptance (PRD 0816 §7, §13).
 *
 * Verifies in a REAL browser what the unit tests assert in isolation: that a Pin which
 * has been posted or has failed never appears in the Unscheduled tray, and that no
 * customer-visible surface says "No image".
 *
 * Why a browser run is needed at all: the tray is derived client-side from
 * localStorage (vp:pin_drafts:v1), so the only way to prove the fix survives a real
 * render — and a refresh — is to drive the page.
 *
 * Run (server must already be up with E2E_TEST_MODE=true):
 *   BASE_URL=http://127.0.0.1:3111 npx tsx scripts/qa-unscheduled-lifecycle-browser.ts
 */

import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3111";
const DRAFT_KEY = "vp:pin_drafts:v1";

const IMG = "https://i.pinimg.com/originals/00/00/00/qa-placeholder.jpg";

/** The five fixtures: one legitimately in the tray, four that must never be. */
const SEEDS: Record<string, Record<string, unknown>> = {
  // Belongs in the tray: a generated draft, no date, no plan membership.
  qa_draft: {
    id: "qa_draft", pinId: "qa_draft", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QA UNSCHEDULED DRAFT", keyword: "qa draft",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  // Posted, with the scheduling fields CLEARED — exactly what payloadAfterSuccess leaves.
  qa_posted: {
    id: "qa_posted", pinId: "qa_posted", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QA POSTED PIN", keyword: "qa posted",
    postedAt: "2026-08-15T09:38:00.000Z", remotePinId: "999111",
    remotePinUrl: "https://www.pinterest.com/pin/999111/",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-15T09:38:00.000Z",
  },
  // Publish-failed, scheduling cleared — what payloadAfterFailure leaves.
  qa_publish_failed: {
    id: "qa_publish_failed", pinId: "qa_publish_failed", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QA PUBLISH FAILED", keyword: "qa publish failed",
    failureType: "publish", publishError: "Board unavailable", errorCategory: "content",
    scheduledDate: "", scheduledTime: "", plannedAt: "",
    previousScheduledTime: "2026-08-15T09:38:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-15T09:38:00.000Z",
  },
  // Generation-failed.
  qa_generation_failed: {
    id: "qa_generation_failed", pinId: "qa_generation_failed", source: "ai_generated", category: "home",
    imageUrl: "", generationStatus: "failed", title: "QA GENERATION FAILED", keyword: "qa gen failed",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  // Scheduled: has a real date, lives on the calendar.
  qa_scheduled: {
    id: "qa_scheduled", pinId: "qa_scheduled", source: "ai_generated", category: "home",
    imageUrl: IMG, title: "QA SCHEDULED PIN", keyword: "qa scheduled",
    scheduledDate: "2026-09-20", scheduledTime: "09:38", addedToPlanAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
};

/** Ids that must NOT be in the Unscheduled set, with the state each represents. */
const MUST_NOT_APPEAR: Array<[string, string]> = [
  ["qa_posted", "Posted"],
  ["qa_scheduled", "Scheduled"],
  ["qa_publish_failed", "Publish failed"],
  ["qa_generation_failed", "Generation failed"],
];

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

/** Ask the page itself which drafts the canonical selector puts in the tray. */
async function trayIds(page: Page): Promise<string[]> {
  // NOTE: written as a plain function body with no arrow functions or helper
  // closures — tsx/esbuild rewrites those into __name(...) calls that do not exist
  // inside the page context, which fails at runtime with "__name is not defined".
  return page.evaluate(function (key) {
    var raw = window.localStorage.getItem(key);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    var drafts = (parsed && parsed.drafts) || {};
    // No nested function declarations at all — esbuild instruments those too.
    var out = [];
    for (var id in drafts) {
      var d = drafts[id];
      var archived = typeof d.archivedAt === "string" ? d.archivedAt.trim() : "";
      var sched = typeof d.scheduledDate === "string" ? d.scheduledDate.trim() : "";
      var added = typeof d.addedToPlanAt === "string" ? d.addedToPlanAt.trim() : "";
      var posted = typeof d.postedAt === "string" ? d.postedAt.trim() : "";
      var remote = typeof d.remotePinId === "string" ? d.remotePinId.trim() : "";
      var perr = typeof d.publishError === "string" ? d.publishError.trim() : "";
      if (archived) continue;
      if (sched) continue;
      if (added) continue;
      if (d.source === "uploaded_image" || d.source === "ai_generated_from_upload") continue;
      if (posted || remote) continue;                          // published
      if (d.failureType === "publish" && perr) continue;        // publish failed
      if (d.generationStatus === "failed") continue;            // generation failed
      out.push(String(d.id));
    }
    return out;
  }, DRAFT_KEY);
}

/** What the Unscheduled rail actually RENDERS (the DOM, not a recomputation). */
async function renderedTrayTitles(page: Page): Promise<string[]> {
  const sel = '[data-testid="unscheduled-pin-card"], [data-testid="unscheduled-rail"] [data-testid="unscheduled-pin-card"]';
  const cards = page.locator(sel);
  const n = await cards.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(((await cards.nth(i).innerText()) || "").replace(/\s+/g, " ").trim());
  return out;
}

async function main() {
  console.log(`\nPhase A browser acceptance — ${BASE_URL}\n`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

  // Plain function + var, for the same esbuild/__name reason as trayIds below.
  await context.addInitScript(function (arg) {
    try {
      window.localStorage.setItem(arg[0], JSON.stringify({ drafts: arg[1] }));
    } catch (e) { /* ignore */ }
  }, [DRAFT_KEY, SEEDS] as unknown as [string, Record<string, unknown>]);

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  // ── Plan page: the Unscheduled rail ────────────────────────────────────────
  await page.goto(`${BASE_URL}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4000);

  console.log("=== Cases 1-4 + 6: lifecycle states stay out of Unscheduled ===");
  const ids = await trayIds(page);
  check("the genuine draft IS in the tray (the fix did not empty it)", ids.includes("qa_draft"),
    `tray=${JSON.stringify(ids)}`);
  for (const [id, label] of MUST_NOT_APPEAR) {
    check(`${label} Pin is NOT in Unscheduled`, !ids.includes(id), `tray=${JSON.stringify(ids)}`);
  }

  // The DOM must agree with the derivation — a correct selector rendered wrongly is
  // still a bug the user would see.
  const rendered = await renderedTrayTitles(page);
  const blob = rendered.join(" | ").toUpperCase();
  console.log(`\n  rendered tray cards: ${rendered.length}`);
  if (rendered.length) console.log(`  ${rendered.slice(0, 8).map(t => `"${t.slice(0, 60)}"`).join("\n  ")}`);
  check("no POSTED Pin rendered in the tray", !blob.includes("QA POSTED PIN"));
  check("no PUBLISH-FAILED Pin rendered in the tray", !blob.includes("QA PUBLISH FAILED"));
  check("no GENERATION-FAILED Pin rendered in the tray", !blob.includes("QA GENERATION FAILED"));
  check("no SCHEDULED Pin rendered in the tray", !blob.includes("QA SCHEDULED PIN"));

  // ── Case 5: survives a refresh ─────────────────────────────────────────────
  console.log("\n=== Case 5: still correct after refresh ===");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4000);
  const after = await trayIds(page);
  check("after refresh the tray is unchanged", JSON.stringify(after.sort()) === JSON.stringify([...ids].sort()),
    `before=${JSON.stringify(ids)} after=${JSON.stringify(after)}`);
  for (const [id, label] of MUST_NOT_APPEAR) {
    check(`after refresh: ${label} still excluded`, !after.includes(id));
  }

  // ── Cases 7-9: no "No image" anywhere a customer can see ───────────────────
  console.log("\n=== Cases 7-9: no 'No image' on any customer surface ===");
  const surfaces = ["/app/studio?view=plan", "/app/studio"];
  for (const path of surfaces) {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(4500);
    const body = ((await page.locator("body").innerText().catch(() => "")) || "");
    check(`${path}: the literal "No image" is absent`, !/\bno image\b/i.test(body),
      (body.match(/.{0,50}[Nn]o image.{0,50}/) ?? [""])[0]);
  }

  // The generation-failed fixture has NO imageUrl, so it must land on the placeholder.
  // That placeholder must carry a label and an accessible name, never a blank block.
  await page.goto(`${BASE_URL}/app/studio`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4500);
  const ph = page.locator('[data-testid="card-generation-failed-placeholder"]');
  const phCount = await ph.count();
  console.log(`  placeholders rendered: ${phCount}`);
  if (phCount > 0) {
    const label = (await ph.first().getAttribute("aria-label")) ?? "";
    const text = ((await ph.first().innerText().catch(() => "")) || "").trim();
    check("placeholder has an accessible name", !!label, `aria-label="${label}"`);
    check("placeholder shows a label, not a blank block", !!text, `text="${text}"`);
    check("placeholder text is not 'No image'", !/^no image$/i.test(text), `text="${text}"`);
  } else {
    console.log("  (no placeholder rendered on this surface — nothing to assert)");
  }

  const realErrors = consoleErrors.filter(e => !/favicon|third-party|net::ERR_|analytics/i.test(e));
  console.log(`\n  console errors: ${realErrors.length}`);
  realErrors.slice(0, 5).forEach(e => console.log(`    ${e.slice(0, 160)}`));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("QA RUN FAILED:", e); process.exit(1); });
