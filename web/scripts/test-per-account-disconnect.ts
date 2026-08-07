/**
 * test-per-account-disconnect.ts — Phase D ③:逐账号移除 + Remove 前置排程检查。
 *
 * 要守住的三件事(每一条都对应一个真实可能复发的 bug):
 *  1. 传了 connectionId 只断那一条;不传仍是"断掉该用户所有活跃连接"——
 *     旧的单账号 Disconnect 行为一行都不能变;
 *     并且无论哪条路径,user_id 过滤都不能丢(否则能断别人的账号)。
 *  2. 排程口径:只统计"钉定到该连接 + scheduled_at 非空 + 未删除未归档"的行。
 *     没有 targetConnectionId 的草稿不算(它们发布时会解析到别的账号),
 *     否则每次移除都会弹一个吓人的假警告。
 *  3. Cancel 必须清 scheduled_at 且 bump payload.updatedAt。少了 bump,
 *     客户端 LWW 会把旧的带排程 payload 推回来,cron 照发不误——
 *     "取消"变成静默失效。这是本任务唯一会让功能整体白做的点。
 *
 * Run: npx tsx scripts/test-per-account-disconnect.ts
 */

// connectionStore / route 都会经由 supabase 模块在 import 期建客户端。占位 env 让
// 这些 import 不抛;下面没有任何断言碰真实数据库(要么是纯函数,要么读源码文本,
// 要么用本文件里的假 db)。必须在动态 import 之前设置——所以模块不走顶层 import。
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

// ── 一个记录调用链的假 Supabase ────────────────────────────────────────────────
// 只实现我们用到的链式方法,并把每一步 (方法, 参数) 记下来,这样"过滤条件对不对"
// 可以被直接断言,而不是靠读代码相信。
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

/** All (col, val) pairs asserted with .eq on a recorded chain. */
function eqPairs(calls: Call[]): Array<[string, unknown]> {
  return calls.filter(c => c.method === "eq").map(c => [c.args[0] as string, c.args[1]]);
}

