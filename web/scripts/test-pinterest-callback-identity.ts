/**
 * test-pinterest-callback-identity.ts — decideConnect() three-way decision table.
 *
 * The OAuth callback's identity guard (PRD §9.2/§10): which row does a freshly
 * authorized Pinterest account belong to — create / update / reject. Pure function,
 * no HTTP, no DB. Run: npx tsx scripts/test-pinterest-callback-identity.ts
 */

import assert from "node:assert/strict";
import { decideConnect, type ExistingConnection, type AuthorizedAccount } from "../src/lib/server/pinterest/connectDecision";

let passed = 0;
function test(name: string, fn: () => void) {
  fn(); passed++; console.log(`  OK  ${name}`);
}

const acct = (id: string | null, username: string | null = id ? `@${id}` : null): AuthorizedAccount =>
  ({ id, username, accountType: "BUSINESS" });
const conn = (connectionId: string, accountId: string | null, disconnected = false): ExistingConnection =>
  ({ connectionId, accountId, username: accountId ? `@${accountId}` : null, disconnected });

console.log("\n=== 新建(Add account) ===");
test("无既有连接 + 已识别账号 → create", () => {
  const d = decideConnect({ account: acct("A"), existing: [] });
  assert.equal(d.action, "create");
});
test("有别的账号但身份不同 → create(多账号并存)", () => {
  const d = decideConnect({ account: acct("B"), existing: [conn("c1", "A")] });
  assert.equal(d.action, "create");
});

console.log("\n=== 更新(同账号归一,PRD §9.1 不建第二条) ===");
test("重复 Add 同一账号 → update 原行,不 create", () => {
  const d = decideConnect({ account: acct("A"), existing: [conn("c1", "A")] });
  assert.deepEqual({ action: d.action, id: d.action === "update" ? d.connectionId : "" }, { action: "update", id: "c1" });
});
test("已断开的同账号行 → update 且 revived=true(复活原行)", () => {
  const d = decideConnect({ account: acct("A"), existing: [conn("c1", "A", true)] });
  assert.equal(d.action, "update");
  if (d.action === "update") assert.equal(d.revived, true);
});

console.log("\n=== Reconnect 定向 ===");
test("reconnect 目标 + 同账号 → update 目标行", () => {
  const d = decideConnect({ account: acct("A"), existing: [conn("c1", "A"), conn("c2", "B")], reconnectTargetId: "c1" });
  assert.equal(d.action, "update");
  if (d.action === "update") assert.equal(d.connectionId, "c1");
});
test("reconnect 目标 + 不同账号 → reject(即使那个账号也已连接,也不许改写别的行)", () => {
  const d = decideConnect({ account: acct("B"), existing: [conn("c1", "A"), conn("c2", "B")], reconnectTargetId: "c1" });
  assert.equal(d.action, "reject");
  if (d.action === "reject") {
    assert.equal(d.reason, "account_mismatch");
    assert.equal(d.expectedUsername, "@A");
    assert.equal(d.gotUsername, "@B");
  }
});
test("reconnect 目标从未同步身份(accountId=null)→ update(唯一能获得身份的途径)", () => {
  const d = decideConnect({ account: acct("A"), existing: [conn("c1", null)], reconnectTargetId: "c1" });
  assert.equal(d.action, "update");
});
test("reconnect 目标已被删除 → 落到身份匹配,命中另一行则 update 它", () => {
  const d = decideConnect({ account: acct("B"), existing: [conn("c2", "B")], reconnectTargetId: "c-gone" });
  assert.equal(d.action, "update");
  if (d.action === "update") assert.equal(d.connectionId, "c2");
});
test("reconnect 目标已删除且身份无匹配 → create(当成新增)", () => {
  const d = decideConnect({ account: acct("C"), existing: [conn("c2", "B")], reconnectTargetId: "c-gone" });
  assert.equal(d.action, "create");
});

console.log("\n=== 身份获取失败(account.id=null)的安全行为 ===");
test("null 身份 + reconnect 已识别目标 → reject(拒写,绝不盲写已识别行)", () => {
  const d = decideConnect({ account: acct(null), existing: [conn("c1", "A")], reconnectTargetId: "c1" });
  assert.equal(d.action, "reject");
});
test("null 身份 + 恰好一条未识别行 → update 它(pre-sync 时代的行不分叉)", () => {
  const d = decideConnect({ account: acct(null), existing: [conn("c1", null)] });
  assert.equal(d.action, "update");
});
test("null 身份 + 一条已识别行 → create(绝不吸收进已识别行)", () => {
  const d = decideConnect({ account: acct(null), existing: [conn("c1", "A")] });
  assert.equal(d.action, "create");
});
test("null 身份 + 多行 → create(特例仅限单条未识别行)", () => {
  const d = decideConnect({ account: acct(null), existing: [conn("c1", null), conn("c2", "B")] });
  assert.equal(d.action, "create");
});

console.log(`\nCallback identity decision: ${passed} passed, 0 failed\n`);
