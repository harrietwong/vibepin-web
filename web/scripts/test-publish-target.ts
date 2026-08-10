/**
 * test-publish-target.ts — Phase C 的 C0 四不变量(纯逻辑面)。
 *
 * 1. 目标一经确定即钉死:默认账号/默认板漂移不改变已定目标;
 * 2. adopt-once:无目标时才回落默认连接,且必须产出写回补丁;
 * 3. 切账号必清 Board,不做同名匹配;
 * 4. 单连接零感知(不渲染账号选择器,采用结果=pre-v59 的默认连接)。
 * 外加 PRD §17 重试守卫与 cron 透传。
 * Run: npx tsx scripts/test-publish-target.ts
 */

import assert from "node:assert/strict";
import {
  readStoredTarget, resolvePublishTarget, targetPatchFor, switchTargetPatch,
  shouldShowAccountPicker, selectedTargetConnection, retryBlockReason, targetAccountHandle,
  type TargetableConnection,
} from "../src/lib/studio/publishTarget";
import { payloadToPublishInput } from "../src/app/api/cron/publish-due/publishDueLogic";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

const conn = (id: string, username = `user_${id}`): TargetableConnection => ({ id, username } as TargetableConnection);
const A = conn("conn-A"), B = conn("conn-B");

console.log("\n=== 不变量 1:目标钉死,不随默认漂移 ===");
test("已存目标 + 不同的默认连接 → 仍用已存目标,adopted=false 无补丁", () => {
  const r = resolvePublishTarget({ targetConnectionId: "conn-A" }, B);
  assert.deepEqual(r, { connectionId: "conn-A", adopted: false });
});
test("已存目标即使不在活跃列表(账号已断开)也不被重指向 —— selectedTargetConnection 返回 null 而非别的账号", () => {
  const sel = selectedTargetConnection({ targetConnectionId: "conn-GONE" }, [A, B], A);
  assert.equal(sel, null, "钉定账号消失时绝不静默显示成另一个账号");
});
test("空白/空串目标视为未定(防脏数据)", () => {
  assert.equal(readStoredTarget({ targetConnectionId: "  " }), "");
  assert.equal(readStoredTarget(null), "");
});

console.log("\n=== 不变量 2:adopt-once ===");
test("无目标 + 有默认连接 → 采用默认,adopted=true 且带写回补丁", () => {
  const r = resolvePublishTarget({}, A);
  assert.equal(r.connectionId, "conn-A");
  assert.equal(r.adopted, true);
  assert.deepEqual(r.targetPatch, { targetConnectionId: "conn-A", targetAccountLabel: "user_conn-A" });
});
test("无目标 + 无任何连接 → connectionId null(沿用 not_connected 路径)", () => {
  assert.deepEqual(resolvePublishTarget({}, null), { connectionId: null, adopted: false });
});
test("cron 透传:payload 带 targetConnectionId → DuePublishInput.connectionId;不带 → undefined(pre-v59 行为)", () => {
  const base = { imageUrl: "https://x/i.jpg", boardId: "b1" };
  assert.equal(payloadToPublishInput("u1", { ...base, targetConnectionId: "conn-A" })?.connectionId, "conn-A");
  assert.equal(payloadToPublishInput("u1", base)?.connectionId, undefined);
});

console.log("\n=== 不变量 3:切账号必清 Board ===");
test("switchTargetPatch 写新目标并清空 boardId/boardName", () => {
  assert.deepEqual(switchTargetPatch(B), {
    targetConnectionId: "conn-B", targetAccountLabel: "user_conn-B", boardId: "", boardName: "",
  });
});

console.log("\n=== 不变量 4:单连接零感知 ===");
test("1 个连接不渲染账号选择器;>1 才渲染", () => {
  assert.equal(shouldShowAccountPicker([A]), false);
  assert.equal(shouldShowAccountPicker([A, B]), true);
  assert.equal(shouldShowAccountPicker([]), false);
});
test("单连接的采用结果 = 那唯一连接(等价 pre-v59 pickDefaultConnection)", () => {
  const r = resolvePublishTarget({}, A);
  assert.equal(r.connectionId, "conn-A");
});

console.log("\n=== PRD §17 重试守卫 ===");
test("钉定账号不在活跃列表 → target_disconnected(优先于板检查)", () => {
  assert.equal(retryBlockReason({ draft: { targetConnectionId: "conn-GONE", boardId: "b1" }, active: [A], targetBoardIds: [] }), "target_disconnected");
});
test("板不在目标账号板列表 → board_unavailable;板列表未加载(null)→ 不凭猜测拦截", () => {
  const draft = { targetConnectionId: "conn-A", boardId: "b1" };
  assert.equal(retryBlockReason({ draft, active: [A], targetBoardIds: ["b2"] }), "board_unavailable");
  assert.equal(retryBlockReason({ draft, active: [A], targetBoardIds: null }), null);
  assert.equal(retryBlockReason({ draft, active: [A], targetBoardIds: ["b1"] }), null);
});
test("无钉定目标的重试不拦截(走 adopt-once,同首次发布)", () => {
  assert.equal(retryBlockReason({ draft: {}, active: [], targetBoardIds: null }), null);
});
test("targetAccountHandle:有快照加 @,无快照空串(UI 落兜底文案)", () => {
  assert.equal(targetAccountHandle({ targetAccountLabel: "cheer" }), "@cheer");
  assert.equal(targetAccountHandle({ targetAccountLabel: "@cheer" }), "@cheer");
  assert.equal(targetAccountHandle({}), "");
});

console.log(`\nPublish target: ${passed} passed, 0 failed\n`);
