/**
 * Smart Schedule v3 -?reactive preview, fresh-on-save, future-config, rebalance
 * (eligibility / full-repack / skip / overflow / undo) and manual schedule locking.
 * Maps to the spec's "Tests required" 1-?5.
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
  generateWeeklySlotsFromConfig, DAY_NAMES, type SmartScheduleConfig, type WeekdayIndex,
} from "../src/lib/smartScheduleStore";
import { ensureScheduledPlanTime } from "../src/lib/smartSchedule";
import {
  getEligibleRebalancePins, countEligibleRebalancePins, rebalancePlannedPins, undoRebalance,
} from "../src/lib/smartScheduleRebalance";

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

const srcForm = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleConfigForm.tsx"), "utf8");
const srcModal = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleDrawer.tsx"), "utf8");
const srcSettings = readFileSync(join(process.cwd(), "src/components/settings/SettingsModal.tsx"), "utf8");
const srcDraftStore = readFileSync(join(process.cwd(), "src/lib/pinDraftStore.ts"), "utf8");

// - helpers -
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function weekdayIdx(d: Date): number { return (d.getDay() + 6) % 7; }

type Seed = Partial<PinDraft> & { id: string };
function seed(pins: Seed[]) {
  const now = new Date().toISOString();
  const drafts: Record<string, PinDraft> = {};
  for (const p of pins) {
    const date = p.scheduledDate ?? "";
    const time = p.scheduledTime ?? "";
    drafts[p.id] = {
      // boardId defaults to a real value: the WP1 readiness contract (a370f88) makes
      // board a blocking gate in ensureScheduledPlanTime, and this fixture is not
      // testing that gate (no test here overrides it back to "") — an empty default
      // would short-circuit every ensureScheduledPlanTime() call in this file to
      // reason:"not_ready" before the logic under test ever runs.
      imageUrl: `https://x/${p.id}.jpg`, keyword: "k", category: "home-decor",
      title: "T", description: "d", altText: "", destinationUrl: "", boardId: "b1", boardName: "Board 1",
      weeklyPlanItemId: "", generationSessionId: "", scheduledDate: date, scheduledTime: time,
      plannedAt: date && time ? `${date}T${time}` : "",
      status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: now,
      ...p,
    } as PinDraft;
  }
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts }));
  // pinDraftStore keeps an in-memory cache that is the source of truth once loaded;
  // writing raw localStorage behind its back is invisible until the cache is dropped.
  pinDraftStore.__resetMemoryCacheForTests();
}

console.log("Smart Schedule v3 -?reactive / fresh-save / rebalance / manual lock");

// - 1-?: reactive preview + fresh-on-save + per-day counts -

// 1. Changing pinsPerDay updates generated preview automatically (no Generate click).
test("1. reactive preview: form debounce-regenerates on input change; no required Generate", () => {
  assert(/REGEN_DEBOUNCE_MS/.test(srcForm) && /generateWeeklySlotsFromConfig\(prev\)/.test(srcForm),
    "form does not auto-regenerate the preview");
  assert(!srcForm.includes('data-testid="smart-schedule-generate"'), "required Generate button still present");
});

// 2. Generate is not required for Save (Save regenerates fresh itself).
test("2. Save regenerates fresh slots itself (Generate not required)", () => {
  assert(/const fresh: SmartScheduleConfig = \{ \.\.\.config, weeklySlots: generateWeeklySlotsFromConfig\(config\) \}/.test(srcForm),
    "Save does not build fresh weeklySlots from current config");
});

// 3. Save persists weeklySlots matching current pinsPerDay (never stale).
test("3. Save persists fresh weeklySlots that match pinsPerDay", () => {
  reset();
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4, activeDays: ["Mon", "Tue", "Wed"] };
  // mimic the form's save: regenerate fresh from config, then persist
  saveSmartScheduleConfig({ ...cfg, weeklySlots: generateWeeklySlotsFromConfig(cfg) });
  const ws = getSmartScheduleConfig().weeklySlots;
  for (const d of [0, 1, 2] as WeekdayIndex[]) assert((ws[d] ?? []).length === 4, `day ${d} expected 4 slots`);
  assert(ws[3 as WeekdayIndex] === undefined, "inactive day must have no slots");
});

// 4. same_every_day pinsPerDay=4 -?4 slots per active day.
test("4. same_every_day pinsPerDay=4 -?4 slots/active day", () => {
  const out = generateWeeklySlotsFromConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4, activeDays: ["Mon", "Sun"] });
  assert((out[0 as WeekdayIndex] ?? []).length === 4 && (out[6 as WeekdayIndex] ?? []).length === 4, "expected 4 slots Mon & Sun");
});

// 5. Recommended mode produces a fixed, variable-by-day weekly rhythm (no average input).
test("5. recommended mode varies day counts (fixed system rhythm)", () => {
  const out = generateWeeklySlotsFromConfig({
    ...defaultSmartScheduleConfig(), rhythmMode: "recommended", activeDays: [...DAY_NAMES],
  });
  const counts = [0, 1, 2, 3, 4, 5, 6].map(d => (out[d as WeekdayIndex] ?? []).length);
  assert(new Set(counts).size > 1, `recommended should vary by day, got ${counts.join(",")}`);
  assert(counts[0] === 4 && counts[5] < counts[0] && counts[6] < counts[0], "Mon fuller, weekend lighter");
});

// 6. Inactive days produce zero slots.
test("6. inactive days -?zero slots", () => {
  const out = generateWeeklySlotsFromConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 3, activeDays: ["Mon"] });
  assert(Object.keys(out).length === 1 && (out[0 as WeekdayIndex] ?? []).length === 3, "only Mon should have slots");
});

// customSlots preserved across regeneration
test("customSlots are merged into the generated output and preserved", () => {
  const out = generateWeeklySlotsFromConfig({
    ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 2, activeDays: ["Mon"], customSlots: { 0: ["23:45"] },
  });
  assert((out[0 as WeekdayIndex] ?? []).includes("23:45"), "custom slot not preserved");
  assert((out[0 as WeekdayIndex] ?? []).length === 3, "custom slot not merged with the 2 generated");
});

// - 7-?: Weekly Plan -?Settings share one canonical config -

test("7. Settings and Weekly Plan read the same saved canonical config", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), pinsPerDay: 7 });
  assert(getSmartScheduleConfig().pinsPerDay === 7, "single canonical store not shared");
  assert(srcModal.includes("SmartScheduleConfigForm") && srcSettings.includes("SmartScheduleConfigForm"),
    "both surfaces must render the same shared form");
});

test("8/9. saving on one surface notifies the other (shared event subscription)", () => {
  assert(/subscribeToSmartScheduleConfigChanges/.test(srcForm), "form does not subscribe to config changes");
  reset();
  let fired = 0;
  (g.window as { addEventListener: (t: string, cb: () => void) => void })
    .addEventListener("vp:smart_schedule_updated", () => { fired++; });
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), pinsPerDay: 5 });
  assert(fired >= 1, "save did not emit the canonical change event");
});

// - 10: future schedule actions use the latest saved config -

test("10. future Schedule actions use the LATEST saved weeklySlots", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "A1" }]);
  const r1 = ensureScheduledPlanTime("A1");
  assert(r1.ok && pinDraftStore.getDraft("A1")!.scheduledTime === "14:20", "did not use first saved config");
  // change config -?next schedule uses the new slot
  saveSmartScheduleConfig({ ...getSmartScheduleConfig(), weeklySlots: { 3: ["08:05"] } });
  seed([{ id: "A1", scheduledDate: pinDraftStore.getDraft("A1")!.scheduledDate, scheduledTime: "14:20" }, { id: "A2" }]);
  const r2 = ensureScheduledPlanTime("A2");
  assert(r2.ok && pinDraftStore.getDraft("A2")!.scheduledTime === "08:05", "did not use the latest saved config");
});

// - 11-?3: rebalance confirmation gating + keep current -

test("11. eligible future planned Pins are detected (drives the confirmation)", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  const future = isoOf(addDays(now, 30));
  seed([{ id: "E1", scheduledDate: future, scheduledTime: "09:00" }]);
  assert(getEligibleRebalancePins(pinDraftStore.getAllDrafts(), now).length === 1, "eligible pin not detected");
  assert(countEligibleRebalancePins(now) === 1, "count helper disagrees");
});

test("12. rebalance dialog excludes forbidden options; offers only Keep / Rebalance", () => {
  assert(srcForm.includes('data-testid="smart-schedule-rebalance-confirm"'), "rebalance dialog missing");
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // button copy/testids); tighten to planViews.form.rebalance.keepButton/confirmButton
  // when that cluster lands.
  assert(srcForm.includes('data-testid="smart-schedule-rebalance-keep-btn"') && srcForm.includes('data-testid="smart-schedule-rebalance-confirm-btn"'), "rebalance actions missing");
  assert(!/Apply from next week/.test(srcForm), "must not offer 'Apply from next week'");
  assert(!/Use for future Pins only/.test(srcForm), "must not offer 'Use for future Pins only'");
});

test("13. Keep current times leaves existing planned Pins unchanged", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  const future = isoOf(addDays(now, 30));
  seed([{ id: "K1", scheduledDate: future, scheduledTime: "09:00" }]);
  const before = { ...pinDraftStore.getDraft("K1")! };
  // "Keep" = simply do NOT call rebalance after save
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 0: ["07:00"] } });
  const after = pinDraftStore.getDraft("K1")!;
  assert(after.scheduledDate === before.scheduledDate && after.scheduledTime === before.scheduledTime,
    "existing planned Pin changed without rebalance");
});

// - 14-?0: rebalance algorithm -

test("14. Rebalance full-repacks eligible Pins into the new slots", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0); // Mon
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00", "10:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([
    { id: "R1", scheduledDate: isoOf(addDays(now, 40)), scheduledTime: "18:00" },
    { id: "R2", scheduledDate: isoOf(addDays(now, 41)), scheduledTime: "19:00" },
  ]);
  const res = rebalancePlannedPins({ now });
  assert(res.changed === 2, `expected 2 changed, got ${res.changed}`);
  const r1 = pinDraftStore.getDraft("R1")!, r2 = pinDraftStore.getDraft("R2")!;
  assert(["09:00", "10:00"].includes(r1.scheduledTime!) && ["09:00", "10:00"].includes(r2.scheduledTime!),
    "pins not moved into the new slot times");
  assert(r1.scheduleSource === "smart" && r1.scheduleLocked === false, "rebalanced pin not marked smart/unlocked");
});

test("15. Rebalance skips posted Pins", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  const future = isoOf(addDays(now, 30));
  seed([{ id: "P1", scheduledDate: future, scheduledTime: "18:00", postedAt: new Date().toISOString() }]);
  assert(rebalancePlannedPins({ now }).changed === 0, "posted pin should not be rebalanced");
  assert(pinDraftStore.getDraft("P1")!.scheduledTime === "18:00", "posted pin time changed");
});

test("16. Rebalance skips past Pins", () => {
  reset();
  const now = new Date(2026, 5, 15, 12, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([{ id: "PA1", scheduledDate: isoOf(addDays(now, -10)), scheduledTime: "09:00" }]);
  assert(rebalancePlannedPins({ now }).changed === 0, "past pin should not be rebalanced");
});

test("17. Rebalance skips failed Pins", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([{ id: "F1", scheduledDate: isoOf(addDays(now, 30)), scheduledTime: "18:00", generationStatus: "failed" }]);
  assert(rebalancePlannedPins({ now }).changed === 0, "failed pin should not be rebalanced");
});

test("18. Rebalance skips manual / locked Pins", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([
    { id: "M1", scheduledDate: isoOf(addDays(now, 30)), scheduledTime: "18:00", scheduleSource: "manual", scheduleLocked: true },
    { id: "M2", scheduledDate: isoOf(addDays(now, 31)), scheduledTime: "18:30", scheduleSource: "smart", scheduleLocked: true },
  ]);
  assert(rebalancePlannedPins({ now }).changed === 0, "manual/locked pins should not be rebalanced");
  assert(pinDraftStore.getDraft("M1")!.scheduledTime === "18:00", "manual pin moved");
});

test("19. Rebalance overflow rolls into future weeks", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0); // Monday
  const mon = weekdayIdx(now);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [mon]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> }); // ONE slot/week
  seed([
    { id: "O1", scheduledDate: isoOf(addDays(now, 50)), scheduledTime: "18:00" },
    { id: "O2", scheduledDate: isoOf(addDays(now, 51)), scheduledTime: "18:30" },
    { id: "O3", scheduledDate: isoOf(addDays(now, 52)), scheduledTime: "19:00" },
  ]);
  const res = rebalancePlannedPins({ now });
  assert(res.changed === 3, `expected 3 changed, got ${res.changed}`);
  const dates = ["O1", "O2", "O3"].map(id => pinDraftStore.getDraft(id)!.scheduledDate);
  assert(new Set(dates).size === 3, "overflow did not spread across distinct weeks/dates");
  for (const id of ["O1", "O2", "O3"]) {
    const d = pinDraftStore.getDraft(id)!;
    assert(weekdayIdx(new Date(d.scheduledDate + "T00:00:00")) === mon && d.scheduledTime === "09:00", "overflow slot not on the configured weekday/time");
  }
});

test("20. Rebalance never assigns a duplicate plannedAt", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00", "10:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([
    { id: "D1", scheduledDate: isoOf(addDays(now, 40)), scheduledTime: "18:00" },
    { id: "D2", scheduledDate: isoOf(addDays(now, 41)), scheduledTime: "18:30" },
    { id: "D3", scheduledDate: isoOf(addDays(now, 42)), scheduledTime: "19:00" },
  ]);
  rebalancePlannedPins({ now });
  const ats = ["D1", "D2", "D3"].map(id => pinDraftStore.getDraft(id)!.plannedAt);
  assert(new Set(ats).size === 3, `duplicate plannedAt produced: ${ats.join(", ")}`);
  assert(ats.every(a => !!a), "empty plannedAt produced");
});

// - 21: undo -

test("21. Undo restores previous plannedDate/plannedTime/plannedAt", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  const origDate = isoOf(addDays(now, 40));
  seed([{ id: "U1", scheduledDate: origDate, scheduledTime: "18:00" }]);
  const before = { ...pinDraftStore.getDraft("U1")! };
  const res = rebalancePlannedPins({ now });
  assert(pinDraftStore.getDraft("U1")!.scheduledTime === "09:00", "rebalance did not move pin");
  undoRebalance(res.snapshot);
  const after = pinDraftStore.getDraft("U1")!;
  assert(after.scheduledDate === before.scheduledDate && after.scheduledTime === before.scheduledTime && after.plannedAt === before.plannedAt,
    "undo did not restore previous schedule values");
});

// - 22-?3: manual lock vs smart -

test("22. Manual date/time edit sets scheduleSource=manual + scheduleLocked=true", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "MAN1" }]);
  pinDraftStore.assignDraftToDate("MAN1", isoOf(addDays(new Date(), 20)), "13:00");
  const d = pinDraftStore.getDraft("MAN1")!;
  assert(d.scheduleSource === "manual" && d.scheduleLocked === true, "manual assign not locked");
  // ensureScheduledPlanTime with source:manual also locks
  seed([{ id: "MAN2" }]);
  ensureScheduledPlanTime("MAN2", { source: "manual", reschedule: true });
  const d2 = pinDraftStore.getDraft("MAN2")!;
  assert(d2.scheduleSource === "manual" && d2.scheduleLocked === true, "manual reschedule not locked");
  // wiring: the plan page routes drag/move/assign through source:manual
  const srcPlan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
  assert(/source: "manual"/.test(srcPlan), "plan page manual edit paths not marked manual");
  assert(/scheduleSource:\s*"manual"/.test(srcDraftStore), "assignDraftToDate not marking manual");
});

test("23. Auto Schedule sets scheduleSource=smart + scheduleLocked=false", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "SM1" }]);
  ensureScheduledPlanTime("SM1");
  const d = pinDraftStore.getDraft("SM1")!;
  assert(d.scheduleSource === "smart" && d.scheduleLocked === false, "auto schedule not smart/unlocked");
});

// - 24-?5: scheduling not gated by metadata -

test("24. Missing product does not block scheduling", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "NP1", title: "", description: "", linkedProducts: [], primaryProductId: "" }]);
  assert(ensureScheduledPlanTime("NP1").ok, "missing product blocked scheduling");
});

test("25. Missing destination URL does not block scheduling", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "NU1", destinationUrl: "" }]);
  assert(ensureScheduledPlanTime("NU1").ok, "missing URL blocked scheduling");
});

// - New volume model (recommended/same) + UI behaviors -

test("M1. Recommended is the default mode (no average field)", () => {
  const d = defaultSmartScheduleConfig() as Record<string, unknown>;
  assert(d.rhythmMode === "recommended", "default mode is not recommended");
  assert(!("averagePinsPerDay" in d), "averagePinsPerDay must not exist on the config");
});

test("M2. Average + Customize removed; Recommended has NO stepper; Same keeps stepper", () => {
  assert(!/Customize by day/.test(srcForm), "Customize by day must be removed");
  assert(!/Average Pins per day/.test(srcForm), "Average Pins per day must be removed");
  assert(!srcForm.includes("smart-schedule-mode-custom") && !srcForm.includes("smart-schedule-perday") && !srcForm.includes("smart-schedule-avg"), "per-day/average controls must be removed");
  assert(srcForm.includes('data-testid="smart-schedule-mode-recommended"') && srcForm.includes('data-testid="smart-schedule-mode-same"'), "mode toggles missing");
  assert(srcForm.includes('data-testid="smart-schedule-recommended-help"'), "recommended helper (no stepper) missing");
  assert(srcForm.includes('data-testid="smart-schedule-pins-value"'), "same-every-day numeric stepper missing");
  assert(srcForm.includes('data-testid="smart-schedule-reset-recommended"'), "Reset to recommended missing");
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // button copy); tighten to tr("planViews.form.regenerateTimes") when that cluster lands.
  assert(/data-testid="smart-schedule-regenerate"[\s\S]{0,300}Regenerate times/.test(srcForm), "Regenerate times missing");
});

test("M3. Reset to recommended restores recommended mode + default days/windows", () => {
  assert(/rhythmMode: "recommended"/.test(srcForm) && /DEFAULT_TIME_WINDOWS\.map/.test(srcForm) && /generateWeeklySlotsFromConfig\(next\)/.test(srcForm),
    "resetToRecommended does not restore defaults / regenerate");
});

test("M4. Rebalance dialog uses the updated lock/undo copy; no forbidden options", () => {
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // bullet copy); tighten to the i18n keys when that cluster lands.
  assert(srcForm.includes("Only unlocked planned Pins will be updated."), "missing unlocked copy");
  assert(srcForm.includes("Locked, posted, past, and manually scheduled Pins will not be changed."), "missing locked-skip copy");
  assert(srcForm.includes("You can undo this after rebalancing."), "missing undo copy");
  assert(!/Apply from next week/.test(srcForm), "must not show 'Apply from next week'");
  assert(!/Use for future Pins only/.test(srcForm), "must not show 'Use for future Pins only'");
  assert(!/This action cannot be undone/.test(srcForm), "must not show 'This action cannot be undone'");
});

test("M5. Inline validation hints exist (lightweight, not an error wall)", () => {
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // inline hints + toast copy); tighten to the i18n keys when that cluster lands.
  assert(srcForm.includes('data-testid="smart-schedule-validation-days"') && srcForm.includes("Select at least one active day."), "no active-days validation");
  assert(srcForm.includes('data-testid="smart-schedule-validation-window"') && srcForm.includes("End time must be later than start time."), "no window validation");
  assert(srcForm.includes('data-testid="smart-schedule-validation-slots"') && srcForm.includes("No publishing slots generated. Check your active days and time windows."), "no slots validation");
  assert(srcForm.includes("Choose a publishing timezone."), "no timezone validation");
});

// - Follow-up: saved-mode init, board removal, lock UI, lock behavior, toast copy -

const srcPlan2 = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
const srcDetails = readFileSync(join(process.cwd(), "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");

test("F1. Smart Schedule form initializes from the SAVED canonical config", () => {
  assert(/useState<SmartScheduleConfig>\(\(\) => getSmartScheduleConfig\(\)\)/.test(srcForm),
    "form does not seed state from saved config");
  assert(/const sync = \(\) => \{ const c = getSmartScheduleConfig\(\);/.test(srcForm),
    "form does not re-sync from saved config");
});

test("F2. Smart Schedule reopens the SAVED rhythmMode (not always Recommended)", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4 });
  assert(getSmartScheduleConfig().rhythmMode === "same_every_day", "saved same_every_day not read back");
  saveSmartScheduleConfig({ ...getSmartScheduleConfig(), rhythmMode: "recommended" });
  assert(getSmartScheduleConfig().rhythmMode === "recommended", "saved recommended not read back");
});

test("F3. Board rotation removed from Smart Schedule UI; Add custom slot stays in Advanced", () => {
  assert(!/Board rotation/.test(srcForm), "Board rotation must be removed from the form");
  assert(!/fetchPinterestBoards/.test(srcForm), "form must not fetch boards");
  assert(srcForm.includes('data-testid="smart-schedule-advanced-toggle"'), "Advanced section missing");
  assert(srcForm.includes('data-testid="smart-schedule-add-slot"'), "Add custom slot missing");
  // Add custom slot lives after the Advanced toggle.
  assert(srcForm.indexOf("smart-schedule-advanced-toggle") < srcForm.indexOf("smart-schedule-add-slot"),
    "Add custom slot is not inside Advanced");
});

test("F4. Lock UI: hover card icon + tile indicator + Pin Details toggle", () => {
  assert(srcForm.length >= 0, ""); // keep srcForm referenced
  const hover = readFileSync(join(process.cwd(), "src/components/plan/PinHoverPreview.tsx"), "utf8");
  assert(hover.includes('data-testid="hover-lock-toggle"'), "hover lock toggle missing");
  assert(/Keep this time when rebalancing/.test(hover), "hover lock tooltip copy missing");
  assert(/e\.stopPropagation\(\); actions\.onToggleLock/.test(hover), "lock toggle must stopPropagation");
  // tile indicator only when locked
  assert(/draft\.scheduleLocked && \(/.test(srcPlan2) && srcPlan2.includes('data-testid="weekly-plan-pin-lock"'),
    "locked-only tile indicator missing");
  // pin details toggle
  assert(srcDetails.includes('data-testid="pin-details-lock-toggle"') && /Keep this time when rebalancing/.test(srcDetails),
    "Pin Details lock toggle missing");
});

test("F5. setScheduleLocked flips scheduleLocked only", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 2: ["14:20"] } });
  seed([{ id: "L1", scheduledDate: isoOf(addDays(new Date(), 20)), scheduledTime: "13:00", scheduleSource: "smart", scheduleLocked: false }]);
  pinDraftStore.setScheduleLocked("L1", true);
  const d = pinDraftStore.getDraft("L1")!;
  assert(d.scheduleLocked === true && d.scheduleSource === "smart" && d.scheduledTime === "13:00", "lock flip changed more than the flag");
  pinDraftStore.setScheduleLocked("L1", false);
  assert(pinDraftStore.getDraft("L1")!.scheduleLocked === false, "unlock did not apply");
});

test("F6. Undo restores scheduleSource + scheduleLocked too", () => {
  reset();
  const now = new Date(2026, 5, 1, 0, 0, 0);
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { [weekdayIdx(now)]: ["09:00"] } as Partial<Record<WeekdayIndex, string[]>> });
  seed([{ id: "UR1", scheduledDate: isoOf(addDays(now, 40)), scheduledTime: "18:00", scheduleSource: "smart", scheduleLocked: false }]);
  const res = rebalancePlannedPins({ now });
  undoRebalance(res.snapshot);
  const d = pinDraftStore.getDraft("UR1")!;
  assert(d.scheduleSource === "smart" && d.scheduleLocked === false, "undo did not restore source/lock fields");
});

test("F7. Keep-current-times toast + rebalance lock/undo copy", () => {
  // legacy surface not yet i18n-ified — asserts current behavior (hardcoded English
  // toast/bullet copy); tighten to the i18n keys when that cluster lands.
  assert(srcForm.includes("Smart Schedule saved. Existing planned Pins were unchanged."), "keep-current toast copy missing");
  assert(srcForm.includes("Only unlocked planned Pins will be updated."), "lock copy missing");
  assert(srcForm.includes("You can undo this after rebalancing."), "undo copy missing");
});

console.log(`\nSmart Schedule v3: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
