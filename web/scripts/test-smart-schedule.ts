/**
 * Smart Schedule unit checks — slot finding, board rotation, toast formatting.
 */
import { findNextAvailableScheduleSlot, pickBoardForRotation, formatSmartScheduleToast } from "../src/lib/smartSchedule";
import type { PinDraft } from "../src/lib/pinDraftStore";
import type { WeekdayIndex } from "../src/lib/smartScheduleStore";

function mockPin(date: string, time: string): PinDraft {
  return {
    id: "x", imageUrl: "https://example.com/a.png", keyword: "k", category: "home",
    title: "t", description: "d", altText: "a", destinationUrl: "https://example.com",
    boardId: "", boardName: "", weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: date, scheduledTime: time, status: "needs_review", createdAt: "", updatedAt: "",
  };
}

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("smartSchedule tests");

{
  const weeklySlots: Partial<Record<WeekdayIndex, string[]>> = { 0: ["09:12", "09:41", "15:04"] };
  const from = new Date("2026-06-22T08:00:00");
  const slot = findNextAvailableScheduleSlot({
    weeklySlots,
    existingPlannedPins: [mockPin("2026-06-22", "09:12")],
    fromDateTime: from,
  });
  assert(slot?.plannedTime === "09:41", "skips occupied slot");
}

{
  const from = new Date("2026-06-22T10:00:00");
  const slot = findNextAvailableScheduleSlot({
    weeklySlots: { 0: ["09:12", "09:41", "15:04"] },
    existingPlannedPins: [],
    fromDateTime: from,
  });
  assert(slot?.plannedTime === "15:04", "skips past slots same day");
}

{
  const boards = [{ boardId: "a", boardName: "Board A" }, { boardId: "b", boardName: "Board B" }];
  assert(pickBoardForRotation(boards, 0)?.boardId === "a", "board rotation A");
  assert(pickBoardForRotation(boards, 1)?.boardId === "b", "board rotation B");
  assert(pickBoardForRotation(boards, 2)?.boardId === "a", "board rotation wrap");
}

{
  const msg = formatSmartScheduleToast(
    { plannedDate: "2026-06-22", plannedTime: "15:04", plannedAt: "2026-06-22T15:04" },
    { boardId: "1", boardName: "Board A" },
  );
  assert(msg.includes("Board A") && msg.includes("3:04 PM"), "toast includes board and time");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