async function main() {
const {
  payloadAfterScheduleCancelled,
  payloadTargetsConnection,
  countScheduledForConnection,
  cancelScheduledForConnection,
} = await import("../src/lib/server/pinterest/scheduledForConnection");

const routeSrc = read("src/app/api/pinterest/disconnect/route.ts");
const storeSrc = read("src/lib/server/pinterest/connectionStore.ts");
const clientSrc = read("src/lib/pinterestClient.ts");
const panelSrc = read("src/components/social/SocialAccountsPanel.tsx");

console.log("\n=== 1) 逐连接断开契约:带 id 只断一条,不带 id 保持全量 ===");

test("store 的 disconnect 收可选 connectionId,并且两条路径都保留 user_id 过滤", () => {
  assert.match(
    storeSrc,
    /export async function disconnect\(uid: string, connectionId\?: string\)/,
    "disconnect 必须接受可选 connectionId",
  );
  // user_id 过滤在分支之前无条件加上——这是"不能断别人账号"的唯一保证。
  assert.match(
    storeSrc,
    /\.update\(patch\)\s*\.eq\("user_id", uid\)\s*\.eq\("provider", PROVIDER\)/,
    "user_id + provider 过滤必须在分支之前无条件生效",
  );
  // 带 id → .eq("id", …);不带 id → 仍是原来的"只断活跃连接"谓词。
  assert.match(storeSrc, /if \(connectionId\) \{\s*q = q\.eq\("id", connectionId\);/);
  assert.match(storeSrc, /q = q\.is\("disconnected_at", null\);/,
    "不传 connectionId 时必须保持原有的全量(仅活跃行)断开谓词");
});

test("路由从 query 读 connectionId(不是 DELETE body),缺省时透传 undefined", () => {
  assert.match(routeSrc, /new URL\(req\.url\)\.searchParams\.get\("connectionId"\)/,
    "connectionId 必须走 query:DELETE body 会被代理/fetch 丢掉");
  assert.doesNotMatch(routeSrc, /req\.json\(\)/, "DELETE 不得依赖请求体");
  // 空串必须变成 undefined,否则 .eq("id","") 会匹配 0 行 —— 用户点了 Disconnect 却什么都没断。
  assert.match(routeSrc, /return id \|\| undefined;/);
  assert.match(routeSrc, /await disconnect\(uid, connectionId\)/);
});

test("客户端把 id 放进 query 并编码;不传 id 时 URL 与旧版逐字符相同", () => {
  assert.match(clientSrc, /export async function disconnectPinterest\(\s*connectionId\?: string \| null,/);
  assert.match(clientSrc, /params\.set\("connectionId", id\)/);
  // 无参数调用必须仍然打到裸路径 —— 老的单账号 Disconnect 零行为变化。
  assert.match(clientSrc, /`\/api\/pinterest\/disconnect\$\{qs \? `\?\$\{qs\}` : ""\}`/);
  // cancelScheduled 只在有 id 时才可能被带上:全量断开不该顺手清排程。
  assert.match(clientSrc, /if \(id && opts\?\.cancelScheduled\) params\.set\("cancelScheduled", "1"\)/);
});

test("面板:平台级 Disconnect 仍不带 id,逐账号 Remove 才带 id", () => {
  assert.match(panelSrc, /disconnectPinterest\(\)\s*\n\s*\.catch/,
    "平台级 Disconnect 必须继续无参调用(=全量断开)");
  assert.match(panelSrc, /await disconnectPinterest\(account\.id, \{ cancelScheduled \}\)/,
    "逐账号 Remove 必须传该账号的 connectionId");
});

console.log("\n=== 2) 排程口径:只数钉定到该连接的活跃排程行 ===");

test("payloadTargetsConnection:只认相等的 targetConnectionId,未钉定一律 false", () => {
  assert.equal(payloadTargetsConnection({ targetConnectionId: "c1" }, "c1"), true);
  assert.equal(payloadTargetsConnection({ targetConnectionId: " c1 " }, "c1"), true, "两端空白应被 trim");
  assert.equal(payloadTargetsConnection({ targetConnectionId: "c2" }, "c1"), false);
  assert.equal(payloadTargetsConnection({}, "c1"), false, "未钉定的草稿不属于任何账号");
  assert.equal(payloadTargetsConnection(null, "c1"), false);
  assert.equal(payloadTargetsConnection({ targetConnectionId: "c1" }, ""), false);
});

await testAsync("count 的过滤链:user + target + scheduled_at 非空 + 未删除未归档", async () => {
  const { db, chains } = makeFakeDb([{ data: [{ draft_id: "d1" }, { draft_id: "d2" }] }]);
  const n = await countScheduledForConnection(db, "u1", "c1");
  assert.equal(n, 2);

  const calls = chains[0];
  assert.deepEqual(calls[0], { method: "from", args: ["pin_drafts"] });
  const eqs = eqPairs(calls);
  assert.ok(eqs.some(([c, v]) => c === "vibepin_user_id" && v === "u1"), "必须按用户过滤");
  assert.ok(
    eqs.some(([c, v]) => c === "payload->>targetConnectionId" && v === "c1"),
    "必须按 payload 里的目标连接过滤(未钉定的草稿因此天然被排除)",
  );
  assert.ok(
    calls.some(c => c.method === "not" && c.args[0] === "scheduled_at" && c.args[1] === "is" && c.args[2] === null),
    "只数真正排了期的行(scheduled_at 非空 = cron 的扫描口径)",
  );
  for (const col of ["deleted_at", "archived_at"]) {
    assert.ok(
      calls.some(c => c.method === "is" && c.args[0] === col && c.args[1] === null),
      `必须排除 ${col} 非空的行(与 cron due-scan 一致)`,
    );
  }
});

await testAsync("空 connectionId 不查库直接 0;缺表/缺列降级为 0 而不是报错", async () => {
  const empty = makeFakeDb([]);
  assert.equal(await countScheduledForConnection(empty.db, "u1", "  "), 0);
  assert.equal(empty.chains.length, 0, "空 id 不应发出任何查询");

  const missing = makeFakeDb([{ error: { code: "PGRST205", message: "Could not find the table" } }]);
  assert.equal(await countScheduledForConnection(missing.db, "u1", "c1"), 0,
    "v38/v42 未 apply 时不能因此拦住用户移除账号");
});

console.log("\n=== 3) Cancel:清排程 + bump updatedAt(缺 bump 会被 LWW 复活)===");

test("payloadAfterScheduleCancelled 清三个排程字段并 bump updatedAt,保留 target", () => {
  const now = "2026-08-07T10:00:00.000Z";
  const out = payloadAfterScheduleCancelled({
    updatedAt: "2026-08-01T00:00:00.000Z",
    scheduledDate: "2026-08-09",
    scheduledTime: "10:30",
    plannedAt: "2026-08-09T10:30",
    targetConnectionId: "c1",
    title: "keep me",
  }, now);

  assert.equal(out.scheduledDate, "");
  assert.equal(out.scheduledTime, "");
  assert.equal(out.plannedAt, "");
  // 这一行是整个功能是否真的生效的分水岭:客户端 mergeServerDrafts 按 updatedAt
  // 做 last-write-wins,不 bump 的话浏览器里的旧 payload 会把排程推回来。
  assert.equal(out.updatedAt, now, "必须 bump updatedAt,否则客户端 LWW 会复活排程");
  assert.equal(out.targetConnectionId, "c1", "不改目标:重新连接后意图仍在");
  assert.equal(out.title, "keep me", "其余字段原样保留");
});

await testAsync("cancel 写回:scheduled_at 置空、释放 claim、按 (user, draft) 定位", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { targetConnectionId: "c1", scheduledDate: "2026-08-09" } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { targetConnectionId: "c1", scheduledTime: "09:00" } },
  ];
  const { db, chains } = makeFakeDb([{ data: rows }, { data: null }, { data: null }]);
  const now = "2026-08-07T10:00:00.000Z";
  const cleared = await cancelScheduledForConnection(db, "u1", "c1", now);
  assert.equal(cleared, 2);

  for (const calls of chains.slice(1)) {
    const update = calls.find(c => c.method === "update");
    assert.ok(update, "每行都必须发出 update");
    const patch = update!.args[0] as Record<string, unknown>;
    assert.equal(patch.scheduled_at, null, "必须置空 scheduled_at,否则 cron 照样发");
    assert.equal(patch.publish_claimed_at, null, "顺带释放锁,避免半持有的行");
    assert.equal(patch.updated_at, now);
    const payload = patch.payload as Record<string, unknown>;
    assert.equal(payload.scheduledDate, "");
    assert.equal(payload.updatedAt, now);

    const eqs = eqPairs(calls);
    assert.ok(eqs.some(([c, v]) => c === "vibepin_user_id" && v === "u1"), "写回也必须限定用户");
    assert.ok(eqs.some(([c]) => c === "draft_id"), "写回必须按 draft_id 精确定位");
  }
});

