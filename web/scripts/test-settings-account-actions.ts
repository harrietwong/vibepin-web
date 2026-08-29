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
 *  5. 断开不等于消失。Disconnect 在每个平台都保留账号行(列为 Disconnected,
 *     就地 Reconnect),而且它继续占着套餐额度;Remove 才是硬删,也是唯一能把
 *     slot 拿回来的动作(PRD 0805 §11)。之前 Pinterest 是个例外:断开后行从列表里
 *     消失,额度却还按 token 算 —— 用户看不见它,也就无法把它移除。
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
const { summarizeConnectionList } = await import("../src/lib/social/server/socialConnectionStore");
const { en } = await import("../src/lib/i18n/messages");

/** A minimal Pinterest connection row in the client-safe shape the listing returns. */
function conn(id: string, status: "connected" | "not_connected" | "expired") {
  return {
    id, provider: "pinterest" as const, workspaceId: null,
    providerAccountId: "pid-" + id, providerAccountName: "Studio " + id,
    providerAccountUsername: id, providerAccountAvatarUrl: null,
    connectionStatus: status, authProvider: "official" as const,
    externalConnectionId: null,
    // The full publish floor, boards:write included — without it the row is
    // legitimately needs_reconnect and stops being the "healthy" fixture.
    scopes: ["boards:read", "boards:write", "pins:read", "pins:write"],
    tokenExpiresAt: null, metadata: null, createdAt: null, updatedAt: null,
  };
}

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
  const healthy = {
    connectionStatus: "connected" as const,
    scopes: ["boards:read", "boards:write", "pins:read", "pins:write"],
  };
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
  // 平台名从横幅自己的 provider 来:Facebook/Instagram 也会触发这条横幅了,
  // 写死 pinterest 会让在 FB 上错配的人被送去重连 Pinterest(Codex #5)。
  // 这条断言原来盯着的是 `reconnectTargetId ?? platform?.accounts[0]?.id ?? null`,
  // 也就是它自己标题里说"不能有"的那个回落 —— 只是当时还留着当兜底。Codex #3 把它
  // 彻底删了:目标要么在当前连接列表里被核验到,要么按钮直接禁用。
  assert.match(panelSrc, /const platform = summaries\?\.find\(s => s\.provider === accountMismatch\.provider\);/);
  assert.match(
    panelSrc,
    /return platform\?\.accounts\.some\(a => a\.id === reconnectTargetId\) \? reconnectTargetId : null;/,
    "目标必须在当前连接列表里核验过才算数",
  );
  assert.match(panelSrc, /canSignInToOriginal=\{!!resolvedReconnectTarget\}/,
    "核验不到就不能让人点");
  assert.match(panelSrc, /if \(!resolvedReconnectTarget\) return;/,
    "没有核验过的目标时,重试必须什么都不做,而不是猜一个");
  // 变量名换成了 resolvedReconnectTarget(核验过的那一行);语义不变:重连同一行。
  assert.match(panelSrc, /void handleConnect\(accountMismatch\.provider, resolvedReconnectTarget\);/);
  assert.match(panelSrc, /setReconnectTargetId\(account\.id\)/);
});

test("有排程时的对话框只给两条路:取消并移除、保留账号(PRD 0805 §11)", () => {
  // 第三个选项("保留排程,但把账号删了")已经取消。产品上它违反 §11;
  // 工程上它现在必然撞服务端的 409 schedules_exist,于是只会弹回同一个对话框。
  assert.doesNotMatch(panelSrc, /data-testid="pinterest-remove-keep"/,
    "旧的「保留排程」按钮必须整个移除,不是禁用");
  assert.doesNotMatch(panelSrc, /onKeep/, "对应的回调也不该留着");
  assert.match(panelSrc, /data-testid="pinterest-remove-cancel-schedules"/, "取消并移除还在");
  assert.match(panelSrc, /data-testid="pinterest-remove-dismiss"/, "保留账号 = 关掉对话框");

  // 唯一会真的删的调用必须带 true。
  assert.match(panelSrc, /removeAccount\(account\.provider, account, true\)/);
  assert.doesNotMatch(panelSrc, /removeAccount\(account\.provider, account, false\)/,
    "对话框里不得再有 cancelScheduled:false 的移除");

  // 文案:正文和主按钮都要说清"必须先取消",且主按钮带数目。
  const en = read("src/lib/i18n/messages/en/socialPanel.ts");
  for (const k of ["bodySuffixV2", "cancelPrefix", "cancelSuffix", "keepAccount"]) {
    assert.ok(en.includes(`"socialPanel.removeDialog.${k}"`), `en 目录缺 ${k}`);
  }
  assert.match(panelSrc, /socialPanel\.removeDialog\.bodySuffixV2/,
    "正文必须用新文案 —— 旧的还在承诺那个已删掉的选项");
  assert.match(panelSrc, /socialPanel\.removeDialog\.keepAccount/);
});

