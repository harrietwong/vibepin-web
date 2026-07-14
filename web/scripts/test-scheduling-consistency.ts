/**
 * Scheduling consistency tests (Weekly/Monthly Plan).
 *
 * Guards the canonical scheduling contract:
 *  - every Schedule action stores plannedDate + plannedTime + plannedAt
 *  - Weekly and Monthly views read the SAME canonical planned time (one mapper)
 *  - missing metadata / product never blocks scheduling
 *  - legacy "in plan, time-less" drafts normalize without duplicates
 *
 * Runs under tsx with a minimal localStorage/window shim.
 */

// ── Browser shim ───────────────────────────────────────────────────────────────
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
import { ensureScheduledPlanTime, normalizeInPlanDraftTimes, buildDaySlotRows } from "../src/lib/smartSchedule";
import { saveSmartScheduleConfig, getSmartScheduleConfig } from "../src/lib/smartScheduleStore";
import { mapPlanDraftToCalendarEvent, draftsToSortedEvents } from "../src/lib/planCalendar";
import { pinMissingFields } from "../src/lib/pinReadiness";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Local YYYY-MM-DD, `n` days from today. Tests must never hardcode calendar dates:
 *  scheduling into the past is rejected by design, so a fixed date silently rots into
 *  a false failure the day it slips into the past. */
function daysFromToday(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seedConfig() {
  saveSmartScheduleConfig({
    weeklySlots: { 0: ["09:00", "15:00"], 1: ["09:30"], 2: ["09:12", "14:20", "21:30"], 3: ["10:00"], 4: ["09:15", "19:50"], 5: ["11:00"], 6: ["10:30"] },
    boards: [],
  });
}

let seq = 0;
function mkDraft(p: Partial<PinDraft>): PinDraft {
  const id = p.id ?? `d${++seq}`;
  const now = new Date().toISOString();
  const d: PinDraft = {
    id, imageUrl: p.imageUrl ?? "https://cdn.example.com/p.jpg",
    keyword: p.keyword ?? "boho bedroom", category: p.category ?? "home-decor",
    title: p.title ?? "Boho bedroom", description: p.description ?? "desc",
    altText: p.altText ?? "", destinationUrl: p.destinationUrl ?? "",
    boardId: p.boardId ?? "", boardName: p.boardName ?? "",
    weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: p.scheduledDate ?? "", scheduledTime: p.scheduledTime ?? "",
    plannedAt: p.plannedAt ?? "",
    status: p.status ?? "needs_review", createdAt: now, updatedAt: now,
    source: "generated", addedToPlanAt: p.addedToPlanAt ?? "",
    ...p,
  };
  return d;
}
function seedDrafts(drafts: PinDraft[]) {
  _store.set("vp:pin_drafts:v1", JSON.stringify({ drafts: Object.fromEntries(drafts.map(d => [d.id, d])) }));
  // pinDraftStore keeps an in-memory cache that is the source of truth once loaded;
  // writing raw localStorage behind its back is invisible until the cache is dropped.
  pinDraftStore.__resetMemoryCacheForTests();
}
function reset() {
  _store.clear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  seq = 0;
  // Drop the store's cached drafts too, or the previous test's drafts leak into this one.
  pinDraftStore.__resetMemoryCacheForTests();
  seedConfig();
}

const planSrc = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");

console.log("Scheduling consistency");

// 1
test("Schedule assigns plannedDate + plannedTime + plannedAt", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1" })]);
  const res = ensureScheduledPlanTime("u1");
  assert(res.ok, "schedule failed");
  const d = pinDraftStore.getDraft("u1")!;
  assert(!!d.scheduledDate, "no scheduledDate");
  assert(/^\d{2}:\d{2}$/.test(d.scheduledTime ?? ""), `no scheduledTime: ${d.scheduledTime}`);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.plannedAt ?? ""), `bad plannedAt: ${d.plannedAt}`);
});

