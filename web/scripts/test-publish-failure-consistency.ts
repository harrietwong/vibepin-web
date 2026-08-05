/**
 * test-publish-failure-consistency.ts
 *
 * 验收统一失败口径的核心逻辑（0722 任务书 §十 中可纯逻辑断言的部分，口径已按
 * PRD v1.1 §6.3 更新）：唯一 actionable-publish-failure 谓词、workspace 全集
 * selector，以及 Plan 周视图用的周范围子集 selector。
 *
 * 口径变更(v1.1)：Plan 已并入 Create Pins 同一个工作台，不再是"Plan 全量 vs
 * Create Pins 板内"两个不同人群 —— 两处读的是**同一个 workspace 全集**，Plan 周
 * 视图只是在其上叠一层"该周"的时间范围过滤。因此这里断言的是
 * `listActionablePublishFailuresInWeek(...) ⊆ listActionablePublishFailures(...)`，
 * 而不是旧的板内/全量边界。不碰任何库/localStorage/服务。
 */

import assert from "node:assert/strict";
import type { PinDraft } from "../src/lib/pinDraftStore";
import {
  isActionablePublishFailure,
  listActionablePublishFailures,
  listActionablePublishFailuresInWeek,
  isActionablePublishFailureInWeek,
  countPublishFailures,
  getPinLifecycle,
} from "../src/lib/studio/pinLifecycle";
import { deriveBoardCollections } from "../src/hooks/usePinBoardDrafts";

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
  assert.equal(listActionablePublishFailures(drafts).length, 3);
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

console.log("\n=== PRD v1.1 §6.3: workspace 全集，来源无关 ===");
test("失败口径与来源无关：board-source 与 Weekly-Plan 来源同等计入 workspace 全集", () => {
  const drafts = [boardPubFail("A"), planPubFail("W")]; // 1 板内 + 1 Weekly-Plan 来源
  // 合并后 Plan 与 Create Pins 是同一个工作台、同一个人群：全集 = 2。
  assert.equal(listActionablePublishFailures(drafts).length, 2, "全集应含非 board-source");
  assert.equal(countPublishFailures(drafts), 2);
  assert.equal(isActionablePublishFailure(drafts[1]), true, "非 board-source 也是 actionable");
});

console.log("\n=== PRD v1.1 §6.3: Plan 周视图 = 全集的周范围子集 ===");
// 周范围取 previousScheduledTime（失败时那个槽），回退 scheduledDate / plannedAt。
const WEEK = "2026-07-27";           // 周一
const IN_WEEK = "2026-07-29T10:00:00.000Z";
const NEXT_WEEK = "2026-08-05T10:00:00.000Z";

test("周范围子集 ⊆ workspace 全集（同一核心谓词，只多一层时间过滤）", () => {
  const drafts = [
    boardPubFail("A", { previousScheduledTime: IN_WEEK }),
    planPubFail("W", { previousScheduledTime: IN_WEEK }),
    boardPubFail("B", { previousScheduledTime: NEXT_WEEK }),
  ];
  const all = listActionablePublishFailures(drafts);
  const week = listActionablePublishFailuresInWeek(drafts, WEEK);
  assert.equal(all.length, 3, "全集含三条（含下周那条）");
  assert.equal(week.length, 2, "本周只含落在本周的两条");
  const allIds = new Set(all.map(d => d.id));
  assert.ok(week.every(d => allIds.has(d.id)), "周子集必须是全集的子集");
  assert.ok(week.length <= all.length, "周子集永不大于全集");
});

test("周范围过滤只看时间，不看来源（Weekly-Plan 来源同样进本周子集）", () => {
  const wp = planPubFail("W", { previousScheduledTime: IN_WEEK });
  assert.equal(isActionablePublishFailureInWeek(wp, WEEK), true);
  assert.equal(isActionablePublishFailureInWeek(wp, "2026-08-03"), false, "下一周不含它");
});

