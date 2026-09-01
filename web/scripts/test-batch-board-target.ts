/**
 * test-batch-board-target.ts — Phase D ④:批量编辑的板选择器按目标连接。
 *
 * 板属于账号。选中的 Pin 目标混合时,任何一份板列表对另一半选中项都是错的
 * ——写进去的 board 那个账号根本发不了。所以此时不给选,并说明原因。
 *
 * 覆盖:
 *  1. sharedTargetForSelection 的三种返回(同一目标 / 全未钉定 / 混合);
 *  2. 未钉定与已钉定混在一起算混合(未钉定的会采用**默认**连接,未必是那一个);
 *  3. hook 按 connectionId 分键缓存,不传时行为与改动前一致;
 *  4. UI 契约:mixed 优先于其它状态、给出解释而非哑禁用、混合时不承诺"应用到全部"。
 * Run: npx tsx scripts/test-batch-board-target.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

async function main() {
const { sharedTargetForSelection } = await import("../src/lib/studio/publishTarget");

console.log("\n=== 1) 选区共同目标的判定 ===");
test("全部钉定到同一账号 → 返回该 connectionId", () => {
  assert.equal(
    sharedTargetForSelection([{ targetConnectionId: "conn-A" }, { targetConnectionId: "conn-A" }]),
    "conn-A",
  );
});
test("全部未钉定 → 返回空串(它们会采用同一个默认连接,可用默认账号的板)", () => {
  assert.equal(sharedTargetForSelection([{}, {}]), "");
  assert.equal(sharedTargetForSelection([{ targetConnectionId: "  " }, {}]), "",
    "空白视为未钉定,与 readStoredTarget 同口径");
});
test("目标不同 → null(混合)", () => {
  assert.equal(
    sharedTargetForSelection([{ targetConnectionId: "conn-A" }, { targetConnectionId: "conn-B" }]),
    null,
  );
});
test("空选区 → 空串(没有冲突可言,退回默认账号的板)", () => {
  assert.equal(sharedTargetForSelection([]), "");
});
test("单个 Pin 永远不算混合", () => {
  assert.equal(sharedTargetForSelection([{ targetConnectionId: "conn-A" }]), "conn-A");
  assert.equal(sharedTargetForSelection([{}]), "");
});

console.log("\n=== 2) 未钉定 + 已钉定 = 混合(关键边界)===");
test("一个钉到 A、一个未钉定 → 混合,不得当成 A", () => {
  assert.equal(
    sharedTargetForSelection([{ targetConnectionId: "conn-A" }, {}]),
    null,
    "未钉定的会采用默认连接,而默认未必是 A —— 当成 A 就会给出错误的板",
  );
  assert.equal(sharedTargetForSelection([null, { targetConnectionId: "conn-A" }]), null);
});
test("草稿缺失(getDraft 返回 null)与未钉定同义", () => {
  assert.equal(sharedTargetForSelection([null, undefined]), "");
});

console.log("\n=== 3) boards hook 按连接分键 ===");
const hookSrc = read("src/hooks/usePinterestBoards.ts");
test("SWR key 含 connectionId,否则两个账号的板会互相覆盖", () => {
  assert.match(hookSrc, /connectionId \? \["pinterest:boards", connectionId\] : "pinterest:boards"/);
});
test("connectionId 透传到 fetch;不传时保持原有默认连接行为", () => {
  assert.match(hookSrc, /fetchPinterestBoards\(bookmark, undefined, connectionId\)/);
  assert.match(hookSrc, /export function usePinterestBoards\(connectionId\?: string\)/,
    "参数必须可选,单账号调用方零改动");
});
test("StudioBoard 仍用无参调用(未被本轮改动波及)", () => {
  assert.match(read("src/components/studio/StudioBoard.tsx"), /usePinterestBoards\(\)/);
});

console.log("\n=== 4) UI 契约 ===");
const drawerSrc = read("src/components/studio/BatchEditDrawer.tsx");
test("板列表按选区共同目标取,来源与发布调用同一处(pinDraftStore 的钉定目标)", () => {
  assert.match(drawerSrc, /sharedTargetForSelection\(pins\.map\(p => pinDraftStore\.getDraft\(p\.pinId\)\)\)/);
  assert.match(drawerSrc, /usePinterestBoards\(sharedTarget \|\| undefined\)/);
});
test("mixed 优先于 loading/ready 等其它状态", () => {
  const idx = drawerSrc.indexOf('mixedTargets ? "mixed"');
  const loadingIdx = drawerSrc.indexOf('boardsLoading ? "loading"');
  assert.ok(idx > 0 && idx < loadingIdx, "混合必须最先判定,否则会先渲染出可选的板");
});
test("混合时给出解释文案,而不是一个无说明的禁用控件", () => {
  assert.match(drawerSrc, /data-testid="board-mixed-accounts"/);
  assert.match(read("src/lib/i18n/messages/en/studioModals.ts"), /"studioModals\.board\.mixedAccounts"/);
});
test("混合时不再承诺『应用到全部』", () => {
  assert.match(drawerSrc, /\{!mixedTargets && \(/);
});
test("混合文案 18 语言齐全", () => {
  const locales = ["ar","de","es","fr","hi","id","it","ja","ko","nl","pl","pt","ru","th","tr","vi","zh-CN","zh-TW"];
  for (const l of locales) {
    assert.ok(
      read(`src/lib/i18n/messages/${l}.ts`).includes('"studioModals.board.mixedAccounts"'),
      `${l} 缺 studioModals.board.mixedAccounts`,
    );
  }
});

console.log(`\nBatch board target: ${passed} passed, 0 failed\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