// 2
test("Scheduling multiple pins assigns sequential distinct slots", () => {
  reset();
  seedDrafts([mkDraft({ id: "a" }), mkDraft({ id: "b" }), mkDraft({ id: "c" })]);
  const occupied = new Set<string>();
  const keys: string[] = [];
  for (const id of ["a", "b", "c"]) {
    const r = ensureScheduledPlanTime(id, { extraOccupied: occupied });
    assert(r.ok, `schedule ${id} failed`);
    const k = `${r.ok && r.slot.plannedDate}|${r.ok && r.slot.plannedTime}`;
    occupied.add(k); keys.push(k);
  }
  assert(new Set(keys).size === 3, `slots not distinct: ${keys.join(", ")}`);
});

// 3
test("Schedule does not overwrite existing plannedAt (idempotent)", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1" })]);
  ensureScheduledPlanTime("u1");
  const first = pinDraftStore.getDraft("u1")!.plannedAt;
  ensureScheduledPlanTime("u1");
  assert(pinDraftStore.getDraft("u1")!.plannedAt === first, "plannedAt changed on re-schedule without reschedule flag");
  // Explicit reschedule onto a new date should change it. Must be a FUTURE date —
  // scheduling into the past is rejected by design (the Pin could never publish), so
  // a hardcoded calendar date would rot into a false failure the day it passes.
  const target = daysFromToday(5);
  const res = ensureScheduledPlanTime("u1", { date: target, reschedule: true });
  assert(res.ok, "reschedule onto a free future day should succeed");
  const moved = pinDraftStore.getDraft("u1")!;
  assert(moved.scheduledDate === target, `reschedule date not applied: ${moved.scheduledDate}`);
});

// 4
test("Weekly and Monthly mappers return identical plannedTime", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1" })]);
  ensureScheduledPlanTime("u1");
  const d = pinDraftStore.getDraft("u1")!;
  const weekly = mapPlanDraftToCalendarEvent(d);
  const monthly = mapPlanDraftToCalendarEvent(d); // same canonical mapper both views call
  assert(weekly.plannedTime === monthly.plannedTime && weekly.plannedTime === d.scheduledTime,
    `mismatch w=${weekly.plannedTime} m=${monthly.plannedTime} stored=${d.scheduledTime}`);
});

// 5
test("Monthly events sort by plannedAt ascending", () => {
  reset();
  seedDrafts([
    mkDraft({ id: "x1", scheduledDate: "2026-06-17", scheduledTime: "21:30", plannedAt: "2026-06-17T21:30", addedToPlanAt: "x" }),
    mkDraft({ id: "x2", scheduledDate: "2026-06-17", scheduledTime: "07:45", plannedAt: "2026-06-17T07:45", addedToPlanAt: "x" }),
    mkDraft({ id: "x3", scheduledDate: "2026-06-17", scheduledTime: "14:20", plannedAt: "2026-06-17T14:20", addedToPlanAt: "x" }),
  ]);
  const evs = draftsToSortedEvents(pinDraftStore.getAllDrafts());
  const times = evs.map(e => e.plannedTime);
  assert(JSON.stringify(times) === JSON.stringify(["07:45", "14:20", "21:30"]), `not sorted: ${times.join(",")}`);
});

// 6
test("Month cell renders time + VERTICAL portrait thumbnail (no horizontal strip)", () => {
  assert(/data-testid="month-pin-time"/.test(planSrc), "missing month-pin-time");
  assert(/Pinterest portrait thumbnail/.test(planSrc), "portrait thumbnail comment missing");
  assert(/width: 34, height: 48/.test(planSrc), "month thumbnail not portrait (expected width 34 x height 48)");
  // Old horizontal strip (flex:1 + tiny fixed height) must be gone from the month row.
  assert(!/flex: 1, minWidth: 0, height: 28/.test(planSrc), "horizontal strip thumbnail still present");
});

