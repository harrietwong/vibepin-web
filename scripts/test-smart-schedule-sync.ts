/**
 * Smart Schedule canonical sync tests.
 *
 * Verifies that Weekly Plan, Settings, and the scheduling logic all read/write
 * ONE canonical source (smartScheduleStore.weeklySlots) and that no duplicate
 * slot store exists. Runs under tsx with a minimal localStorage/window shim.
 */

// ── Minimal browser shim so the localStorage-backed stores run in node ─────────
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
  addEventListener: (type: string, cb: () => void) => { (listeners[type] ??= []).push(cb); },
  removeEventListener: (type: string, cb: () => void) => {
    listeners[type] = (listeners[type] ?? []).filter(f => f !== cb);
  },
  dispatchEvent: (e: { type: string }) => { (listeners[e.type] ?? []).forEach(f => f()); return true; },
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSmartScheduleConfig,
  saveSmartScheduleConfig,
  getWeeklyPostingSlots,
  updateWeeklyPostingSlots,
  defaultSmartScheduleConfig,
  SMART_SCHEDULE_EVENT,
  type WeekdayIndex,
} from "../src/lib/smartScheduleStore";
import {
  getNextSmartScheduleSlot,
  findNextAvailableScheduleSlot,
} from "../src/lib/smartSchedule";
import {
  generateSmartScheduleSlots,
  defaultSmartSchedulePrefs,
  type TimeWindow,
} from "../src/lib/smartSchedulePrefsStore";
import type { PinDraft } from "../src/lib/pinDraftStore";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function reset() { _store.clear(); for (const k of Object.keys(listeners)) delete listeners[k]; }

const srcDrawer   = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleDrawer.tsx"), "utf8");
const srcSettings = readFileSync(join(process.cwd(), "src/components/settings/SettingsModal.tsx"), "utf8");
const srcForm     = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleConfigForm.tsx"), "utf8");
const srcAssign   = readFileSync(join(process.cwd(), "src/lib/smartSchedule.ts"), "utf8");
const srcPrefs    = readFileSync(join(process.cwd(), "src/lib/smartSchedulePrefsStore.ts"), "utf8");

console.log("Smart Schedule canonical sync");

// 1. Weekly Plan save updates the canonical config.
test("Weekly Plan save → canonical config persists weeklySlots", () => {
  reset();
  const cfg = defaultSmartScheduleConfig();
  cfg.weeklySlots = { 0: ["09:00"], 2: ["14:20"] };
  saveSmartScheduleConfig(cfg);
  const read = getSmartScheduleConfig();
  assert(JSON.stringify(read.weeklySlots[0]) === JSON.stringify(["09:00"]), "Monday slot not persisted");
  assert(JSON.stringify(read.weeklySlots[2]) === JSON.stringify(["14:20"]), "Wednesday slot not persisted");
});

// 2. Settings reads the SAME slots Weekly Plan wrote.
test("Settings reads same canonical slots after Weekly Plan save", () => {
  reset();
  // Weekly Plan adds Monday 09:00 on top of an existing config.
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), weeklySlots: { 0: ["08:00"] } });
  updateWeeklyPostingSlots({ 0: ["08:00", "09:00"] });
  // Settings reads via the same canonical getter.
  const settingsView = getWeeklyPostingSlots();
  assert((settingsView[0] ?? []).includes("09:00"), "Settings did not see Weekly Plan's 09:00 slot");
});

// 3. Settings "Generate" → save updates canonical slots.
test("Settings generate → updateWeeklyPostingSlots writes canonical", () => {
  reset();
  const prefs = { ...defaultSmartSchedulePrefs(), weeklyGoal: 5, preferredDays: [0, 1], preferredWindows: ["morning"] as TimeWindow[] };
  const generated = generateSmartScheduleSlots(prefs);
  updateWeeklyPostingSlots(generated as Partial<Record<WeekdayIndex, string[]>>);
  const canonical = getWeeklyPostingSlots();
  assert(JSON.stringify(canonical) === JSON.stringify(generateSmartScheduleSlots(prefs)),
    "Generated schedule not written to canonical slots");
});

// 4. Weekly Plan reads updated slots after Settings save (round-trip).
test("Weekly Plan reads slots after Settings save", () => {
  reset();
  updateWeeklyPostingSlots({ 3: ["10:30", "16:45"] });
  const wpView = getSmartScheduleConfig().weeklySlots;
  assert(JSON.stringify(wpView[3]) === JSON.stringify(["10:30", "16:45"]), "Weekly Plan stale after Settings save");
});

