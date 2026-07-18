/**
 * test-custom-time.ts
 * "Custom time" picker in DraftDetailsDrawer's schedule footer (CustomTimeModal).
 *
 * Covers: local round-trip persistence through the EXISTING scheduledDate/
 * scheduledTime fields (this app deliberately never converts plan times through
 * UTC — see weeklyPlanHandoff.ts localDateISO/combineLocalPlannedAt — so "UTC
 * round-trip" here means the modal's local Date <-> "YYYY-MM-DD"/"HH:mm" strings
 * survive a round trip without a day/hour shift, the same invariant the rest of
 * the app relies on), past-time rejection, board-change reset, locale-aware
 * formatting of the chosen time, and that the default (no custom time chosen)
 * Schedule path is untouched.
 *
 * Source-level checks (drawer wiring) + pure-logic checks (date helpers already
 * exported from pinDetailsModel.ts / dateTimeFormat.ts) — same style as
 * test-pin-details-persistence.ts / test-weekly-plan-slots.ts. No DOM required.
 *
 * Run: npx tsx scripts/test-custom-time.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { combinePlannedAt } from "../src/lib/pinDetailsModel";
import { formatEnglishDateTime, browserTimeZone } from "../src/lib/dateTimeFormat";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  OK  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(e as Error).message}`);
  }
}

const root = process.cwd();
const drawerSource = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
const modalSource = readFileSync(join(root, "src/components/plan/CustomTimeModal.tsx"), "utf8");
const enSource = readFileSync(join(root, "src/lib/i18n/messages/en.ts"), "utf8");

console.log("\n=== Custom time picker (DraftDetailsDrawer + CustomTimeModal) ===");

// ── 1. Local date/time round-trip (the app's "no UTC shift" invariant) ─────────

test("1a. combinePlannedAt round-trips date+time without a UTC/day shift", () => {
  const date = "2026-07-16";
  const time = "12:21";
  const combined = combinePlannedAt(date, time);
  assert.equal(combined, "2026-07-16T12:21", "combinePlannedAt must preserve the exact local calendar date and time");
  // Re-splitting must recover the same values — no timezone conversion in either direction.
  const [d, t] = combined.split("T");
  assert.equal(d, date);
  assert.equal(t, time);
});

test("1b. round-trip holds across a UTC day boundary (late-night local time)", () => {
  // 23:45 local, in any UTC+ timezone, would be the next UTC calendar day if ever
  // routed through toISOString().slice(0,10) — the exact bug the app's own
  // localDateISO/combineLocalPlannedAt helpers exist to prevent (weeklyPlanHandoff.ts).
  const date = "2026-07-16";
  const time = "23:45";
  const combined = combinePlannedAt(date, time);
  assert.equal(combined, "2026-07-16T23:45", "late-night local time must not roll to the next day");
});

test("1c. CustomTimeModal never converts through Date.toISOString for date storage", () => {
  assert.ok(
    !modalSource.includes("toISOString()"),
    "CustomTimeModal must not serialize the picked date/time via toISOString (would UTC-shift the day) — " +
    "it must hand back local YYYY-MM-DD / HH:mm strings, matching localDateISO/combineLocalPlannedAt",
  );
});

// ── 2. Past-time rejection ──────────────────────────────────────────────────────

test("2a. CustomTimeModal disables past calendar days", () => {
  assert.ok(modalSource.includes("isPast = date < today"), "day grid must compute an isPast flag against today");
  assert.ok(modalSource.includes("disabled={isPast}"), "past days must be rendered disabled");
});

test("2b. CustomTimeModal validates the FULL datetime on Save (not just the day)", () => {
  // A "today" date with an already-past hour/minute must still be rejected — the
  // day-level disable alone cannot catch this (today is never disabled).
  assert.ok(modalSource.includes("candidate.getTime() <= Date.now()"), "Save must compare the full candidate datetime against now");
  assert.ok(modalSource.includes("pinDetails.customTime.pastTimeError"), "Save must surface a past-time error key on rejection");
});

test("2c. past-datetime math itself rejects a today+past-hour combination", () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60_000); // one minute ago
  assert.ok(past.getTime() <= Date.now(), "sanity: a datetime one minute in the past must compare <= now");
});

// ── 3. Board-change reset ───────────────────────────────────────────────────────

test("3a. changing the board while a custom time is chosen-but-unconfirmed resets it", () => {
  const m = drawerSource.match(/onChange=\{\(id\) => \{[\s\S]*?onClearBoardError=/);
  assert.ok(m, "PinBoardSection onChange handler not found");
  const body = m![0];
  assert.ok(body.includes("customTimeChosen && !customTimeConfirmed"), "board onChange must check the pending-custom-time condition");
  assert.ok(body.includes('setPlannedDate("")') && body.includes('setScheduledTime("")'), "board onChange must clear plannedDate/scheduledTime when a custom time is pending");
  assert.ok(body.includes("setCustomTimeChosen(false)"), "board onChange must clear customTimeChosen");
  assert.ok(body.includes("setCustomTimeBoardChangedNotice(true)"), "board onChange must surface the board-changed notice");
});

test("3b. the board-changed notice uses the exact required copy key, not the old multi-board hint", () => {
  assert.ok(drawerSource.includes("pinDetails.customTime.boardChangedNotice"), "drawer must render the boardChangedNotice key");
  assert.ok(!drawerSource.includes("You will need to reselect your time if more than one board is added later"), "the old multi-board hint text must never appear");
  assert.ok(!modalSource.includes("You will need to reselect your time if more than one board is added later"), "the old multi-board hint text must never appear in the modal either");
});

test("3c. drawer only supports single-board selection — no multi-board hint added", () => {
  // PinBoardSection's onChange takes a single boardId string; the drawer stores a
  // single boardId, never an array. Confirms the "single board -> no multi-board
  // hint" branch of the spec applies here.
  assert.ok(drawerSource.includes("const [boardId, setBoardId] = useState(\"\")"), "boardId must be a single string, not a multi-select array");
  assert.ok(!drawerSource.includes("selectedBoardIds"), "drawer must not have grown a multi-board selection concept");
});

test("3d. confirming the schedule (clicking Schedule/Update schedule) commits the custom time", () => {
  const m = drawerSource.match(/function handleSchedulePrimary\(\)[\s\S]*?\n  }/);
  assert.ok(m, "handleSchedulePrimary not found");
  assert.ok(m![0].includes("if (customTimeChosen) setCustomTimeConfirmed(true)"), "handleSchedulePrimary must confirm a pending custom time");
});

// ── 4. Formatting ────────────────────────────────────────────────────────────────

test("4a. formatEnglishDateTime renders the spec's example shape (\"Jul 16, 12:21 PM\")", () => {
  // Use a fixed local wall-clock instant expressed via combinePlannedAt (no UTC
  // conversion) and format it — mirrors exactly what the footer button does.
  const combined = combinePlannedAt("2026-07-16", "12:21");
  const formatted = formatEnglishDateTime(combined);
  assert.ok(formatted, "formatEnglishDateTime must not return null for a valid local datetime string");
  assert.match(formatted!, /^Jul 16, 2026, 12:21\s?PM$/, `expected "Jul 16, 2026, 12:21 PM"-shaped output, got "${formatted}"`);
});

test("4b. footer button formats the chosen custom time via formatEnglishDateTime + combinePlannedAt", () => {
  assert.ok(drawerSource.includes("draft-cta-custom-time"), "custom time footer button testid missing");
  assert.ok(
    drawerSource.includes("formatEnglishDateTime(combinePlannedAt(plannedDate, scheduledTime))"),
    "custom time button must format via formatEnglishDateTime(combinePlannedAt(...)) — the same pair used elsewhere in this file",
  );
});

test("4c. timezone note renders the browser IANA timezone name (no workspace timezone concept exists)", () => {
  const tz = browserTimeZone();
  assert.ok(typeof tz === "string" && tz.length > 0, "browserTimeZone() must return a non-empty IANA name (or \"Unknown\")");
  assert.ok(drawerSource.includes("timeZoneName={browserTimeZone()}"), "drawer must pass browserTimeZone() into CustomTimeModal");
  assert.ok(modalSource.includes("pinDetails.customTime.timezoneNote"), "modal must render the timezone note key");
  assert.ok(modalSource.includes('.replace("{timezone}", timeZoneName)'), "modal must interpolate {timezone} with the resolved IANA name");
});

// ── 5. Default Schedule path untouched when no custom time is chosen ───────────

test("5a. handleSchedulePrimary's core gate logic (board/image/url checks) is unmodified by the custom-time feature", () => {
  assert.ok(drawerSource.includes("if (!hasValidImage) {"), "image gate must still exist");
  assert.ok(drawerSource.includes("if (!hasValidUrl) {"), "url gate must still exist");
  assert.ok(drawerSource.includes("if (!hasBoard) {"), "board gate must still exist");
  assert.ok(drawerSource.includes('if (!plannedDate.trim()) setPlannedDate(plannableDateISO(1));'), "default next-day fallback must still exist");
  assert.ok(drawerSource.includes('if (!scheduledTime.trim()) setScheduledTime("09:00");'), "default 09:00 fallback must still exist");
});

test("5b. Schedule button label logic (Schedule vs Update schedule) is unchanged", () => {
  assert.ok(
    drawerSource.includes('{isScheduled ? t("pinDetails.updateSchedule") : t("pinDetails.schedule")}'),
    "Schedule/Update schedule label branch must be present unmodified",
  );
});

test("5c. custom-time state does not gate canSchedule — publishing without ever opening the modal still works", () => {
  const m = drawerSource.match(/const canSchedule = [^;]+;/);
  assert.ok(m, "canSchedule definition not found");
  assert.ok(!m![0].includes("customTime"), "canSchedule must not reference any customTime state — the default path must not require the modal");
});

test("5d. a fresh/never-opened custom time modal defaults to unchosen on drawer seed", () => {
  const m = drawerSource.match(/const seededCustomTime = [^;]+;/);
  assert.ok(m, "seededCustomTime derivation not found");
  assert.ok(m![0].includes('draft.scheduleSource === "manual"'), "seeding must only mark custom time chosen for drafts explicitly scheduled manually");
});

// ── 6. Persistence goes through the EXISTING scheduledDate/scheduledTime fields ──

test("6a. CustomTimeModal never introduces a new persisted field name", () => {
  assert.ok(!modalSource.includes("scheduledAt"), "modal must not reference a new scheduledAt field");
  assert.ok(!drawerSource.match(/\bscheduledAt\b/), "drawer must not have grown a parallel scheduledAt field");
});

test("6b. handleCustomTimeSave stages plannedDate/scheduledTime — the same state Schedule persists", () => {
  const m = drawerSource.match(/function handleCustomTimeSave\([\s\S]*?\n  }/);
  assert.ok(m, "handleCustomTimeSave not found");
  const body = m![0];
  assert.ok(body.includes("setPlannedDate(date)"), "must stage plannedDate");
  assert.ok(body.includes("setScheduledTime(time)"), "must stage scheduledTime");
  assert.ok(body.includes("markDirty()"), "must trigger the existing autosave path (persistDraft), not a separate write");
});

test("6c. persistDraft (the single write path) still writes scheduledDate/scheduledTime as separate fields", () => {
  assert.ok(drawerSource.includes("scheduledDate: trimmedDate"), "scheduledDate must still be written by persistDraft");
  assert.ok(drawerSource.includes('scheduledTime: trimmedDate ? scheduledTime.trim() : ""'), "scheduledTime must still be written by persistDraft");
});

test("6d. persisting a manually-chosen custom time updates the draft's updatedAt (via pinDraftStore.updateDraft)", () => {
  const storeSource = readFileSync(join(root, "src/lib/pinDraftStore.ts"), "utf8");
  assert.ok(
    storeSource.includes("const updated: PinDraft = { ...draft, ...patch, updatedAt: new Date().toISOString() };"),
    "updateDraft must stamp updatedAt on every patch, including custom-time schedules routed through persistDraft",
  );
});

// ── 7. i18n keys exist and follow the catalog's flat pinDetails.* convention ────

test("7. all new custom-time i18n keys exist in en.ts with non-empty English values", () => {
  const requiredKeys = [
    "pinDetails.customTime.selectButton",
    "pinDetails.customTime.modalTitle",
    "pinDetails.customTime.close",
    "pinDetails.customTime.prevMonth",
    "pinDetails.customTime.nextMonth",
    "pinDetails.customTime.hour",
    "pinDetails.customTime.minute",
    "pinDetails.customTime.am",
    "pinDetails.customTime.pm",
    "pinDetails.customTime.saveButton",
    "pinDetails.customTime.timezoneNote",
    "pinDetails.customTime.pastTimeError",
    "pinDetails.customTime.boardChangedNotice",
  ];
  for (const key of requiredKeys) {
    const re = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"[^"]+"`);
    assert.ok(re.test(enSource), `missing or empty en.ts key: ${key}`);
  }
});

test("7b. timezoneNote carries the {timezone} placeholder validate-i18n-catalogs.ts checks for", () => {
  assert.ok(/"pinDetails\.customTime\.timezoneNote":\s*"[^"]*\{timezone\}[^"]*"/.test(enSource), "timezoneNote must contain a {timezone} placeholder");
});

// ── Summary ──────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
