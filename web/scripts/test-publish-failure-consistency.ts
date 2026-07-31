/**
 * test-publish-failure-consistency.ts
 *
 * 验收 P0/P0.5 的核心逻辑（任务书 0722 §十 1-14 中可纯逻辑断言的部分）：
 * 统一后的 actionable-publish-failure 谓词与两个派生 selector 在关键场景下的计数，
 * 以及 Plan 列表 Failed 判定不再漏 publish 失败。不碰任何库/localStorage/服务。
 */

import assert from "node:assert/strict";
import type { PinDraft } from "../src/lib/pinDraftStore";
import {
  isActionablePublishFailure,
  listActionablePublishFailures,
  listBoardActionablePublishFailures,
  countPublishFailures,
  getPinLifecycle,
} from "../src/lib/studio/pinLifecycle";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  OK  ${name}`);
}

function draft(over: Partial<PinDraft>): PinDraft {
  return {
    id: "d",
    imageUrl: "https://cdn.example.com/a.jpg",
    keyword: "", category: "",
    title: "T", description: "D", altText: "A",
    destinationUrl: "https://example.com",
    boardId: "b", boardName: "Board",
    weeklyPlanItemId: "", generationSessionId: "",
    scheduledDate: "", status: "ready",
    createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z",
    ...over,
  } as PinDraft;
}

// A board-source (Create Pins upload/AI) publish failure.
function boardPubFail(id: string, over: Partial<PinDraft> = {}): PinDraft {
  return draft({ id, source: "uploaded_image", failureType: "publish", publishError: "Publish failed", ...over });
}
// A Weekly-Plan-origin (non-board-source) publish failure (Plan drawer / cron).
function planPubFail(id: string, over: Partial<PinDraft> = {}): PinDraft {
  return draft({ id, source: "workspace", failureType: "publish", publishError: "Publish failed", ...over });
}

console.log("\n=== §十: 3 个失败 Pin，其中一个连失 3 次 → 计 3 不是 5 ===");
test("同一 Pin 多次失败只算 1（store 单行覆盖写，无重复行）", () => {
  // Pin A 连失 3 次 = 仍是同一条 draft（覆盖写），Pin B、Pin C 各失败 1 次。
  const drafts = [
    boardPubFail("A"), // A 的最新一次失败态（前两次已被覆盖，store 里只有这一行）
    boardPubFail("B"),
    boardPubFail("C"),
  ];
  assert.equal(countPublishFailures(drafts), 3, "应为 3 个唯一失败 draft");
  assert.equal(listBoardActionablePublishFailures(drafts).length, 3);
});

console.log("\n=== §十一/§四: 归档失败不计入 actionable ===");
test("已归档的 publish 失败 → 不计入（!archived）", () => {
  const drafts = [boardPubFail("A"), boardPubFail("B", { archivedAt: "2026-07-23T01:00:00.000Z" })];
  assert.equal(countPublishFailures(drafts), 1, "归档的 B 应被排除");
  assert.equal(isActionablePublishFailure(drafts[1]), false);
});

console.log("\n=== 消除字段不对称：有 publishError 但无 failureType ===");
test("旧脏数据（publishError 有、failureType 缺）→ 不计入 publish 失败", () => {
  const dirty = draft({ id: "X", source: "uploaded_image", publishError: "err", failureType: undefined });
  assert.equal(isActionablePublishFailure(dirty), false, "缺 failureType 不算 actionable publish 失败");
  assert.equal(countPublishFailures([dirty]), 0);
});
test("成功发布后清除失败态 → 不计入（postedAt 且失败字段已删）", () => {
  const posted = draft({ id: "P", source: "uploaded_image", postedAt: "2026-07-23T02:00:00.000Z" });
  assert.equal(isActionablePublishFailure(posted), false);
  assert.equal(getPinLifecycle(posted), "posted");
});

console.log("\n=== 边界裁决：Plan 全量含非 board-source，Create Pins 只含板内 ===");
test("非 board-source 的 publish 失败：Plan 计入、Create Pins 板内不计入", () => {
  const drafts = [boardPubFail("A"), planPubFail("W")]; // 1 板内 + 1 Weekly-Plan 来源
  // Plan（全量 selector）= 2
  assert.equal(listActionablePublishFailures(drafts).length, 2, "Plan 全量应含非 board-source");
  assert.equal(countPublishFailures(drafts), 2);
  // Create Pins（板内 selector）= 1
  assert.equal(listBoardActionablePublishFailures(drafts).length, 1, "Create Pins 只含 board-source");
});
test("Plan ≥ Create Pins 是语义正确（Plan 是全量处理入口）", () => {
  const drafts = [boardPubFail("A"), planPubFail("W1"), planPubFail("W2")];
  const planN = listActionablePublishFailures(drafts).length;
  const cpN = listBoardActionablePublishFailures(drafts).length;
  assert.ok(planN >= cpN, `Plan(${planN}) >= CreatePins(${cpN})`);
  assert.equal(planN, 3);
  assert.equal(cpN, 1);
});

console.log("\n=== §十 11: 生成失败不计入 publish 失败数 ===");
test("生成失败（generationStatus=failed，无 publishError）→ 不计入 publish 数，但 lifecycle 仍是 failed", () => {
  const genFail = draft({ id: "G", source: "ai_generated_from_upload", generationStatus: "failed" });
  assert.equal(isActionablePublishFailure(genFail), false, "生成失败不是 publish 失败");
  assert.equal(countPublishFailures([genFail]), 0);
  assert.equal(getPinLifecycle(genFail), "failed", "但它在 Failed 总口径里仍是 failed");
});

console.log("\n=== P0.5-A: PlanListView 的 Failed 判定（getPinLifecycle）覆盖 publish 失败 ===");
test("publish 失败草稿 getPinLifecycle === 'failed'（旧 generationStatus-only 会漏）", () => {
  const pf = planPubFail("W"); // 无 generationStatus，仅 publishError+failureType
  assert.equal(pf.generationStatus, undefined, "构造：无 generationStatus");
  assert.equal(getPinLifecycle(pf), "failed", "统一后 publish 失败也归 Failed（修复漏判）");
});

console.log(`\nPublish-failure consistency: ${passed} passed, 0 failed\n`);
