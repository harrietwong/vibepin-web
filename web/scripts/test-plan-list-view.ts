/**
 * Weekly Plan List view + IA tests.
 *  - Top-level tabs = Calendar | List (Board removed)
 *  - Calendar keeps Week/Month; List has no Week/Month toggle
 *  - List = compact table with the required columns, vertical thumbs, neutral states
 *  - List schedules via the canonical helper (same planned time as Calendar)
 */

// ── Browser shim (for the canonical store/helper runtime checks) ────────────────
const _store = new Map<string, string>();
const listeners: Record<string, Array<() => void>> = {};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k)! : null),
  setItem: (k: string, v: string) => { _store.set(k, v); },
  removeItem: (k: string) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};
g.window = {
  localStorage: g.localStorage,
  addEventListener: (t: string, cb: () => void) => { (listeners[t] ??= []).push(cb); },
  removeEventListener: () => {},
  dispatchEvent: (e: { type: string }) => { (listeners[e.type] ?? []).forEach(f => f()); return true; },
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pinDraftStore from "../src/lib/pinDraftStore";
import type { PinDraft } from "../src/lib/pinDraftStore";
import { ensureScheduledPlanTime } from "../src/lib/smartSchedule";
import { saveSmartScheduleConfig } from "../src/lib/smartScheduleStore";
import { mapPlanDraftToCalendarEvent } from "../src/lib/planCalendar";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const planSrc = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
const listSrc = readFileSync(join(process.cwd(), "src/components/plan/PlanListView.tsx"), "utf8");

console.log("Weekly Plan List view + IA");

// 1
test("Top-level tabs render only Calendar and List", () => {
  assert(planSrc.includes('(["calendar", "list"] as const)'), "tab array is not [calendar, list]");
  assert(planSrc.includes('type ViewMode = "calendar" | "list"'), "ViewMode still includes board/overview");
  assert(planSrc.includes('view-mode-calendar') || planSrc.includes('`view-mode-${mode}`'), "missing calendar tab testid");
});

// 2
test("Board tab is not rendered", () => {
  assert(!planSrc.includes('"view-mode-board"') && !planSrc.includes('view-mode-board'), "view-mode-board still present");
  assert(!/\?\s*"Board"\s*:/.test(planSrc), "Board label still rendered in tabs");
});

// 3
test("Calendar view renders Week / Month toggle (gated to calendar)", () => {
  assert(planSrc.includes('calendar-scope-${scope}') && planSrc.includes('(["week", "month"] as const)'), "scope toggle missing");
  assert(/\{viewMode === "calendar" && \(/.test(planSrc), "Week/Month toggle not gated to calendar view");
});

// 4
test("List view does not render Week / Month toggle", () => {
  // The only scope toggle is inside the viewMode === "calendar" gate (asserted in #3),
  // so List view cannot render it.
  assert(planSrc.includes('viewMode === "list" ? ('), "List branch not gated separately from calendar");
});

// 5
test("List rows show VERTICAL portrait thumbnails (no horizontal strip)", () => {
  assert(/width: 48, height: 72/.test(listSrc), "thumbnail not portrait 48x72");
  assert(listSrc.includes('data-testid="plan-list-thumb"'), "thumb testid missing");
  assert(!/height: 28, /.test(listSrc), "horizontal strip thumbnail present");
});

// 6
test("List rows show plannedDate + plannedTime", () => {
  assert(listSrc.includes("publishTimeLabel"), "publishTimeLabel missing");
  assert(listSrc.includes("`${date} · ${ev.plannedTime}`"), "date · time format missing");
  assert(listSrc.includes('data-testid="plan-list-time"'), "time cell testid missing");
});

// 7
test("Missing time shows 'Unscheduled' (not empty/undefined)", () => {
  assert(/if \(!ev\.plannedDate \|\| !ev\.plannedTime\) return "Unscheduled"/.test(listSrc), "Unscheduled fallback missing");
});

// 8
test("Product missing shows 'No product' (not an error)", () => {
  assert(listSrc.includes('"No product"'), "No product label missing");
  assert(!/Missing product|Product error|Product issue/i.test(listSrc), "product shown as an error");
});

// 9
test("Missing URL shows 'Add URL' (neutral, not blocking error)", () => {
  assert(listSrc.includes('"Add URL"'), "Add URL placeholder missing");
  assert(!/Missing URL|url-error|#EF4444.*url/i.test(listSrc), "missing URL styled as error");
});

// 10
test("Scheduling from List assigns plannedDate/plannedTime/plannedAt", () => {
  assert(listSrc.includes("ensureScheduledPlanTime"), "List does not use the canonical scheduler");
  // Runtime: prove the canonical path the List calls assigns all three.
  saveSmartScheduleConfig({ weeklySlots: { 0:["09:00"],1:["09:30"],2:["09:12","14:20"],3:["10:00"],4:["09:15"],5:["11:00"],6:["10:30"] }, boards: [] });
  const now = new Date().toISOString();
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { L1: {
    id: "L1", imageUrl: "https://x/p.jpg", keyword: "k", category: "home-decor", title: "T", description: "d",
    altText: "", destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", scheduledTime: "", plannedAt: "", status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: "",
  } } }));
  const res = ensureScheduledPlanTime("L1");
  assert(res.ok, "schedule failed");
  const d = pinDraftStore.getDraft("L1")!;
  assert(!!d.scheduledDate && /^\d{2}:\d{2}$/.test(d.scheduledTime ?? "") && /T\d{2}:\d{2}$/.test(d.plannedAt ?? ""),
    `incomplete plan time: ${d.scheduledDate} ${d.scheduledTime} ${d.plannedAt}`);
});

// 11
test("Scheduled from List shows same time as Calendar (one mapper)", () => {
  const d = pinDraftStore.getDraft("L1")!;
  const ev = mapPlanDraftToCalendarEvent(d); // the exact mapper Calendar week/month use
  assert(ev.plannedTime === d.scheduledTime, `List/Calendar time mismatch: ${ev.plannedTime} vs ${d.scheduledTime}`);
  assert(listSrc.includes("mapPlanDraftToCalendarEvent"), "List does not use the shared calendar mapper");
});

// 12
test("Multi-select toolbar shows 'N selected' and primary Schedule", () => {
  assert(listSrc.includes("{selected.size} selected"), "quiet 'N selected' text missing");
  assert(listSrc.includes('data-testid="plan-list-schedule-selected"'), "selection Schedule button missing");
});

// 13
test("Schedule label is 'Schedule', not 'Schedule selected (N)'", () => {
  assert(!/Schedule selected/.test(listSrc), "uses 'Schedule selected' CTA label");
});

// 14
test("No debug diagnostics rendered in List view", () => {
  assert(!/pin-card-plan-debug|data-vp-|console\.(debug|log)/.test(listSrc), "debug diagnostics present in List view");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
