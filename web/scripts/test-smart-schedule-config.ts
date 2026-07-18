/**
 * Smart Schedule refactor tests -?centered modal, timezone selector, pins-per-day
 * generator, canonical config sync, and schedule integration.
 */

// - Browser shim -
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
import {
  getSmartScheduleConfig, saveSmartScheduleConfig, defaultSmartScheduleConfig,
  generateWeeklySlots, localTimeZone, DAY_NAMES, type SmartScheduleConfig,
} from "../src/lib/smartScheduleStore";
import { ensureScheduledPlanTime } from "../src/lib/smartSchedule";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function reset() {
  _store.clear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  // pinDraftStore keeps an in-memory cache that is the source of truth once loaded;
  // drop it so raw localStorage seeding below (and the previous test's drafts) take effect.
  pinDraftStore.__resetMemoryCacheForTests();
}

const srcModal = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleDrawer.tsx"), "utf8");
const srcForm  = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleConfigForm.tsx"), "utf8");
const srcSettings = readFileSync(join(process.cwd(), "src/components/settings/SettingsModal.tsx"), "utf8");

console.log("Smart Schedule refactor");

// 1
test("Smart Schedule opens as a centered modal, not a right drawer", () => {
  assert(srcModal.includes('data-testid="smart-schedule-modal"'), "modal testid missing");
  // Centered overlay (not a right-aligned drawer panel).
  assert(/alignItems: "center", justifyContent: "center"/.test(srcModal), "overlay not centered");
  assert(!/width: 420/.test(srcModal) && !/borderLeft/.test(srcModal), "still rendering a right drawer panel");
  assert(srcModal.includes('role="dialog"') && srcModal.includes('aria-modal="true"'), "missing dialog semantics");
  // Footer CTA is a simple sticky "Save" (not the long "Save Smart Schedule").
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // button copy); tighten to tr("planViews.drawer.save") when that cluster lands.
  assert(/data-testid="smart-schedule-save"[\s\S]{0,300}\{tr\("planViews\.drawer\.save"\)\}/.test(srcModal) && !srcModal.includes("Save Smart Schedule"), "footer should be a simple 'Save'");
});

// 2
test("Timezone selector is rendered", () => {
  assert(srcForm.includes('data-testid="smart-schedule-timezone-select"'), "timezone select missing");
  assert(/America\/New_York/.test(srcForm) && /America\/Los_Angeles/.test(srcForm), "US timezone quick choices missing");
  assert(srcForm.includes("Publishing timezone"), "timezone label missing");
});

// 3
test("Default timezone uses existing config or browser local timezone", () => {
  reset();
  assert(getSmartScheduleConfig().timezone === localTimeZone(), "default timezone is not browser local");
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), timezone: "America/Denver" });
  assert(getSmartScheduleConfig().timezone === "America/Denver", "saved timezone not used");
});

// 4
test("pinsPerDay control rendered and persisted", () => {
  assert(srcForm.includes('data-testid="smart-schedule-pins-value"'), "pins/day control missing");
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), pinsPerDay: 6 });
  assert(getSmartScheduleConfig().pinsPerDay === 6, "pinsPerDay not persisted");
  // clamps 1..20
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), pinsPerDay: 99 });
  assert(getSmartScheduleConfig().pinsPerDay === 20, "pinsPerDay not clamped to 20");
});

// 5
test("activeDays are persisted", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), activeDays: ["Mon", "Wed", "Fri"] });
  assert(JSON.stringify(getSmartScheduleConfig().activeDays) === JSON.stringify(["Mon", "Wed", "Fri"]), "activeDays not persisted");
});

// 6
test("preferredTimeWindows are persisted", () => {
  reset();
  const windows = [{ label: "Morning", start: "08:00", end: "10:00" }, { label: "Night", start: "21:00", end: "23:00" }];
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), preferredTimeWindows: windows });
  assert(JSON.stringify(getSmartScheduleConfig().preferredTimeWindows) === JSON.stringify(windows), "windows not persisted");
});