// 5. updateWeeklyPostingSlots preserves boards / defaultBoardId (no clobber).
test("updateWeeklyPostingSlots preserves boards + defaultBoardId", () => {
  reset();
  saveSmartScheduleConfig({
    weeklySlots: { 0: ["09:00"] },
    boards: [{ boardId: "b1", boardName: "Home" }],
    defaultBoardId: "b1",
  });
  updateWeeklyPostingSlots({ 0: ["09:00", "12:00"] });
  const cfg = getSmartScheduleConfig();
  assert(cfg.boards.length === 1 && cfg.boards[0].boardId === "b1", "boards clobbered");
  assert(cfg.defaultBoardId === "b1", "defaultBoardId clobbered");
});

// 6. Scheduling logic uses the canonical slots (next available slot).
test("getNextSmartScheduleSlot uses canonical slots", () => {
  reset();
  // Only Wednesday 14:20 configured → next slot must land on a Wednesday 14:20.
  updateWeeklyPostingSlots({ 2: ["14:20"] });
  const existing: PinDraft[] = [];
  const slot = getNextSmartScheduleSlot(existing);
  assert(slot !== null, "no slot returned despite configured canonical slots");
  assert(slot!.plannedTime === "14:20", `expected canonical 14:20, got ${slot!.plannedTime}`);
  // Confirm it is the same result as resolving directly off canonical weeklySlots.
  const direct = findNextAvailableScheduleSlot({ weeklySlots: getWeeklyPostingSlots(), existingPlannedPins: existing });
  assert(JSON.stringify(slot) === JSON.stringify(direct), "next-slot helper diverged from canonical resolution");
});

// 7. A genuinely empty config → no slot (the guard, not a hardcoded fallback).
//    (NB: the store itself reseeds DEFAULT_WEEKLY_SLOTS when nothing is saved —
//     that default is the seed, not a competing schedule source.)
test("getNextSmartScheduleSlot returns null for an empty config", () => {
  reset();
  const slot = getNextSmartScheduleSlot([], { ...defaultSmartScheduleConfig(), weeklySlots: {} });
  assert(slot === null, "fell back to a non-canonical schedule for an empty config");
});

// 8. SMART_SCHEDULE_EVENT fires on canonical write (drives both surfaces' refresh).
test("canonical write emits SMART_SCHEDULE_EVENT", () => {
  reset();
  let fired = 0;
  (global as unknown as { window: { addEventListener: (t: string, cb: () => void) => void } })
    .window.addEventListener(SMART_SCHEDULE_EVENT, () => { fired++; });
  updateWeeklyPostingSlots({ 0: ["07:30"] });
  assert(fired >= 1, "SMART_SCHEDULE_EVENT not emitted on canonical write");
});

// 9. No duplicate slot store: prefs store must NOT persist weeklySlots.
//    "weeklySlots" may only appear inside comments (it documents the separation).
test("prefs store holds no weeklySlots field (single source of truth)", () => {
  const codeLines = srcPrefs
    .split("\n")
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    });
  assert(!codeLines.some(l => /weeklySlots/.test(l)), "smartSchedulePrefsStore should not store weeklySlots");
  assert(/stored separately in smartScheduleStore/.test(srcPrefs),
    "prefs store should document that slots live in the canonical store");
});

// 10. Both surfaces render the SAME shared form; the form + assignment use the
//     canonical store (the strongest possible "same config" guarantee).
test("Weekly Plan modal + Settings render the shared SmartScheduleConfigForm", () => {
  assert(/SmartScheduleConfigForm/.test(srcDrawer), "Weekly Plan modal does not render the shared form");
  assert(/SmartScheduleConfigForm/.test(srcSettings), "Settings does not render the shared form");
  assert(/getSmartScheduleConfig/.test(srcForm) && /saveSmartScheduleConfig/.test(srcForm), "form does not read/write canonical config");
  assert(/getSmartScheduleConfig/.test(srcAssign), "assignment logic does not read canonical config");
});

// 11. The shared form live-syncs via the canonical config-change subscription
//     (subscribeToSmartScheduleConfigChanges wraps SMART_SCHEDULE_EVENT).
test("shared form subscribes to canonical Smart Schedule config changes", () => {
  assert(/subscribeToSmartScheduleConfigChanges/.test(srcForm), "shared form does not subscribe to canonical config changes");
});

// 12. Timezone source is the shared canonical localTimeZone helper (one place).
test("timezone uses the shared canonical localTimeZone helper", () => {
  assert(/localTimeZone/.test(srcForm), "form not using the shared localTimeZone helper");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
