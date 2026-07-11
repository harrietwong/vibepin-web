/**
 * Weekly Plan time-slot queue + future-slot scheduling rules + full-day feedback +
 * Publish now. Maps to this task's "Tests required" 1-8.
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
import type { PinDraft } from "../src/lib/pinDraftStore";
import {
  getSmartScheduleConfig, saveSmartScheduleConfig, defaultSmartScheduleConfig,
  type SmartScheduleConfig, type WeekdayIndex,
} from "../src/lib/smartScheduleStore";
import {
  findNextAvailableScheduleSlot, buildDaySlotRows, dayHasFreeFutureSlot, configuredSlotCountForDate,
} from "../src/lib/smartSchedule";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function reset() { _store.clear(); for (const k of Object.keys(listeners)) delete listeners[k]; }

const srcPlan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
const srcForm = readFileSync(join(process.cwd(), "src/components/plan/SmartScheduleConfigForm.tsx"), "utf8");
const srcHover = readFileSync(join(process.cwd(), "src/components/plan/PinHoverPreview.tsx"), "utf8");

// - helpers -
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekdayIdx(d: Date): WeekdayIndex { return ((d.getDay() + 6) % 7) as WeekdayIndex; }
/** A future date on weekday `wd` (Mon=0…Sun=6) at h:m, at least `minAhead` days out. */
function futureWeekdayAt(wd: WeekdayIndex, h: number, m: number, minAhead = 14): Date {
  const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + minAhead);
  while (weekdayIdx(d) !== wd) d.setDate(d.getDate() + 1);
  return d;
}
function draftAt(id: string, date: string, time: string): PinDraft {
  const now = new Date().toISOString();
  return {
    id, imageUrl: `https://x/${id}.jpg`, keyword: "k", category: "home-decor", title: "T", description: "d",
    altText: "", destinationUrl: "", boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: date, scheduledTime: time, plannedAt: `${date}T${time}`,
    status: "needs_review", createdAt: now, updatedAt: now, source: "generated", addedToPlanAt: now,
  } as PinDraft;
}

const WED = 2 as WeekdayIndex;
const SLOTS = ["09:38", "10:23", "15:05", "21:31"];

console.log("Weekly Plan slots + future scheduling + full-day + Publish now");

// 1. First-time default mode is Recommended.
test("1. first-time default mode is Recommended", () => {
  reset();
  assert(getSmartScheduleConfig().rhythmMode === "recommended", "first-time default not recommended");
});

// 2. Saved Same every day reopens as Same every day.
test("2. saved same_every_day reopens as same_every_day", () => {
  reset();
  saveSmartScheduleConfig({ ...defaultSmartScheduleConfig(), rhythmMode: "same_every_day", pinsPerDay: 4 });
  assert(getSmartScheduleConfig().rhythmMode === "same_every_day", "saved mode not reopened");
});

// 3. Auto scheduling skips past slots for today (12:00 → 15:05, not 09:38).
test("3. auto schedule skips today's past slots", () => {
  const from = futureWeekdayAt(WED, 12, 0);
  const slot = findNextAvailableScheduleSlot({ weeklySlots: { [WED]: SLOTS } as Partial<Record<WeekdayIndex, string[]>>, existingPlannedPins: [], fromDateTime: from });
  assert(!!slot, "no slot found");
  assert(slot!.plannedTime === "15:05", `expected 15:05 (first future slot), got ${slot!.plannedTime}`);
  assert(slot!.plannedDate === isoOf(from), "should stay on the same day");
});

// 4. When today's future slots are full, roll to the next active day's earliest slot.
test("4. full today rolls to next active day's earliest slot", () => {
  const from = futureWeekdayAt(WED, 12, 0);
  const dateISO = isoOf(from);
  const occupied = new Set([`${dateISO}|15:05`, `${dateISO}|21:31`]);
  const slot = findNextAvailableScheduleSlot({ weeklySlots: { [WED]: SLOTS } as Partial<Record<WeekdayIndex, string[]>>, existingPlannedPins: [], fromDateTime: from, extraOccupied: occupied });
  assert(!!slot, "no slot found");
  const next = new Date(from); next.setDate(next.getDate() + 7);
  assert(slot!.plannedTime === "09:38", `expected next-week 09:38, got ${slot!.plannedTime}`);
  assert(slot!.plannedDate === isoOf(next), `expected ${isoOf(next)}, got ${slot!.plannedDate}`);
});

// buildDaySlotRows shape: all configured slots, occupied + empty, future flagged.
test("buildDaySlotRows lists every configured slot with occupancy + past flag", () => {
  reset();
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), weeklySlots: { [WED]: SLOTS } as Partial<Record<WeekdayIndex, string[]>> };
  const from = futureWeekdayAt(WED, 0, 0);
  const dateISO = isoOf(from);
  const rows = buildDaySlotRows(dateISO, [draftAt("A", dateISO, "15:05")], { config: cfg, now: new Date() });
  assert(rows.length === 4, `expected 4 slot rows, got ${rows.length}`);
  assert(rows.map(r => r.time).join(",") === SLOTS.join(","), "rows not time-ordered/complete");
  assert(rows.find(r => r.time === "15:05")!.draft?.id === "A", "occupied slot not linked to draft");
  assert(rows.filter(r => !r.draft).length === 3, "empty slots miscounted");
  assert(rows.every(r => !r.isPast), "future day slots should not be past");
});

