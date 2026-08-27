/**
 * test-settings-account-actions.ts — Settings → Social accounts 的逐账号动作。
 *
 * 这一轮改的是"一个动作到底作用在谁身上"。要守住的四件事:
 *
 *  1. 状态 → 动作是一张表,不是组件里的一串布尔。旧面板用 healthy/degraded 另算了
 *     一遍,于是同一个账号可以一边挂着绿色 Connected、一边显示 Reconnect。现在
 *     chip 和按钮都出自同一个 accountUiState,这里直接断言那张表。
 *
 *  2. 面板里不许再有"无参断开"。旧的平台级 Disconnect 调 /api/pinterest/disconnect
 *     不带 connectionId —— 那是"断掉该用户全部连接"。单账号时看着正常,两个账号时
 *     一次点击签退两个,而且没有任何提示。
 *
 *  3. Reconnect 不许再钉死在 accounts[0]。第二个账号进入 needs_reconnect 时,
 *     UI 上根本没有能修它的入口(点了会去修第一个)。错配横幅的重试同理。
 *
 *  4. 多目的地排程只能取消被移除的那一条腿。一个同时发 Pinterest 和 Facebook 的
 *     Content,移除 Facebook 账号并选"取消排程"后,Pinterest 那条必须还在;
 *     反过来,destinations 清空却留着 scheduled_at 更糟 —— resolveScheduledDestinations
 *     会从 targetConnectionId 回退推导出 Pinterest 意图,cron 照发。
 *
 * Run: npx tsx scripts/test-settings-account-actions.ts
 */