// 7
test("Generate creates pinsPerDay slots per active day", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 3, activeDays: ["Mon", "Tue", "Wed"] };
  const out = generateWeeklySlots(cfg);
  assert(Object.keys(out).length === 3, `expected 3 active days, got ${Object.keys(out).length}`);
  for (const d of [0, 1, 2]) assert((out[d as 0] ?? []).length === 3, `day ${d} should have 3 slots, got ${out[d as 0]?.length}`);
  assert((out[3 as 0] ?? undefined) === undefined, "non-active day (Thu) should have no slots");
  // Not round-hours-only: at least one slot has non-zero minutes.
  const flat = Object.values(out).flat();
  assert(flat.some(t => !/:00$/.test(t!)), "all slots are round hours");
});

// 8
test("Generated slots are stable (deterministic) and survive save/reload", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), pinsPerDay: 4, activeDays: ["Mon", "Tue"] };
  const a = generateWeeklySlots(cfg);
  const b = generateWeeklySlots(cfg);
  assert(JSON.stringify(a) === JSON.stringify(b), "generator not deterministic");
  reset();
  saveSmartScheduleConfig({ ...cfg, weeklySlots: a });
  assert(JSON.stringify(getSmartScheduleConfig().weeklySlots) === JSON.stringify(a), "slots not stable after reload");
});

// 9
test("Weekly Plan modal and Settings render the same shared form", () => {
  assert(srcModal.includes("SmartScheduleConfigForm"), "modal does not render shared form");
  assert(srcSettings.includes("SmartScheduleConfigForm"), "settings does not render shared form");
});

// 10 & 11
test("Schedule action uses canonical weeklySlots + assigns date/time/plannedAt", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  const now = new Date().toISOString();
  // boardId is required data setup, not part of what this test is exercising: the
  // WP1 readiness contract (a370f88) makes board a blocking gate in
  // ensureScheduledPlanTime, so an empty boardId always short-circuits to
  // reason:"not_ready" before the canonical-slot assignment logic under test even runs.
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { P1: {
    id: "P1", imageUrl: "https://x/p.jpg", keyword: "k", category: "home-decor", title: "T", description: "d",
    altText: "", destinationUrl: "", boardId: "b1", boardName: "Board 1", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", scheduledTime: "", plannedAt: "", status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: "",
  } } }));
  const res = ensureScheduledPlanTime("P1");
  assert(res.ok, "schedule failed");
  const d = pinDraftStore.getDraft("P1")!;
  assert(d.scheduledTime === "14:20", `did not use canonical slot: ${d.scheduledTime}`);
  assert(!!d.scheduledDate && /T\d{2}:\d{2}$/.test(d.plannedAt ?? ""), "missing date/plannedAt");
  const dow = (new Date(d.scheduledDate + "T00:00:00").getDay() + 6) % 7;
  assert(dow === 2, `slot not on a Wednesday (canonical day): dow=${dow}`);
});

// 12
test("Changing timezone does NOT shift existing scheduled Pins", () => {
  const before = pinDraftStore.getDraft("P1")!;
  const beforeAt = before.plannedAt, beforeTime = before.scheduledTime;
  saveSmartScheduleConfig({ ...getSmartScheduleConfig(), timezone: "America/Los_Angeles" });
  const after = pinDraftStore.getDraft("P1")!;
  assert(after.plannedAt === beforeAt && after.scheduledTime === beforeTime, "existing pin shifted by timezone change");
});

// 13
test("Generate is not required; Add custom slot + Regenerate are Advanced-only", () => {
  // The big required "Generate schedule" primary action is removed (reactive preview).
  assert(!srcForm.includes('data-testid="smart-schedule-generate"'), "required Generate button should be removed");
  assert(srcForm.includes('data-testid="smart-schedule-add-slot"'), "Add custom slot missing");
  assert(srcForm.includes('data-testid="smart-schedule-regenerate"'), "optional Regenerate preview missing");
  assert(/Advanced/.test(srcForm), "Advanced section missing");
});