// 7
test("Missing destinationUrl / board / product does NOT block scheduling", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1", destinationUrl: "", boardId: "", boardName: "", altText: "", primaryProductId: "" })]);
  const res = ensureScheduledPlanTime("u1");
  assert(res.ok, "scheduling blocked by missing metadata");
  const d = pinDraftStore.getDraft("u1")!;
  assert(!!d.scheduledTime && !!d.plannedAt, "no time assigned despite missing metadata");
});

// 8
test("Product missing is not a schedule-blocking readiness field", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1" })]);
  ensureScheduledPlanTime("u1");
  const d = pinDraftStore.getDraft("u1")!;
  const ev = mapPlanDraftToCalendarEvent(d);
  assert(ev.planStatus === "scheduled", `expected scheduled, got ${ev.planStatus}`);
  const missing = pinMissingFields({ imageUrl: d.imageUrl, title: d.title, description: d.description, altText: d.altText, destinationUrl: d.destinationUrl, boardId: d.boardId });
  assert(!(missing as string[]).includes("product"), "product counted as a required/blocking field");
});

// 9
test("Legacy added_to_plan drafts without time normalize safely (no dupes)", () => {
  reset();
  const future = daysFromToday(6);
  const past = daysFromToday(-20);
  seedDrafts([
    // Still-reachable day → must be preserved exactly.
    mkDraft({ id: "leg1", scheduledDate: future, scheduledTime: "", addedToPlanAt: "2026-06-01T00:00:00Z" }),
    // No day at all → takes the next free future slot.
    mkDraft({ id: "leg2", scheduledDate: "", scheduledTime: "", addedToPlanAt: "2026-06-01T00:00:00Z" }),
    // Day already gone → must NOT be pinned to it (nothing can publish on a past day,
    // so keeping it would strand the draft as permanently unschedulable). It moves.
    mkDraft({ id: "leg3", scheduledDate: past, scheduledTime: "", addedToPlanAt: "2026-06-01T00:00:00Z" }),
  ]);
  const before = pinDraftStore.getAllDrafts().length;
  const fixed = normalizeInPlanDraftTimes();
  const after = pinDraftStore.getAllDrafts().length;
  assert(after === before, `draft count changed (dupes): ${before} -> ${after}`);
  assert(fixed === 3, `expected 3 normalized, got ${fixed}`);
  for (const id of ["leg1", "leg2", "leg3"]) {
    const d = pinDraftStore.getDraft(id)!;
    assert(/^\d{2}:\d{2}$/.test(d.scheduledTime ?? ""), `${id} still time-less: ${d.scheduledTime}`);
    assert(!!d.plannedAt, `${id} no plannedAt`);
  }
  const today = daysFromToday(0);
  assert(pinDraftStore.getDraft("leg1")!.scheduledDate === future, "leg1 (reachable day) must keep its date");
  assert(pinDraftStore.getDraft("leg3")!.scheduledDate >= today, "leg3 must be rescued off its past date, not stranded");
});

// 10
test("Duplicate Schedule does not create duplicate plan items", () => {
  reset();
  seedDrafts([mkDraft({ id: "u1" })]);
  ensureScheduledPlanTime("u1");
  const c1 = pinDraftStore.getAllDrafts().length;
  const at1 = pinDraftStore.getDraft("u1")!.plannedAt;
  ensureScheduledPlanTime("u1");
  ensureScheduledPlanTime("u1");
  const c2 = pinDraftStore.getAllDrafts().length;
  assert(c1 === c2, `duplicate plan items created: ${c1} -> ${c2}`);
  assert(pinDraftStore.getDraft("u1")!.plannedAt === at1, "plannedAt drifted on duplicate schedule");
});

// ── Strict target date ────────────────────────────────────────────────────────
// An explicitly requested date is an intent, not a hint. It is honoured exactly or
// it fails: sliding the Pin to another day, or accepting a slot in the past (which
// could never publish), are both silent data corruption.