await testAsync("单行写回失败只跳过该行,不影响其它行的取消", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { targetConnectionId: "c1" } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { targetConnectionId: "c1" } },
  ];
  const { db } = makeFakeDb([
    { data: rows },
    { error: { code: "XX000", message: "boom" } },
    { data: null },
  ]);
  const cleared = await cancelScheduledForConnection(db, "u1", "c1", "2026-08-07T10:00:00.000Z");
  assert.equal(cleared, 1, "一行失败不应吞掉另一行的成功");
});

console.log("\n=== 4) 路由编排 + UI 决策面 ===");

test("DELETE 先取消排程再断开,且只在带 id + cancelScheduled=1 时取消", () => {
  assert.match(routeSrc, /searchParams\.get\("cancelScheduled"\) === "1"/);
  assert.match(routeSrc, /if \(connectionId && cancelScheduled\)/,
    "全量断开路径绝不可顺手清排程");
  const cancelAt = routeSrc.indexOf("cancelScheduledForConnection(");
  const disconnectAt = routeSrc.indexOf("await disconnect(uid, connectionId)");
  assert.ok(cancelAt > 0 && disconnectAt > cancelAt,
    "取消必须发生在断开之前:中途失败时宁可留下'已连接但排程被清',也不要'已移除但 cron 还在发'");
});