test("周范围不改变核心谓词：归档/缺 failureType 在任何周都不计入", () => {
  const archived = boardPubFail("A", { previousScheduledTime: IN_WEEK, archivedAt: "2026-07-29T12:00:00.000Z" });
  const noType = draft({ id: "X", source: "uploaded_image", publishError: "err", failureType: undefined, previousScheduledTime: IN_WEEK });
  assert.equal(isActionablePublishFailureInWeek(archived, WEEK), false);
  assert.equal(isActionablePublishFailureInWeek(noType, WEEK), false);
  assert.equal(listActionablePublishFailuresInWeek([archived, noType], WEEK).length, 0);
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

// ─────────────────────────────────────────────────────────────────────────────
// 0731 回归: 计数基础集合一致性 (All ≥ Failed)
//
// 线上现象: 筛选条显示 All (4) / Failed (5) —— 不可能。根因不是失败口径本身，而是
// deriveBoardCollections 里两个桶数的是**不同的人群**: boardItems 有
// `.filter(isBoardSource)`（只含 uploaded_image / ai_generated_from_upload），
// failureItems 数的是 activeDrafts 全集。一条 source:"workspace" 的 Weekly-Plan 失败
// 草稿进得了 Failed、进不了 All → Failed 超过 All。
//
// 裁决（PRD v1.1 §6.3，Plan 已并入 Create Pins）: 四个桶全部改用非归档全集，与 failed
// 对齐。这里直接对 deriveBoardCollections + counts 口径断言，而不是对手搓 fixture，
// 保证真实渲染路径被覆盖。
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 0731: 计数基础集合一致性（All 与 Failed 必须同源） ===");

/** Mirrors usePinBoardDrafts' `counts` memo exactly (kept in lockstep by the assertions). */
function countsOf(drafts: PinDraft[]) {
  const { boardItems, failureItems } = deriveBoardCollections(drafts);
  return {
    all:         boardItems.length,
    unscheduled: boardItems.filter(x => x.lifecycle === "unscheduled" || x.lifecycle === "generating").length,
    scheduled:   boardItems.filter(x => x.lifecycle === "scheduled").length,
    posted:      boardItems.filter(x => x.lifecycle === "posted").length,
    failed:      failureItems.length,
  };
}

// 复现现场的人群: 4 条 publish 失败（其中 1 条非 board-source）+ 1 条生成失败
// + 1 条已归档的 publish 失败（不该出现在任何桶里）。
const FIXTURE: PinDraft[] = [
  boardPubFail("p1", { previousScheduledTime: IN_WEEK }),
  boardPubFail("p2", { previousScheduledTime: IN_WEEK }),
  planPubFail("p3-workspace", { previousScheduledTime: IN_WEEK }),   // 非 board-source：旧口径下它只进 Failed
  boardPubFail("p4", { previousScheduledTime: "2026-07-22T10:00:00.000Z" }), // 上周
  draft({ id: "g1", source: "ai_generated_from_upload", generationStatus: "failed" }),
  boardPubFail("archived", { archivedAt: "2026-07-29T12:00:00.000Z", previousScheduledTime: IN_WEEK }),
];

test("All(5) === Failed(5)：全部 6 条里 5 条活跃且全部失败，归档那条两边都不进", () => {
  const c = countsOf(FIXTURE);
  assert.equal(c.all, 5, "All 必须含非 board-source 与生成失败，排除归档 → 5");
  assert.equal(c.failed, 5, "5 条活跃草稿全部处于 failed 生命周期");
  assert.equal(countPublishFailures(FIXTURE), 4, "其中 publish 失败 4 条（生成失败不算）");
  const generationFailures = deriveBoardCollections(FIXTURE).failureItems
    .filter(x => !isActionablePublishFailure(x.draft));
  assert.equal(generationFailures.length, 1, "生成失败 1 条");
  assert.equal(generationFailures[0].draft.id, "g1");
});

test("归档的失败既不进 All 也不进 Failed", () => {
  const { boardItems, failureItems } = deriveBoardCollections(FIXTURE);
  assert.equal(boardItems.some(x => x.draft.id === "archived"), false, "归档不进 All");
  assert.equal(failureItems.some(x => x.draft.id === "archived"), false, "归档不进 Failed");
});

test("回归本体：Failed 永不大于 All（旧代码在这条 fixture 上是 All 4 / Failed 5）", () => {
  const c = countsOf(FIXTURE);
  assert.ok(c.failed <= c.all, `Failed(${c.failed}) 不得超过 All(${c.all})`);
  // 具体到根因：非 board-source 的那条必须同时出现在两个集合里。
  const { boardItems, failureItems } = deriveBoardCollections(FIXTURE);
  assert.ok(boardItems.some(x => x.draft.id === "p3-workspace"), "非 board-source 失败必须进 All");
  assert.ok(failureItems.some(x => x.draft.id === "p3-workspace"), "非 board-source 失败必须进 Failed");
});

test("All 是各桶之和（同源的直接推论，只改 All 会破坏这条）", () => {
  const mixed: PinDraft[] = [
    ...FIXTURE,
    draft({ id: "u1", source: "workspace" }),                                   // unscheduled，非 board-source
    draft({ id: "s1", source: "uploaded_image", scheduledDate: "2026-07-30T09:00:00.000Z" }),
    draft({ id: "t1", source: "workspace", postedAt: "2026-07-29T09:00:00.000Z" }), // posted，非 board-source
  ];
  const c = countsOf(mixed);
  assert.equal(c.unscheduled + c.scheduled + c.posted + c.failed, c.all,
    `各桶之和 ${c.unscheduled}+${c.scheduled}+${c.posted}+${c.failed} 必须等于 All ${c.all}`);
  // 并且非 board-source 的普通草稿也确实各归其位（不是靠 0+0 凑等式）。
  assert.ok(c.unscheduled >= 1 && c.posted >= 1, "非 board-source 的 unscheduled/posted 已计入");
});

console.log("\n=== 0731: 周范围只影响 Publish failures 子计数，不影响 All/Failed ===");

test("本周 Publish failures = 3，去掉周范围恢复 4", () => {
  const inWeek = listActionablePublishFailuresInWeek(FIXTURE, WEEK);
  assert.equal(inWeek.length, 3, "p1/p2/p3-workspace 在本周（p4 在上周，archived 被排除）");
  assert.equal(listActionablePublishFailures(FIXTURE).length, 4, "去掉周范围 → 4 条 publish 失败");
  assert.ok(inWeek.every(d => d.id !== "p4"), "上周那条不在本周子集里");
});

test("周范围不改变 All/Failed（它只是 Publish 子筛选上的一层时间过滤）", () => {
  const c = countsOf(FIXTURE);
  assert.equal(c.all, 5);
  assert.equal(c.failed, 5, "Failed 主计数与 week 无关；只有 Publish 子计数按周收窄");
});

console.log(`\nPublish-failure consistency: ${passed} passed, 0 failed\n`);
