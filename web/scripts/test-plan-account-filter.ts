/**
 * test-plan-account-filter.ts — Phase D ②:Plan 按账号筛选 + 卡片身份徽标。
 *
 * 覆盖:
 *  1. 三种筛选值(全部 / 具体连接 / 未指定)的归属判定;
 *  2. "未指定目标"必须是独立分桶——adopt-once 之前的老草稿不能凭空消失;
 *  3. 单连接零感知(Phase C 不变量 4 的延续):≤1 个连接时筛选被中和、
 *     select 与徽标都不渲染;
 *  4. UI 契约:徽标复用 targetAccountHandle 不另起一套取值,
 *     Provider 真的挂上了(否则 context 恒 false,徽标是死代码)。
 * Run: npx tsx scripts/test-plan-account-filter.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

async function main() {
const {
  ALL_TARGET_ACCOUNTS, UNASSIGNED_TARGET_ACCOUNT,
  matchesTargetFilter, effectiveTargetFilter, targetAccountHandle,
} = await import("../src/lib/studio/publishTarget");

type Conn = { id: string; username: string };
const A = { id: "conn-A", username: "cheer" } as Conn;
const B = { id: "conn-B", username: "shop" } as Conn;

console.log("\n=== 1) 筛选归属判定 ===");
test("全部账号 → 一律通过(含未钉定的草稿)", () => {
  assert.equal(matchesTargetFilter({ targetConnectionId: "conn-A" }, ALL_TARGET_ACCOUNTS), true);
  assert.equal(matchesTargetFilter({}, ALL_TARGET_ACCOUNTS), true);
  assert.equal(matchesTargetFilter({}, ""), true, "空筛选值等同不筛选");
});
test("指定账号 → 只留钉定到它的草稿", () => {
  assert.equal(matchesTargetFilter({ targetConnectionId: "conn-A" }, "conn-A"), true);
  assert.equal(matchesTargetFilter({ targetConnectionId: "conn-B" }, "conn-A"), false);
  assert.equal(matchesTargetFilter({}, "conn-A"), false, "未钉定的不属于任何具体账号");
});

console.log("\n=== 2) 未指定目标是独立分桶(老草稿不得消失)===");
test("选『尚未指定账号』时,只有未钉定的草稿出现", () => {
  assert.equal(matchesTargetFilter({}, UNASSIGNED_TARGET_ACCOUNT), true);
  assert.equal(matchesTargetFilter({ targetConnectionId: "conn-A" }, UNASSIGNED_TARGET_ACCOUNT), false);
});
test("空白/脏字符串按未指定处理,与 readStoredTarget 同一口径", () => {
  assert.equal(matchesTargetFilter({ targetConnectionId: "   " }, UNASSIGNED_TARGET_ACCOUNT), true);
  assert.equal(matchesTargetFilter({ targetConnectionId: "   " }, "conn-A"), false);
});
test("三个分桶互斥且完备:任一草稿恰好落入一个具体桶", () => {
  const drafts = [{ targetConnectionId: "conn-A" }, { targetConnectionId: "conn-B" }, {}];
  const buckets = ["conn-A", "conn-B", UNASSIGNED_TARGET_ACCOUNT];
  for (const d of drafts) {
    const hits = buckets.filter(b => matchesTargetFilter(d, b));
    assert.equal(hits.length, 1, `每条草稿必须恰好属于一个桶,实际 ${hits.length}`);
  }
  // 完备性:全部账号视图的条数 = 各桶之和,没有草稿被漏掉
  const total = drafts.filter(d => matchesTargetFilter(d, ALL_TARGET_ACCOUNTS)).length;
  const summed = buckets.reduce((n, b) => n + drafts.filter(d => matchesTargetFilter(d, b)).length, 0);
  assert.equal(summed, total, "分桶之和必须等于全集,否则有草稿从视图里消失");
});

console.log("\n=== 3) 单连接零感知 + 看不见的筛选必须被中和 ===");
test("≤1 个连接时,残留的筛选值被中和为『全部』", () => {
  assert.equal(effectiveTargetFilter("conn-A", [A]), ALL_TARGET_ACCOUNTS,
    "select 不渲染时若筛选仍生效,用户将无法清除它");
  assert.equal(effectiveTargetFilter("conn-A", []), ALL_TARGET_ACCOUNTS);
  assert.equal(effectiveTargetFilter(UNASSIGNED_TARGET_ACCOUNT, [A]), ALL_TARGET_ACCOUNTS);
});
test(">1 个连接时筛选照常生效", () => {
  assert.equal(effectiveTargetFilter("conn-A", [A, B]), "conn-A");
  assert.equal(effectiveTargetFilter("", [A, B]), ALL_TARGET_ACCOUNTS, "空值落到『全部』");
});

console.log("\n=== 4) UI 契约 ===");
const planSrc = read("src/components/plan/WeeklyPlanWorkspace.tsx");
test("筛选面板里有账号 select,且只在多账号时渲染", () => {
  assert.match(planSrc, /data-testid="weekly-plan-filter-account"/, "账号 select 必须真的渲染出来");
  assert.match(planSrc, /\{multiAccount && \(/, "≤1 账号时不得出现多账号控件");
  assert.match(planSrc, /<option value=\{UNASSIGNED_TARGET_ACCOUNT\}>/, "未指定分桶必须可选");
});
test("徽标 Provider 真的挂上了(否则 context 恒 false,徽标永不显示)", () => {
  assert.match(planSrc, /<AccountBadgeContext\.Provider value=\{multiAccount\}>/);
  assert.match(planSrc, /<\/AccountBadgeContext\.Provider>/);
});
test("徽标复用 targetAccountHandle,不另写一套取值", () => {
  assert.match(planSrc, /const handle = targetAccountHandle\(draft\);/);
  assert.equal(targetAccountHandle({ targetAccountLabel: "cheer" }), "@cheer");
  assert.equal(targetAccountHandle({}), "", "无快照时不渲染,而不是显示占位符");
});
test("筛选被真正应用到日历与未排程列表(不是只画了个控件)", () => {
  assert.match(planSrc, /const byAccount = useCallback\(/);
  assert.match(planSrc, /byAccount\(scheduledDraftsInWeek\(/, "周视图必须过滤");
  assert.match(planSrc, /byAccount\(scheduledDraftsInMonth\(/, "月视图必须过滤");
  const railFilters = planSrc.match(/allDrafts\.filter\(d => matchesTargetFilter\(d, accountFilter\)\)/g) ?? [];
  assert.ok(railFilters.length >= 3, `未排程各区块都要过滤,实际 ${railFilters.length} 处`);
});
test("筛选生效时头部有可一键清除的 chip(不能只藏在面板里)", () => {
  assert.match(planSrc, /data-testid="weekly-plan-active-account-filter"/);
  assert.match(planSrc, /onClick=\{\(\) => setAccountFilter\(ALL_TARGET_ACCOUNTS\)\}/);
  assert.match(planSrc, /setCategory\(ALL_CATEGORIES\); setAccountFilter\(ALL_TARGET_ACCOUNTS\);/,
    "Clear 必须同时清掉两个维度");
});

console.log(`\nPlan account filter: ${passed} passed, 0 failed\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