test("GET 只在带 connectionId 时查排程,否则直接回 0", () => {
  assert.match(routeSrc, /export async function GET\(req: Request\)/);
  assert.match(routeSrc, /if \(!connectionId\) return Response\.json\(\{ ok: true, scheduledCount: 0 \}\)/);
  assert.match(routeSrc, /countScheduledForConnection\(createServerClient\(\), uid, connectionId\)/);
});

test("UI:0 条不弹框直接移除;>0 才弹 Keep / Cancel 两选一(不做 Reassign)", () => {
  assert.match(panelSrc, /if \(scheduledCount > 0\) \{/);
  assert.match(panelSrc, /setPendingRemoval\(\{ account, label, scheduledCount \}\)/);
  assert.match(panelSrc, /removeAccount\(account\.provider, account, false\)/, "Keep = 不取消排程");
  assert.match(panelSrc, /removeAccount\(account\.provider, account, true\)/, "Cancel = 取消排程");
  assert.doesNotMatch(panelSrc, /[Rr]eassign/, "Reassign 属二期,不应出现在本轮 UI");
});

test("UI:逐账号 Remove 的乐观更新只摘掉一条,不清空整个平台", () => {
  assert.match(panelSrc, /const accounts = s\.accounts\.filter\(a => a\.id !== account\.id\);/,
    "只移除被点的那条账号");
  assert.match(panelSrc, /accountCount: Math\.max\(0, s\.accountCount - 1\)/, "计数减一而不是归零");
  assert.match(panelSrc, /connected: accounts\.some\(a => a\.connectionStatus === "connected"\)/,
    "还有其它账号时平台必须保持已连接");
});

test("逐账号移除只对 Pinterest 放行(账号行对任何 2+ 账号平台都渲染)", () => {
  // 计数/断开走的都是 Pinterest 专用路由。把别家的 connectionId 递进去会被 store 的
  // provider 过滤掉 → 0 行 → 200,UI 会显示"已移除",直到下一次 load 把它变回来。
  assert.match(panelSrc, /if \(provider !== "pinterest"\) \{/,
    "非 Pinterest 必须显式失败,而不是静默假成功");
  assert.doesNotMatch(
    read("src/components/social/SocialAccountsPanel.tsx").split("function AccountRows")[1]?.slice(0, 400) ?? "",
    /provider === "pinterest"/,
    "账号行本身不按平台过滤 —— 所以守卫必须在 handleRemoveAccount 里",
  );
});
test("Keep 分支不重复实现拦截:唯一执行点仍是 Phase C 的 retryBlockReason", () => {
  // 前提校验(不推断,直接查):Keep 之所以能是"什么都不做",全靠这条已存在的拦截。
  const publishTarget = read("src/lib/studio/publishTarget.ts");
  assert.match(publishTarget, /export type RetryBlockReason = "target_disconnected"/);
  assert.match(publishTarget, /if \(!input\.active\.some\(c => c\.id === stored\)\) return "target_disconnected";/,
    "目标不在活跃连接里就必须被拦住 —— Keep 分支依赖这一行");
  // 面板只在注释里提到它,不得自己再实现一遍判定逻辑。
  assert.doesNotMatch(
    panelSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""),
    /target_disconnected/,
    "面板代码(去注释后)不应出现第二套拦截判定",
  );
});

console.log(`\n${passed} 项断言全部通过。`);
}

main().catch(err => { console.error(err); process.exit(1); });