// 11
test("strict date: a free future day schedules ON that day", () => {
  reset();
  seedDrafts([mkDraft({ id: "s1" })]);
  const date = daysFromToday(4);
  const res = ensureScheduledPlanTime("s1", { date, reschedule: true });
  assert(res.ok, `expected ok, got ${res.ok ? "" : res.reason}`);
  assert(res.ok && res.slot.plannedDate === date, `landed on the wrong day: ${res.ok && res.slot.plannedDate}`);
  assert(pinDraftStore.getDraft("s1")!.scheduledDate === date, "draft not persisted on the requested day");
});

// 12
test("strict date: a FULL day fails — it must not slide to the next day", () => {
  reset();
  const date = daysFromToday(3);
  seedDrafts([mkDraft({ id: "s1" })]);
  // Occupy every configured slot on that day. Ask the product for the day's real slot
  // list — hand-deriving the weekday index gets it wrong (weeklySlots is Monday-based,
  // Date#getDay is Sunday-based) and would silently occupy the wrong day.
  const times = buildDaySlotRows(date, [], { config: getSmartScheduleConfig() }).map(r => r.time);
  assert(times.length > 0, "fixture needs a day that has slots");
  const occupied = new Set(times.map(t => `${date}|${t}`));

  const res = ensureScheduledPlanTime("s1", { date, reschedule: true, extraOccupied: occupied });
  assert(!res.ok, `full day must fail, but it scheduled onto ${res.ok && res.slot.plannedDate}`);
  assert(!res.ok && res.reason === "no_slot", `expected no_slot, got ${!res.ok && res.reason}`);
  const d = pinDraftStore.getDraft("s1")!;
  assert(!d.scheduledDate && !d.scheduledTime && !d.plannedAt, "a failed schedule must not touch the draft");
});

// 13
test("strict date: today's ALREADY-PAST times are never used", () => {
  reset();
  seedDrafts([mkDraft({ id: "s1" })]);
  const today = daysFromToday(0);
  // Give today a single slot one minute in the past.
  const past = new Date(Date.now() - 60_000);
  const hhmm = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
  saveSmartScheduleConfig({ weeklySlots: { [past.getDay()]: [hhmm] }, boards: [] });

  const res = ensureScheduledPlanTime("s1", { date: today, reschedule: true });
  assert(!res.ok, `a past time today must not be scheduled (got ${res.ok && res.slot.plannedTime})`);
  const d = pinDraftStore.getDraft("s1")!;
  assert(!d.plannedAt, "draft must be untouched after a past-time rejection");
});

// 14
test("strict date: a historical date fails and leaves the draft untouched", () => {
  reset();
  seedDrafts([mkDraft({ id: "s1" })]);
  const res = ensureScheduledPlanTime("s1", { date: daysFromToday(-10), reschedule: true });
  assert(!res.ok, "scheduling into the past must fail");
  assert(!res.ok && res.reason === "no_slot", `expected no_slot, got ${!res.ok && res.reason}`);
  const d = pinDraftStore.getDraft("s1")!;
  assert(!d.scheduledDate && !d.scheduledTime && !d.plannedAt, "a failed schedule must not touch the draft");
});

// 15
test("strict date: a failed reschedule preserves the EXISTING schedule", () => {
  reset();
  seedDrafts([mkDraft({ id: "s1" })]);
  const good = daysFromToday(2);
  assert(ensureScheduledPlanTime("s1", { date: good, reschedule: true }).ok, "setup schedule failed");
  const before = pinDraftStore.getDraft("s1")!;
  const keptDate = before.scheduledDate, keptTime = before.scheduledTime, keptAt = before.plannedAt;

  // Now try to move it into the past — must fail and change NOTHING.
  const res = ensureScheduledPlanTime("s1", { date: daysFromToday(-3), reschedule: true });
  assert(!res.ok, "past reschedule must fail");
  const after = pinDraftStore.getDraft("s1")!;
  assert(after.scheduledDate === keptDate && after.scheduledTime === keptTime && after.plannedAt === keptAt,
    `failed reschedule clobbered the existing slot: ${keptDate} ${keptTime} -> ${after.scheduledDate} ${after.scheduledTime}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