// 14
test("Missing product does not block scheduling", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  const now = new Date().toISOString();
  // boardId is required data setup, not the field under test here: the WP1 readiness
  // contract (a370f88) makes board the other blocking gate, so an empty boardId always
  // short-circuits to reason:"not_ready" regardless of the (intentionally missing)
  // product/metadata this test means to prove is non-blocking.
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { Q1: {
    id: "Q1", imageUrl: "https://x/p.jpg", keyword: "k", category: "home-decor", title: "", description: "",
    altText: "", destinationUrl: "", boardId: "b1", boardName: "Board 1", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", scheduledTime: "", plannedAt: "", status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: "",
    linkedProducts: [], primaryProductId: "",
  } } }));
  const res = ensureScheduledPlanTime("Q1");
  assert(res.ok, "scheduling blocked despite missing product/metadata");
});

// Copy
test("Modal subtitle uses the clearer generator-focused copy", () => {
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // subtitle copy); tighten to tr("planViews.drawer.subtitle") when that cluster lands.
  assert(srcModal.includes("planViews.drawer.subtitle"), "subtitle copy not updated");
});

// - Posting volume: recommended vs same_every_day -

test("SAME_EVERY_DAY: every active day gets EXACTLY pinsPerDay distinct slots (incl. Sunday)", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4, activeDays: [...DAY_NAMES] };
  const out = generateWeeklySlots(cfg);
  for (let d = 0; d < 7; d++) {
    const slots = out[d as 0] ?? [];
    assert(slots.length === 4, `day ${d} expected 4 slots, got ${slots.length}`);
    assert(new Set(slots).size === 4, `day ${d} has duplicate slots: ${slots.join(",")}`);
  }
});

test("SAME_EVERY_DAY honors pinsPerDay=2 and pinsPerDay=5 exactly (no collision loss)", () => {
  for (const n of [2, 5]) {
    const out = generateWeeklySlots({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: n, activeDays: ["Sun"] });
    assert((out[6 as 0] ?? []).length === n, `Sun expected ${n}, got ${out[6 as 0]?.length}`);
  }
});

test("RECOMMENDED: fixed system rhythm varies by day (no numeric input)", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), rhythmMode: "recommended", activeDays: [...DAY_NAMES] };
  const out = generateWeeklySlots(cfg);
  const counts = [0, 1, 2, 3, 4, 5, 6].map(d => (out[d as 0] ?? []).length);
  // System rhythm: Mon4 Tue3 Wed4 Thu3 Fri3 Sat2 Sun2 -?not all equal, lighter weekend.
  assert(new Set(counts).size > 1, `recommended should vary by day, got ${counts.join(",")}`);
  assert(counts[5] < counts[0] && counts[6] < counts[0], "weekend should be lighter than Mon");
});

test("Inactive days generate ZERO slots in both modes", () => {
  const same = generateWeeklySlots({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4, activeDays: ["Mon"] });
  assert(Object.keys(same).length === 1 && (same[0 as 0] ?? []).length === 4, "same: only Mon should be present");
  const rec = generateWeeklySlots({ ...defaultSmartScheduleConfig(), rhythmMode: "recommended", activeDays: ["Mon", "Sun"] });
  assert(Object.keys(rec).length === 2 && rec[1 as 0] === undefined, "recommended: only Mon+Sun should be present");
});

test("rhythmMode + pinsPerDay persist across save/reload", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 5 });
  let c = getSmartScheduleConfig();
  assert(c.rhythmMode === "same_every_day" && c.pinsPerDay === 5, "same_every_day not persisted");
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "recommended" });
  c = getSmartScheduleConfig();
  assert(c.rhythmMode === "recommended", "recommended mode not persisted");
});

test("Legacy volumeMode + averagePinsPerDay migrate to rhythmMode (average dropped)", () => {
  reset();
  _store.set("vp:smart_schedule:v1", JSON.stringify({ timezone: "UTC", volumeMode: "same", pinsPerDay: 4, activeDays: ["Mon"], preferredTimeWindows: [], weeklySlots: {} }));
  assert(getSmartScheduleConfig().rhythmMode === "same_every_day", "legacy 'same' did not migrate");
  reset();
  _store.set("vp:smart_schedule:v1", JSON.stringify({ timezone: "UTC", volumeMode: "recommended", averagePinsPerDay: 6, activeDays: ["Mon"], preferredTimeWindows: [], weeklySlots: {} }));
  const c = getSmartScheduleConfig() as Record<string, unknown>;
  assert(c.rhythmMode === "recommended", "legacy 'recommended' did not migrate");
  assert(!("averagePinsPerDay" in c), "averagePinsPerDay must be dropped");
});