test("移除被拒时面板说出服务端那句话，并把行放回去（Codex #6）", () => {
  // 服务端 409 带的是一句可执行的话（"N 条排程没能取消，账号未移除"）。
  // 面板原来 catch 掉一切、只弹一句通用失败，于是商家看到"移除失败"、行又还在，
  // 无从判断到底发生了什么、该不该重试。
  const removeAt = panelSrc.indexOf("async function removeAccount(");
  assert.ok(removeAt > 0);
  // 窗口要盖住整个 catch:它现在按 code 分三支(schedules_exist / schedule_check_failed
  // / 其余),通用兜底那句被推到了 3000 字符开外。
  const body = panelSrc.slice(removeAt, removeAt + 4200);
  // 服务端的话优先,通用文案只作兜底。错误现在是带 code 的类型化对象
  // (schedules_exist 要重开对话框、schedule_check_failed 要单独的文案),
  // 所以取的是 err.message 而不是 (e as Error).message —— 意图不变。
  assert.ok(
    body.includes('toast.error(err.message || tr("socialPanel.toast.accountRemoveFailed"))'),
    "必须优先弹服务端的 userMessage，通用文案只作兜底",
  );
  assert.ok(!body.includes("} catch {"), "不能再把错误整个丢掉");
  // schedules_exist 不是"失败",是服务端把 Keep/Cancel 的决定交回来了(Codex #1)。
  // 面板必须用服务端那个计数重开同一个对话框 —— 那是删除当刻唯一为真的数字。
  assert.ok(
    body.includes('if (err.code === "schedules_exist")') && body.includes("setPendingRemoval({"),
    "schedules_exist 必须重开 Keep/Cancel 对话框,而不是弹一句失败",
  );
  assert.ok(
    body.includes("typeof err.scheduledCount === \"number\" ? err.scheduledCount : 0"),
    "对话框显示的必须是服务端的计数,不是面板自己那个预估",
  );
  // 读不到排程 ≠ 没有排程:服务端什么都没删,面板要说清楚并把行留着。
  assert.ok(
    body.includes('err.code === "schedule_check_failed"')
      && body.includes('tr("socialPanel.toast.scheduleCheckFailed")'),
    "schedule_check_failed 要有自己的文案,不能混进通用失败",
  );
  // 行本身由 finally 里的 load() 从服务端重新取回 —— 乐观删除因此被撤销。
  assert.ok(body.includes("await load();"), "失败后必须重新拉一次服务端真相，把行放回去");
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
  // 写回现在是 compare-and-set:update 以 .select("draft_id") 结尾,返回的行数就是
  // "有没有命中"。空数组=行在读之后被人改过(CAS 未命中),不是成功 —— 所以每次
  // 写回的假结果必须回一行。
  const { db, chains } = makeFakeDb([
    { data: rows }, { data: [{ draft_id: "multi" }] }, { data: [{ draft_id: "solo" }] },
  ]);
  const now = "2026-08-27T10:00:00.000Z";
  const outcome = await cancelScheduledForSocialConnection(db, "u1", "fb-1", now);
  assert.deepEqual(outcome, { cleared: 2, failed: 0, readFailed: false },
    "只改动真正涉及该账号的两行,且全部成功");

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
  // 时间戳取自写入那一刻(见 casUpdate.ts):循环前取的戳会比循环期间的编辑还旧,
  // 客户端 LWW 会据此把那次编辑连同排程一起推回来。
  const soloStamp = solo.updated_at as string;
  assert.ok(typeof soloStamp === "string" && !Number.isNaN(Date.parse(soloStamp)));
  const soloPayload = solo.payload as Record<string, unknown>;
  assert.deepEqual(soloPayload.scheduledDestinations, []);
  assert.equal(soloPayload.updatedAt, soloStamp,
    "列与 payload.updatedAt 必须同一个值,否则 LWW 两边打架");

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
  // CAS 写回以 .select("draft_id") 结尾,空数组=未命中(要重试),所以假结果回一行。
  const { db, chains } = makeFakeDb([{ data: rows }, { data: [{ draft_id: "legacy" }] }]);
  await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  const patch = (chains[1].find(c => c.method === "update")!.args[0]) as Record<string, unknown>;
  assert.equal(patch.scheduled_at, null,
    "destinations 清空却留着 scheduled_at,等于把取消变成一次静默的 Pinterest 发布");
});