// 5/6. Empty FUTURE slots accept drops; empty PAST slots are display-only.
test("5/6. future day has free slots; fully-past day has none", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), weeklySlots: { [WED]: SLOTS } as Partial<Record<WeekdayIndex, string[]>> };
  const future = isoOf(futureWeekdayAt(WED, 0, 0));
  assert(dayHasFreeFutureSlot(future, [], { config: cfg }), "future empty day should accept drops");
  // A past Wed: every slot is in the past → no free future slot.
  const past = new Date(); past.setDate(past.getDate() - 14); while (weekdayIdx(past) !== WED) past.setDate(past.getDate() - 1);
  const pastRows = buildDaySlotRows(isoOf(past), [], { config: cfg, now: new Date() });
  assert(pastRows.length === 4 && pastRows.every(r => r.isPast), "past day slots should all be past");
  assert(!dayHasFreeFutureSlot(isoOf(past), [], { config: cfg }), "past day must not accept drops");
});

// 7. A full future day has no free slot (drag would be rejected with a toast).
test("7. full future day → no free slot (drag rejected, not mutated)", () => {
  const cfg: SmartScheduleConfig = { ...defaultSmartScheduleConfig(), weeklySlots: { [WED]: SLOTS } as Partial<Record<WeekdayIndex, string[]>> };
  const dateISO = isoOf(futureWeekdayAt(WED, 0, 0));
  const full = SLOTS.map((t, i) => draftAt(`F${i}`, dateISO, t));
  assert(!dayHasFreeFutureSlot(dateISO, full, { config: cfg }), "full day reported free");
  assert(configuredSlotCountForDate(dateISO, cfg) === 4, "configured count wrong");
  // The drop handler shows a toast + guidance and never schedules.
  assert(/No available slots on \$\{formatScheduleDateLabel\(date\)\}/.test(srcPlan), "full-day toast missing");
  assert(/Increase pins per day or choose another day/.test(srcPlan), "full-day guidance missing");
  assert(/label: "Edit Smart Schedule"/.test(srcPlan), "Edit Smart Schedule action missing");
  assert(/if \(!dayHasFreeFutureSlot\(date, dayDrafts\)\)/.test(srcPlan), "drop handler does not guard full days");
});

// Week View renders the slot grid (occupied + empty future + disabled past).
test("Week View renders configured slots via SlotPlaceholder", () => {
  assert(/const slotRows = buildDaySlotRows\(dateISO, dayDrafts\)/.test(srcPlan), "DayColumn not building slot rows");
  assert(srcPlan.includes("function SlotPlaceholder"), "SlotPlaceholder missing");
  assert(srcPlan.includes('data-testid={isPast ? "calendar-slot-past" : "calendar-slot-empty"}'), "slot testids missing");
  assert(srcPlan.includes('data-testid="calendar-slot-time"'), "slot time not shown");
  // past slots have no drop handler
  assert(/onDrop=\{isPast \? undefined :/.test(srcPlan), "past slot still accepts drops");
});

// Part 1: day chips show weekday only (no bare "Tue 4"); a clear header carries the count.
test("Day chips show weekday only; no bare number beside weekday", () => {
  assert(!/\{d\}\{n \? ` \$\{n\}` : ""\}/.test(srcForm), "still rendering 'Tue 4' style label");
  assert(srcForm.includes('data-testid="smart-schedule-day-header"'), "selected-day header missing");
  assert(/\{daySlots\.length\} slot/.test(srcForm), "header does not show slot count clearly");
  assert(/Same every day · \$\{config\.pinsPerDay\} pins\/day/.test(srcForm), "volume summary copy not clear");
});

// 8. Publish now: present, distinct, readiness blocks board/URL but not product.
test("8. Publish now present + readiness (board blocks; URL optional, product does not)", () => {
  assert(srcHover.includes('data-testid="hover-publish-now"') && /Publish now/.test(srcHover), "Publish now button missing");
  assert(/onPublishNow\?:/.test(srcHover), "onPublishNow action type missing");
  // handler gates on board only; Website URL is optional (never blocks); never product
  const idx = srcPlan.indexOf("onPublishNow:");
  assert(idx >= 0, "onPublishNow not wired");
  const body = srcPlan.slice(idx, idx + 500);
  assert(/boardId/.test(body), "readiness does not check board");
  assert(!/destinationUrl/.test(body), "Publish now must NOT gate on Website URL (optional)");
  assert(!/product/i.test(body), "Publish now must not gate on product");
  assert(/Add a board before publishing\./.test(body), "board-only readiness message missing");
});

console.log(`\nWeekly Plan slots: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
