import assert from "node:assert/strict";
import {
  buildEtSlots,
  classifyExistingDraft,
  dedupeWinningHunterQueue,
  mapWinningHunterBoard,
  toUtcIso,
  buildWinningHunterPlan,
  buildWinningHunterPortraitTransformCommand,
  buildExistingShiftPlan,
  MAX_PRIVATE_VIDEO_BYTES,
  targetWinningHunterVideoBitrateKbps,
  type ExistingScheduleRow,
  type WinningHunterQueueItem,
} from "./lib/winninghunter-queue-ops";

const item = (patch: Partial<WinningHunterQueueItem> = {}): WinningHunterQueueItem => ({
  queue_rank: 1,
  queue_class: "ready_after_platform_gates",
  readiness: "ready_after_platform_gates",
  sha256: "a".repeat(64),
  source_files: ["C:/video.mp4"],
  source_ad_ids: ["ad-1"],
  title: "Giftable product",
  shopify_product_id: "gid://shopify/Product/1",
  handle: "giftable-product",
  public_url: "https://cheerish.co/products/giftable-product",
  homepage_featured: true,
  active_status: "ACTIVE",
  active_verified_at: "09/21/2026 15:37:44",
  mapping_confirmed: true,
  copy_override_applied: true,
  copy: {
    pinterest: { title: "Giftable product", description: "A useful find.", destination_url: "https://cheerish.co/products/giftable-product" },
  },
  platforms: { pinterest: { status: "not_scheduled", scheduled_at: null, remote_id: null, block_reasons: [] } },
  ...patch,
});

assert.equal(dedupeWinningHunterQueue([item(), item({ sha256: "b".repeat(64), source_ad_ids: ["ad-1"], shopify_product_id: "gid://shopify/Product/2" }), item({ sha256: "c".repeat(64), source_ad_ids: ["ad-3"], shopify_product_id: "gid://shopify/Product/1" })]).accepted.length, 1);
assert.equal(mapWinningHunterBoard("personalized preserved rose necklace", "gift ideas"), "813814663855482394");
assert.equal(mapWinningHunterBoard("women's fashion scarf", "fashion"), "813814663855482396");
assert.equal(toUtcIso("2026-09-22T09:00", "America/New_York"), "2026-09-22T13:00:00.000Z");
const slots = buildEtSlots(new Date("2026-09-21T20:00:00-04:00"), 48);
assert.equal(slots.length, 48);
assert.deepEqual(slots.slice(0, 3), ["2026-09-22T09:00", "2026-09-22T10:00", "2026-09-22T11:00"]);
assert.deepEqual(slots.slice(-1), ["2026-09-25T20:00"]);
assert.equal(classifyExistingDraft({ status: "ready", payload: { scheduleSource: "manual", scheduleLocked: true } }), "protected");
assert.equal(classifyExistingDraft({ status: "ready", payload: { scheduleSource: "smart", scheduleLocked: false, plannedAt: "2026-09-22T10:00" } }), "shiftable");
const plan = buildWinningHunterPlan([item({ sha256: "d".repeat(64) }), item({ sha256: "e".repeat(64), source_files: ["C:/other.mp4"], source_ad_ids: ["ad-2"], shopify_product_id: "gid://shopify/Product/2", public_url: "https://cheerish.co/products/other" })], new Date("2026-09-21T20:00:00-04:00"));
assert.deepEqual(plan.map((row) => [row.plannedAt, row.scheduledAt]), [["2026-09-22T09:00", "2026-09-22T13:00:00.000Z"], ["2026-09-22T10:00", "2026-09-22T14:00:00.000Z"]]);
assert.equal(plan[0].idempotencyKey, `winninghunter:${"d".repeat(64)}`);
const filterCommand = buildWinningHunterPortraitTransformCommand("in.mp4", "out.mp4").join(" ");
assert.match(filterCommand, /in_range=auto/);
assert.match(filterCommand, /out_range=tv/);
assert.match(filterCommand, /-pix_fmt yuv420p/);
assert.match(filterCommand, /-maxrate/);
assert.equal(MAX_PRIVATE_VIDEO_BYTES, 45 * 1024 * 1024);
assert.ok(targetWinningHunterVideoBitrateKbps(30_000) > 0);
const shifts = buildExistingShiftPlan([
  { draft_id: "old-1", status: "ready", scheduled_at: "2026-09-21T12:00:00.000Z", payload: { scheduleSource: "smart", scheduleLocked: false, plannedAt: "2026-09-21T08:00" } },
  { draft_id: "locked", status: "ready", scheduled_at: "2026-09-21T13:00:00.000Z", payload: { scheduleSource: "manual", scheduleLocked: true, plannedAt: "2026-09-21T09:00" } },
], new Date("2026-09-21T20:00:00-04:00"));
assert.equal(shifts.length, 1);
assert.equal(shifts[0].draftId, "old-1");
assert.equal(shifts[0].plannedAt, "2026-09-26T09:00");
console.log("winninghunter queue ops tests passed");