await testAsync("单行写回失败只跳过该行,但必须报告 failed(Codex #6)", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
  ];
  const { db } = makeFakeDb([
    { data: rows }, { error: { code: "XX000", message: "boom" } }, { data: [{ draft_id: "d2" }] },
  ]);
  const outcome = await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  assert.equal(outcome.cleared, 1, "一行失败不应吞掉另一行的成功");
  // 剩下那一行仍然指向即将被删除的账号。只回 cleared 的话,这次调用与
  // "只有一行需要清且清成功了"完全无法区分。
  assert.equal(outcome.failed, 1, "失败的行必须出现在返回值里");
  assert.equal(outcome.readFailed, false);
});

await testAsync("读取失败 ≠ 没有排程(Codex #6)", async () => {
  const { db } = makeFakeDb([{ error: { code: "XX000", message: "connection reset" } }]);
  const outcome = await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  assert.deepEqual(outcome, { cleared: 0, failed: 0, readFailed: true });
});

await testAsync("缺表/缺列仍然是'确实没有排程',不是失败", async () => {
  const { db } = makeFakeDb([{ error: { code: "PGRST205", message: "Could not find the table" } }]);
  const outcome = await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  assert.deepEqual(outcome, { cleared: 0, failed: 0, readFailed: false },
    "可选迁移没跑不该把商家卡在无法移除账号上");
});

await testAsync("全部清干净时 failed=0,路由才被允许删除", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { scheduledDestinations: [{ provider: "facebook", socialConnectionId: "fb-1", capturedAt: "x" }] } },
  ];
  const { db } = makeFakeDb([{ data: rows }, { data: [{ draft_id: "d1" }] }]);
  const outcome = await cancelScheduledForSocialConnection(db, "u1", "fb-1", "2026-08-27T10:00:00.000Z");
  assert.deepEqual(outcome, { cleared: 1, failed: 0, readFailed: false });
});

console.log("\n=== 5) 断开的行留在列表里,并且继续占额度(PRD 0805 §11) ===");

test("Settings 列表与发布侧读的是两个入口,只有前者包含已断开的行", () => {
  const store = read("src/lib/social/server/socialConnectionStore.ts");
  // 默认仍是活跃只读:发布路径(publish/social、destinations/validate、
  // findConnection 的 legacy 合成 id)都走它,不能因为改了一个默认值就静默看到死账号。
  assert.match(store, /export async function listConnectionsForSettings\(uid: string\): Promise<SocialConnection\[\]>/,
    "Settings 列表必须是单独的入口,不是被拓宽的 listConnections");
  assert.match(store, /includeDisconnected/, "包含与否必须是显式开关");
  const listingRoute = read("src/app/api/social/connections/route.ts");
  assert.match(listingRoute, /listConnectionsForSettings\(uid\)/, "只有 Settings 列表路由用它");
  for (const p of [
    "src/app/api/publish/social/route.ts",
    "src/app/api/publish/destinations/validate/route.ts",
  ]) {
    assert.ok(!read(p).includes("listConnectionsForSettings"),
      p + " 是发布侧,不得读含已断开行的列表");
  }
});

test("已断开的 Pinterest 行带着身份返回(不是掩码占位符),但永不带 token", () => {
  const store = read("src/lib/social/server/socialConnectionStore.ts");
  // toSafeStatus 对已断开的行返回 account: null —— 那是发布侧投影。
  // 列表要回答的是"这是谁",所以走 toAccountIdentity。
  assert.match(store, /const account = toAccountIdentity\(row\);/,
    "否则每一行都会渲染成 Pinterest account ••••xxxx");
  const pinterestStore = read("src/lib/server/pinterest/connectionStore.ts");
  assert.match(pinterestStore, /export function toAccountIdentity\(row: PinterestConnectionRow\): ConnectionAccount/);
  // 身份投影只能拿到这几个字段;任何 token 列都不得出现在它里面。
  const idx = pinterestStore.indexOf("export function toAccountIdentity(");
  const body = pinterestStore.slice(idx, pinterestStore.indexOf("}", pinterestStore.indexOf("return {", idx)));
  assert.ok(!/token/i.test(body), "身份投影里不得出现任何 token 字段");
});

test("已断开的行读作 not_connected → disconnected → Reconnect · Remove", () => {
  // Pinterest 的已断开行与 FB/IG 的软断开行报同一个状态,因此三家在 Settings 里
  // 长得一模一样 —— 这正是本次要消除的不对称。
  const state = accountRowState({ connectionStatus: "not_connected", scopes: [] }, "pinterest");
  assert.equal(state, "disconnected");
  assert.deepEqual([...accountRowActions(state)], ["reconnect", "remove"]);
});