// 这些模块经由 supabase 在 import 期建客户端。占位 env 让 import 不抛;下面没有
// 任何断言碰真实数据库(纯函数、源码文本,或本文件里的假 db)。
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  OK  ${name}`); }
async function testAsync(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`  OK  ${name}`); }

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ── 记录调用链的假 Supabase(与 test-per-account-disconnect 同款)────────────
type Call = { method: string; args: unknown[] };
interface FakeResult { data?: unknown; error?: { code?: string; message?: string } | null }

function makeFakeDb(results: FakeResult[]) {
  const chains: Call[][] = [];
  let resultIndex = 0;
  const db = {
    from(table: string) {
      const calls: Call[] = [{ method: "from", args: [table] }];
      chains.push(calls);
      const settle = () => {
        const r = results[resultIndex++] ?? {};
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
      };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "update", "eq", "is", "not", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return builder; };
      }
      builder.then = (onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) =>
        settle().then(onfulfilled, onrejected);
      return builder;
    },
  };
  return { db, chains };
}

function eqPairs(calls: Call[]): Array<[string, unknown]> {
  return calls.filter(c => c.method === "eq").map(c => [c.args[0] as string, c.args[1]]);
}

async function main() {
const {
  accountRowActions,
  accountRowState,
  ACCOUNT_ROW_ACTIONS,
  ACCOUNT_ROW_ACTION_LABEL_KEY,
  isSecondaryAccountAction,
} = await import("../src/lib/social/accountActions");
const {
  payloadTargetsSocialConnection,
  payloadAfterDestinationRemoved,
  usableDestinations,
  countScheduledForSocialConnection,
  cancelScheduledForSocialConnection,
} = await import("../src/lib/server/social/scheduledForSocialConnection");
const { en } = await import("../src/lib/i18n/messages");

const panelSrc = read("src/components/social/SocialAccountsPanel.tsx");
const clientSrc = read("src/lib/social/socialClient.ts");

console.log("\n=== 1) 状态 → 动作:一张表,四个状态,每行都能被移除 ===");

test("connected 只给 Disconnect;另外三态一律给 Reconnect —— 且都带 Remove", () => {
  assert.deepEqual([...accountRowActions("connected")], ["disconnect", "remove"]);
  assert.deepEqual([...accountRowActions("needs_attention")], ["reconnect", "remove"]);
  assert.deepEqual([...accountRowActions("needs_reconnect")], ["reconnect", "remove"]);
  assert.deepEqual([...accountRowActions("disconnected")], ["reconnect", "remove"]);
});

test("四个状态一个不漏,且没有第五个", () => {
  assert.deepEqual(
    Object.keys(ACCOUNT_ROW_ACTIONS).sort(),
    ["connected", "disconnected", "needs_attention", "needs_reconnect"],
    "动作表必须与 accountUiState 的四态一一对应",
  );
});

test("每一行都能被移除:Remove 是唯一在四个状态里都出现的动作", () => {
  const states = Object.keys(ACCOUNT_ROW_ACTIONS) as Array<keyof typeof ACCOUNT_ROW_ACTIONS>;
  for (const s of states) {
    assert.ok(accountRowActions(s).includes("remove"), `${s} 必须能被移除(否则占着套餐名额无法释放)`);
  }
  // Remove 不可逆,永远是次要按钮:健康账号上用户几乎总是想要 Disconnect。
  assert.equal(isSecondaryAccountAction("remove"), true);
  assert.equal(isSecondaryAccountAction("disconnect"), false);
  assert.equal(isSecondaryAccountAction("reconnect"), false);
});

test("needs_attention 给的是 Reconnect 而不是 Disconnect", () => {
  // 刻意的取舍:needs_attention 意味着"可能影响发布",能修它的是重新授权。
  // 在那里摆 Disconnect 等于把破坏性操作当成修复手段推给用户。
  assert.ok(!accountRowActions("needs_attention").includes("disconnect"));
});

test("三个动作的文案键都真实存在于英文目录", () => {
  for (const [action, key] of Object.entries(ACCOUNT_ROW_ACTION_LABEL_KEY)) {
    assert.ok(key in en, `${action} 的文案键 ${key} 不在英文目录里`);
    assert.ok(String((en as Record<string, string>)[key]).trim(), `${key} 是空串`);
  }
});

console.log("\n=== 2) 行状态只看自己那一行 ===");

test("scope 完整性只对 Pinterest 生效,别家不会被误判成 needs_reconnect", () => {
  const missingScope = { connectionStatus: "connected" as const, scopes: ["boards:read"] };
  assert.equal(accountRowState(missingScope, "pinterest"), "needs_reconnect",
    "Pinterest 缺必需 scope 只能靠重新授权修复");
  assert.equal(accountRowState(missingScope, "instagram"), "connected",
    "别家平台没有这套 scope 口径,不能拿 Pinterest 的清单去判它");
});

test("每一行独立取状态:第一行健康不会掩盖第二行需要重连", () => {
  const healthy = { connectionStatus: "connected" as const, scopes: ["boards:read", "pins:read", "pins:write"] };
  const broken = { connectionStatus: "expired" as const, scopes: [] };
  assert.equal(accountRowState(healthy, "pinterest"), "connected");
  assert.equal(accountRowState(broken, "pinterest"), "needs_reconnect");
});

test("not_connected(软断开后的 FB/IG 行)读作 disconnected,因此仍给 Reconnect", () => {
  assert.equal(accountRowState({ connectionStatus: "not_connected", scopes: [] }, "facebook"), "disconnected");
  assert.ok(accountRowActions("disconnected").includes("reconnect"),
    "软断开必须是可逆的 —— 否则它和 Remove 没有区别");
});

console.log("\n=== 3) 面板契约:动作作用在行上,不在平台上 ===");

test("面板里不存在任何无参的 disconnectPinterest 调用", () => {
  // 这是本轮最要命的一条:无参 = 断掉该用户在该平台的全部连接。
  assert.doesNotMatch(panelSrc, /disconnectPinterest\(\s*\)/);
  assert.doesNotMatch(panelSrc, /DisconnectButton/, "平台级 Disconnect 按钮必须整体移除");
  assert.doesNotMatch(panelSrc, /social-disconnect-\$\{summary\.provider\}/,
    "平台级 Disconnect 的 testid 不该再存在");
});

test("Reconnect 绑定的是该行的 connection id,不是 accounts[0]", () => {
  assert.doesNotMatch(panelSrc, /onReconnect\(summary\.accounts\[0\]\?\.id \?\? null\)/,
    "旧的硬绑定必须消失");
  assert.match(panelSrc, /async function handleReconnectAccount\(provider: SocialProvider, account: SocialConnection\)/);
  assert.match(panelSrc, /await handleConnect\(provider, account\.id\);/,
    "Reconnect 必须把这一行的 id 作为重连目标传下去");
  // 错配横幅的重试同样不能回落到第一个账号 —— 否则修第二个账号的人会被送去修第一个。
  assert.match(panelSrc, /const target = reconnectTargetId \?\? pinterest\?\.accounts\[0\]\?\.id \?\? null;/);
  assert.match(panelSrc, /setReconnectTargetId\(account\.id\)/);
});

test("账号行对每个有账号的平台都渲染(单账号也有一行)", () => {
  const rows = panelSrc.split("function AccountRows")[1] ?? "";
  assert.match(rows, /if \(summary\.accounts\.length === 0\) return null;/,
    "只有空平台槽位才不渲染行");
  assert.doesNotMatch(rows, /summary\.accounts\.length < 2/, "旧的 2+ 门槛必须移除");
  // 行的动作必须来自共享的那张表,不能在 JSX 里另算一遍。
  assert.match(rows, /accountRowActions\(state\)\.map\(action =>/);
  assert.match(rows, /const state = accountRowState\(account, summary\.provider\);/);
});

test("平台层只剩 Add another,不再有任何针对既有账号的动作", () => {
  assert.match(panelSrc, /data-testid=\{`social-add-account-\$\{summary\.provider\}`\}/,
    "Add another 必须留在平台层");
  // N>1 时不显示平台徽章的规则原样保留。
  assert.match(panelSrc, /\{!hasSeveralAccounts && <Chip chip=\{chip\} \/>\}/);
  assert.match(panelSrc, /const hasSeveralAccounts = summary\.accountCount > 1;/);
});

test("FB/IG 回调的 account_limit 走与 limit_reached 完全相同的横幅", () => {
  assert.match(panelSrc, /function isAccountLimitFlag\(flag: string\): boolean \{/);
  assert.match(panelSrc, /return flag === "limit_reached" \|\| flag === "account_limit";/);
  // 三个 OAuth 返回处理器都要认它:account_limit 只可能出现在 ?facebook= / ?instagram=。
  const hits = panelSrc.match(/isAccountLimitFlag\(flag\)/g) ?? [];
  assert.equal(hits.length, 3, "pinterest / facebook / instagram 三个 effect 都必须处理");
  // 横幅本体归别的工作流所有,这一轮只加别名。
  assert.match(panelSrc, /setAccountLimitReached\(true\);/);
  assert.match(panelSrc, /"socialPanel\.limit\.title"/);
});

test("客户端:软断开永远不带 cancelScheduled", () => {
  // 清掉商家的排程是"移除账号"的后果,绝不能是"临时关掉它"的后果。
  assert.match(clientSrc, /\.\.\.\(mode === "remove" && opts\?\.cancelScheduled \? \{ cancelScheduled: true \} : \{\}\)/);
  assert.match(clientSrc, /const mode = opts\?\.mode \?\? "disconnect";/,
    "客户端默认也必须是软断开");
});

console.log("\n=== 4) 通用排程口径:只取消被移除的那条腿 ===");

test("payloadTargetsSocialConnection:认 scheduledDestinations[] 里的 socialConnectionId", () => {
  const payload = {
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin-1", capturedAt: "x" },
      { provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" },
    ],
  };
  assert.equal(payloadTargetsSocialConnection(payload, "fb-1"), true);
  assert.equal(payloadTargetsSocialConnection(payload, "pin-1"), true);
  assert.equal(payloadTargetsSocialConnection(payload, "fb-2"), false);
  assert.equal(payloadTargetsSocialConnection(payload, ""), false);
  assert.equal(payloadTargetsSocialConnection(null, "fb-1"), false);
  // 旧的 Pinterest 单目标字段不属于这个口径 —— 那条路仍由 Pinterest 自己的模块负责。
  assert.equal(payloadTargetsSocialConnection({ targetConnectionId: "pin-1" }, "pin-1"), false);
});

test("残缺条目被忽略:没有 socialConnectionId 或 provider 不认识的都不算数", () => {
  const payload = {
    scheduledDestinations: [
      { provider: "facebook", socialConnectionId: "  ", capturedAt: "x" },
      { provider: "not-a-platform", socialConnectionId: "fb-1", capturedAt: "x" },
      "garbage",
    ],
  };
  assert.equal(usableDestinations(payload).length, 0);
  assert.equal(payloadTargetsSocialConnection(payload, "fb-1"), false);
  assert.equal(usableDestinations({ scheduledDestinations: "not-an-array" }).length, 0);
});

test("移除一条腿:其余目的地保留,排程字段不动", () => {
  const now = "2026-08-27T10:00:00.000Z";
  const { payload, remaining } = payloadAfterDestinationRemoved({
    updatedAt: "2026-08-01T00:00:00.000Z",
    scheduledDate: "2026-08-30",
    scheduledTime: "10:30",
    plannedAt: "2026-08-30T10:30",
    targetConnectionId: "pin-1",
    scheduledDestinations: [
      { provider: "pinterest", socialConnectionId: "pin-1", capturedAt: "x" },
      { provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" },
    ],
    title: "keep me",
  }, "fb-1", now);

  assert.equal(remaining, 1);
  assert.deepEqual(
    (payload.scheduledDestinations as Array<{ socialConnectionId: string }>).map(d => d.socialConnectionId),
    ["pin-1"],
    "Pinterest 那条腿必须原样保留",
  );
  assert.equal(payload.scheduledDate, "2026-08-30", "还有目的地时不得清掉排程时间");
  assert.equal(payload.updatedAt, now, "必须 bump,否则客户端 LWW 会把被移除的目的地推回来");
  assert.equal(payload.title, "keep me");
});

test("移除最后一条腿:三个排程字段一并清空", () => {
  const now = "2026-08-27T10:00:00.000Z";
  const { payload, remaining } = payloadAfterDestinationRemoved({
    scheduledDate: "2026-08-30",
    scheduledTime: "10:30",
    plannedAt: "2026-08-30T10:30",
    scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }],
  }, "fb-1", now);

  assert.equal(remaining, 0);
  assert.deepEqual(payload.scheduledDestinations, []);
  assert.equal(payload.scheduledDate, "");
  assert.equal(payload.scheduledTime, "");
  assert.equal(payload.plannedAt, "");
});

await testAsync("count 的过滤链:user + scheduled_at 非空 + 未删除未归档(账号匹配在 JS 里)", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-2", capturedAt: "x" }] } },
    { vibepin_user_id: "u1", draft_id: "d3", payload: { targetConnectionId: "fb-1" } },
  ];
  const { db, chains } = makeFakeDb([{ data: rows }]);
  assert.equal(await countScheduledForSocialConnection(db, "u1", "fb-1"), 1,
    "只数真正把这个账号列为目的地的行");

  const calls = chains[0];
  assert.deepEqual(calls[0], { method: "from", args: ["pin_drafts"] });
  assert.ok(eqPairs(calls).some(([c, v]) => c === "vibepin_user_id" && v === "u1"), "必须按用户过滤");
  assert.ok(
    calls.some(c => c.method === "not" && c.args[0] === "scheduled_at" && c.args[1] === "is" && c.args[2] === null),
    "只看真正排了期的行(与 cron 的 due-scan 口径一致)",
  );
  for (const col of ["deleted_at", "archived_at"]) {
    assert.ok(calls.some(c => c.method === "is" && c.args[0] === col && c.args[1] === null), `必须排除 ${col} 非空的行`);
  }
});

await testAsync("空 id 不查库;缺表降级为 0 而不是拦住用户", async () => {
  const empty = makeFakeDb([]);
  assert.equal(await countScheduledForSocialConnection(empty.db, "u1", "  "), 0);
  assert.equal(empty.chains.length, 0, "空 id 不应发出任何查询");

  const missing = makeFakeDb([{ error: { code: "PGRST205", message: "Could not find the table" } }]);
  assert.equal(await countScheduledForSocialConnection(missing.db, "u1", "fb-1"), 0);
});

await testAsync("cancel:多目的地行保住排程,单目的地行才 scheduled_at 置空", async () => {
  const rows = [
    {
      vibepin_user_id: "u1", draft_id: "multi",
      payload: { scheduledDestinations: [
        { provider: "pinterest", socialConnectionId: "pin-1", capturedAt: "x" },
        { provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" },
      ] },
    },
    {
      vibepin_user_id: "u1", draft_id: "solo",
      payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] },
    },
    {
      vibepin_user_id: "u1", draft_id: "other",
      payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-2", capturedAt: "x" }] },
    },
  ];
  const { db, chains } = makeFakeDb([{ data: rows }, { data: null }, { data: null }]);
  const now = "2026-08-27T10:00:00.000Z";
  const cleared = await cancelScheduledForSocialConnection(db, "u1", "fb-1", now);
  assert.equal(cleared, 2, "只改动真正涉及该账号的两行");

  const updates = chains.slice(1).map(calls => {
    const patch = (calls.find(c => c.method === "update")!.args[0]) as Record<string, unknown>;
    const draftId = eqPairs(calls).find(([c]) => c === "draft_id")?.[1];
    return { draftId, patch, calls };
  });
  assert.deepEqual(updates.map(u => u.draftId), ["multi", "solo"], "第三行与该账号无关,不得被写");

  const multi = updates[0].patch;
  assert.ok(!("scheduled_at" in multi),
    "还有 Pinterest 那条腿,绝不能清 scheduled_at —— 那会静默取消用户仍然想要的发布");
  const multiPayload = multi.payload as Record<string, unknown>;
  assert.deepEqual(
    (multiPayload.scheduledDestinations as Array<{ socialConnectionId: string }>).map(d => d.socialConnectionId),
    ["pin-1"],
  );

  const solo = updates[1].patch;
  assert.equal(solo.scheduled_at, null, "最后一条腿被移除后必须退出 cron 的扫描");
  assert.equal(solo.publish_claimed_at, null, "顺带释放锁,避免半持有的行");
  assert.equal(solo.updated_at, now);
  const soloPayload = solo.payload as Record<string, unknown>;
  assert.deepEqual(soloPayload.scheduledDestinations, []);
  assert.equal(soloPayload.updatedAt, now);

  for (const u of updates) {
    assert.ok(eqPairs(u.calls).some(([c, v]) => c === "vibepin_user_id" && v === "u1"), "写回必须限定用户");
  }
});

await testAsync("destinations 清空时必须同时清 scheduled_at(否则 legacy 回退会让 cron 照发)", async () => {
  // 这是最隐蔽的一条:resolveScheduledDestinations 在 destinations 为空时会从
  // targetConnectionId 回退推导出一个 Pinterest 意图。若我们留着 scheduled_at,
  // 被"取消"的排程会以 Pinterest 的身份照常发出去。
  const resolveSrc = read("src/lib/social/scheduledDestinations.ts");
  assert.match(resolveSrc, /const derived = pinterestDestinationFrom\(draft, new Date\(\)\.toISOString\(\)\);/,
    "前提校验:空 destinations 确实会回退推导(不是推断,是查过的)");

  const rows = [{
    vibepin_user_id: "u1", draft_id: "legacy",
    payload: {
      targetConnectionId: "pin-1",
      scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }],
    },
  }];
  const { db, chains } = makeFakeDb([{ data: rows }, { data: null }]);
  await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  const patch = (chains[1].find(c => c.method === "update")!.args[0]) as Record<string, unknown>;
  assert.equal(patch.scheduled_at, null,
    "destinations 清空却留着 scheduled_at,等于把取消变成一次静默的 Pinterest 发布");
});

await testAsync("单行写回失败只跳过该行", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
  ];
  const { db } = makeFakeDb([{ data: rows }, { error: { code: "XX000", message: "boom" } }, { data: null }]);
  assert.equal(await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z"), 1);
});

console.log(`\n${passed} 项断言全部通过。`);
}

main().catch(err => { console.error(err); process.exit(1); });