test("Recommended (no stepper) + Same toggles render; Average/Customize removed", () => {
  assert(srcForm.includes('data-testid="smart-schedule-mode-recommended"'), "recommended toggle missing");
  assert(srcForm.includes('data-testid="smart-schedule-mode-same"'), "same toggle missing");
  assert(!/Customize by day/.test(srcForm), "Customize by day must be removed");
  assert(!/Average Pins per day/.test(srcForm), "Average Pins per day must be removed");
  assert(!srcForm.includes("smart-schedule-perday") && !srcForm.includes("smart-schedule-avg"), "per-day/average steppers must be removed");
  // Same every day keeps its numeric stepper; recommended has none.
  assert(srcForm.includes('data-testid="smart-schedule-pins-value"'), "same-every-day stepper missing");
  assert(srcForm.includes('data-testid="smart-schedule-volume-summary"'), "volume summary missing");
  assert(srcForm.includes('data-testid="smart-schedule-reset-recommended"'), "Reset to recommended missing");
});

test("Settings Smart Schedule route renders the shared canonical form", () => {
  const srcSettingsPage = readFileSync(join(process.cwd(), "src/app/app/settings/smart-schedule/page.tsx"), "utf8");
  assert(srcSettingsPage.includes("SmartScheduleConfigForm"), "settings route does not render shared form");
});

// - Weekly Plan multi-select + Batch Edit entry -

test("Weekly Plan selection toolbar: Batch edit primary, quiet count, Schedule/Publish now, Clear", () => {
  const srcPlan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
  assert(srcPlan.includes('data-testid="weekly-plan-selection-bar"'), "selection bar missing");
  assert(srcPlan.includes('data-testid="wp-batch-edit"'), "batch edit entry missing");
  assert(srcPlan.includes('data-testid="wp-selected-count"'), "quiet count missing");
  assert(srcPlan.includes("openBatchEditFor([...selectedIds])"), "batch edit not passing selected IDs");
  assert(!/Schedule selected \(/.test(srcPlan) && !/Batch Edit Details selected/.test(srcPlan), "uses forbidden verbose labels");
});

test("Weekly Plan multi-select checkboxes + edit/selection mode exist", () => {
  const srcPlan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
  assert(srcPlan.includes('data-testid="weekly-plan-edit-toggle"'), "selection-mode toggle missing");
  assert(/select!?\.toggle/.test(srcPlan), "card selection toggle missing");
});

test("Weekly Plan Schedule uses canonical Smart Schedule + skips already-planned (no overwrite)", () => {
  const srcPlan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
  assert(srcPlan.includes("handleBulkSmartSchedule"), "schedule handler missing");
  assert(srcPlan.includes("filterUnscheduledPinIds"), "does not skip already-scheduled (would overwrite)");
  assert(srcPlan.includes("autoSchedulePins"), "does not use canonical Smart Schedule");
});

test("Missing destination URL does not block scheduling", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  const now = new Date().toISOString();
  // boardId is required data setup, not the field under test here: the WP1 readiness
  // contract (a370f88) makes board the other blocking gate, so an empty boardId always
  // short-circuits to reason:"not_ready" regardless of the (intentionally missing)
  // destination URL this test means to prove is non-blocking.
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts: { U1: {
    id: "U1", imageUrl: "https://x/p.jpg", keyword: "k", category: "home-decor", title: "T", description: "d",
    altText: "a", destinationUrl: "", boardId: "b1", boardName: "Board 1", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", scheduledTime: "", plannedAt: "", status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: "",
  } } }));
  const res = ensureScheduledPlanTime("U1");
  assert(res.ok, "scheduling blocked despite missing destination URL");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