test("平台头部的 N 个账号把已断开的也数进去,但 connected 仍然看得清", () => {
  const summaries = summarizeConnectionList([
    conn("live", "connected"),
    conn("dead", "not_connected"),
  ]);
  const pinterest = summaries.find(s => s.provider === "pinterest");
  assert.equal(pinterest?.accountCount, 2, "占着额度的行必须看得见,否则用户无法把 slot 拿回来");
  assert.equal(pinterest?.connected, true, "connected 只看现在能不能发");
  const allDead = summarizeConnectionList([conn("dead", "not_connected")])
    .find(s => s.provider === "pinterest");
  assert.equal(allDead?.accountCount, 1);
  assert.equal(allDead?.connected, false, "全部断开时平台不得声称已连接");
});

test("Pinterest Remove 是硬删:走 mode=remove,且缺 connectionId 直接 400", () => {
  const route = read("src/app/api/pinterest/disconnect/route.ts");
  assert.match(route, /url\.searchParams\.get\("mode"\) === "remove"/,
    "只有显式的 mode=remove 才能是破坏性那个动作");
  assert.match(route, /if \(remove && !connectionId\)/, "不点名就不得硬删");
  assert.match(route, /status: 400/, "静默降级成软断开会报告已移除,而 slot 还占着");
  const cancelAt = route.indexOf("cancelScheduledForConnection(");
  // 删除这一步现在是原子 RPC(remove_social_connection_if_unscheduled,v67):
  // 数排程和删行在同一条 SQL 语句里,不再是两次往返。顺序契约不变,只是换了地址。
  const deleteAt = route.indexOf("removeConnectionIfUnscheduled(");
  assert.ok(cancelAt > 0 && deleteAt > cancelAt, "取消排程必须在删除之前");
  assert.ok(!/await deleteConnection\(uid, connectionId\)/.test(route),
    "路由不得再走不带排程检查的普通 delete —— 那正是被修掉的竞态");
  // 而且必须取消成功才准删(Codex #6):否则"已移除"是一句假话。
  const guardAt = route.indexOf("cancelOutcome.readFailed || cancelOutcome.failed > 0");
  assert.ok(guardAt > cancelAt && deleteAt > guardAt, "删除守卫必须夹在取消与删除之间");
  assert.match(route, /code: "schedule_cancel_failed"/);
  // 软断开仍是默认分支:旧标签页不带 mode 时只会做可逆的那个。
  assert.match(route, /await disconnect\(uid, connectionId\);/);
  const store = read("src/lib/server/pinterest/connectionStore.ts");
  const delIdx = store.indexOf("export async function deleteConnection(");
  assert.ok(delIdx > 0, "Pinterest 侧必须真的有一条硬删路径");
  const delBody = store.slice(delIdx, delIdx + 600);
  for (const scope of ['.eq("user_id", uid)', '.eq("provider", PROVIDER)', '.eq("id", connectionId)']) {
    assert.ok(delBody.includes(scope), "硬删必须同时限定 " + scope);
  }
});

test("发布侧的读取方仍然只认能发的账号", () => {
  // 共享的 /api/social/connections 现在也带已断开的行,所以每个消费者都必须自己
  // 过滤。usePinterestConnections 是其中最危险的一个:它的输出同时喂给账号选择器、
  // adopt-once 的 fallback 和 retryBlockReason。
  const hook = read("src/hooks/usePinterestConnections.ts");
  assert.match(hook, /PUBLISHABLE_STATUSES\.has\(a\.connectionStatus\)/,
    "hook 必须过滤掉已断开的行,否则 target_disconnected 拦截会形同虚设");
  assert.match(hook, /new Set\(\["connected", "expired"\]\)/,
    "白名单而不是黑名单:将来新增的状态默认不能发");
  for (const [p, needle] of [
    ["src/components/social/PublishDestinations.tsx", 'accounts.filter(a => a.connectionStatus === "connected")'],
    ["src/components/studio/StudioBoard.tsx", 'accounts.filter(a => a.connectionStatus === "connected")'],
    ["src/components/settings/SettingsModal.tsx", 'filter(a => a.connectionStatus === "connected")'],
    ["src/app/api/publish/destinations/validate/route.ts", 'find(a => a.connectionStatus === "connected")'],
  ] as const) {
    assert.ok(read(p).includes(needle), p + " 必须只取 connected 的账号");
  }
  // 排程写入的唯一入口也自带同一判定(PinBoardCard / 抽屉都经过它)。
  assert.ok(read("src/lib/social/scheduledDestinations.ts")
    .includes('accounts.filter(a => a.connectionStatus === "connected")'),
    "resolveScheduledAccount 必须自己就拦住已断开的账号");
});

console.log(`\n${passed} 项断言全部通过。`);
}

main().catch(err => { console.error(err); process.exit(1); });
