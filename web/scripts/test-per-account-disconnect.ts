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
  // mode=remove 同理:硬删只能点名一条行。不带 id 的移除就是批量删除,
  // 产品里没有任何按钮是这个意思。
  assert.match(clientSrc, /if \(id && opts\?\.mode === "remove"\) params\.set\("mode", "remove"\)/);
});

test("面板:任何 Pinterest 断开/移除都必须带 connectionId(不带 id 的调用已从 UI 移除)", () => {
  // 反转自旧断言。旧版要求平台级 Disconnect 保持"无参 = 断掉全部",那在单账号
  // 时看着像"断开我的账号",两个账号时就是静默把两个都断了。PRD 0809 §II 直接
  // 取消了这个按钮,所以面板里不该再有任何一处无参调用。
  assert.doesNotMatch(panelSrc, /disconnectPinterest\(\s*\)/,
    "面板不得再无参调用 disconnectPinterest(那会拆掉该用户全部连接)");
  assert.match(panelSrc, /await disconnectPinterest\(account\.id, \{ cancelScheduled, mode: "remove" \}\)/,
    "逐账号 Remove 必须传该账号的 connectionId,并且是 mode=remove 的硬删 —— 软断开会把行留下来继续占额度");
  assert.match(panelSrc, /await disconnectPinterest\(account\.id\);/,
    "逐账号 Disconnect(软)同样必须只针对该账号");
  // 路由本身保留无参语义(可能还有别的调用方),这里只约束 UI。
  assert.match(routeSrc, /return id \|\| undefined;/);
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
  const outcome = await cancelScheduledForConnection(db, "u1", "c1", now);
  assert.deepEqual(outcome, { cleared: 2, failed: 0, readFailed: false });

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

await testAsync("单行写回失败只跳过该行,但必须报告 failed(Codex #6)", async () => {
  const rows = [
    { vibepin_user_id: "u1", draft_id: "d1", payload: { targetConnectionId: "c1" } },
    { vibepin_user_id: "u1", draft_id: "d2", payload: { targetConnectionId: "c1" } },
  ];
  const { db } = makeFakeDb([
    { data: rows },
    { error: { code: "XX000", message: "boom" } },
    { data: null },
  ]);
  const outcome = await cancelScheduledForConnection(db, "u1", "c1", "2026-08-07T10:00:00.000Z");
  assert.equal(outcome.cleared, 1, "一行失败不应吞掉另一行的成功");
  // 只回 cleared 的老契约里,这一次和"两行都成功清了 1 行"长得一模一样,
  // 路由据此照删不误。failed 是删除守卫唯一的输入。
  assert.equal(outcome.failed, 1, "失败的行必须出现在返回值里,否则路由无从判断");
  assert.equal(outcome.readFailed, false);
});

await testAsync("读取失败 ≠ 没有排程:readFailed 必须为 true(Codex #6)", async () => {
  const { db } = makeFakeDb([{ error: { code: "XX000", message: "connection reset" } }]);
  const outcome = await cancelScheduledForConnection(db, "u1", "c1", "2026-08-07T10:00:00.000Z");
  assert.deepEqual(outcome, { cleared: 0, failed: 0, readFailed: true },
    "查不到就等于不知道有什么排程,绝不能当成'什么都没有'");
});

await testAsync("缺表/缺列仍然是'确实没有排程',不是失败", async () => {
  // 可选迁移没跑不该把商家卡在无法移除账号上——这条降级是故意的,别顺手改掉。
  const { db } = makeFakeDb([{ error: { code: "42P01", message: "does not exist" } }]);
  const outcome = await cancelScheduledForConnection(db, "u1", "c1", "2026-08-07T10:00:00.000Z");
  assert.deepEqual(outcome, { cleared: 0, failed: 0, readFailed: false });
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

test("Pinterest remove:取消没全清就不许删(Codex #6)", () => {
  // 这是本任务的核心:取消与删除是同一个决定。读失败被降级成"没有排程"、
  // 单行写回失败被 log-and-skip,路由却照删——商家看到"已移除",而 cron 手里
  // 还攥着指向已删除账号的排程行。
  assert.match(routeSrc, /if \(cancelOutcome && \(cancelOutcome\.readFailed \|\| cancelOutcome\.failed > 0\)\)/,
    "删除前必须同时检查 readFailed 与 failed");
  assert.match(routeSrc, /code: "schedule_cancel_failed"/);
  assert.match(routeSrc, /status: 409/);
  // 守卫必须在 deleteConnection 之前;否则它只是个装饰。
  const guardAt = routeSrc.indexOf("cancelOutcome.readFailed || cancelOutcome.failed > 0");
  const deleteAt = routeSrc.indexOf("await deleteConnection(uid, connectionId)");
  assert.ok(guardAt > 0 && deleteAt > guardAt, "守卫必须挡在删除之前");
  // 409 的响应体要能被客户端读成一句人话(parseErrorResponse 只认 body.error)。
  assert.match(routeSrc, /error: userMessage/,
    "客户端的 parseErrorResponse 读 body.error,少了它商家只会看到 HTTP 状态");
  assert.match(routeSrc, /cleared: cancelOutcome\.cleared/);
  assert.match(routeSrc, /failed: cancelOutcome\.failed/);
});

test("软断开不受守卫影响:行还在,排程发布时会被 target_disconnected 挡住", () => {
  // 只有硬删是不可逆的那一个。软断开保留行,半清的排程仍然看得见、可重试,
  // 把守卫扩到那里只会让一个 UI 根本走不到的路径变得更容易失败。
  const guardAt = routeSrc.indexOf("cancelOutcome.readFailed || cancelOutcome.failed > 0");
  const softAt = routeSrc.indexOf("await disconnect(uid, connectionId)");
  assert.ok(softAt > guardAt, "软断开在 remove 分支之后,不经过守卫");
  assert.match(routeSrc, /if \(remove && connectionId\) \{/);
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

test("逐账号移除对三家都放行,但计数按 provider 走各自的口径", () => {
  // 旧版在这里直接拒绝非 Pinterest。现在 FB/IG 也接通了,于是真正的风险换成了
  // "用错口径":Pinterest 的排程钉在 payload.targetConnectionId,FB/IG 只存在于
  // payload.scheduledDestinations[]。拿 Pinterest 的端点去问一个 Facebook id,
  // 会 0 行匹配并自信地回答 0 —— 用户的排程被无声删掉,连提示都没有。
  assert.doesNotMatch(panelSrc, /per-account removal is not wired for/,
    "非 Pinterest 的硬拒绝必须已经拆掉");
  assert.match(
    panelSrc,
    /const scheduledCount = provider === "pinterest"\s*\n\s*\? await getScheduledCountForConnection\(account\.id\)\s*\n\s*: await fetchSocialScheduledCount\(account\.id\);/,
    "计数必须按 provider 分流,不能一个端点管三家",
  );
  assert.match(panelSrc, /await disconnectSocial\(account\.id, \{ mode: "remove", cancelScheduled \}\)/,
    "FB/IG 的 Remove 必须是 mode: remove(硬删),并把 Keep/Cancel 的选择透传给服务端");
});

test("软断开与硬移除是两个不同的服务端动作,默认永远是软的那个", () => {
  const socialRoute = read("src/app/api/social/disconnect/route.ts");
  // 默认值这一行是"旧标签页不会造成更大破坏"的唯一保证:发布前的客户端两个字段
  // 都不带,如果默认是 remove,一次误点就会删掉账号行。
  assert.match(socialRoute, /return value === "remove" \? "remove" : "disconnect";/,
    "只有显式 remove 才是硬删,其余一律软断开");
  // 软断开分支自己撤销凭据后立刻返回:行保留,永远走不到 deleteConnection。
  // (硬移除的撤销被挪到了取消之后 —— Codex #2,见下面的顺序断言。)
  assert.match(
    socialRoute,
    /if \(mode === "disconnect"\) \{\s*\n\s*await revokeAtProvider\(\);\s*\n\s*return Response\.json\(\{ ok: true, mode \}\);/,
    "软断开必须在 deleteConnection 之前返回(保留行)",
  );
  const cancelAt = socialRoute.indexOf("cancelScheduledForSocialConnection(");
  const deleteAt = socialRoute.indexOf("await deleteConnection(uid, connectionId)");
  assert.ok(cancelAt > 0 && deleteAt > cancelAt,
    "取消排程必须发生在删除之前:否则中途失败会留下一个没有账号、cron 却照发的排程");
  // 顺序还不够——取消还必须真的成功(Codex #6)。
  const guardAt = socialRoute.indexOf("outcome.readFailed || outcome.failed > 0");
  assert.ok(guardAt > cancelAt && deleteAt > guardAt,
    "删除守卫必须夹在取消与删除之间");
  assert.match(socialRoute, /code: "schedule_cancel_failed"/);
  assert.match(socialRoute, /status: 409/);
});

await testAsync("断开一个账号不会波及同平台的其它账号", async () => {
  // 这是本轮唯一"错了就静默毁数据"的点:store 的 UPDATE 若丢掉 .eq("id", …),
  // 用户点一个账号的 Disconnect 会把同平台另一个账号一起签退,而 UI 完全无感。
  const fb = read("src/lib/server/facebook/connectionStore.ts");
  const ig = read("src/lib/server/instagram/connectionStore.ts");
  for (const [name, src] of [["facebook", fb], ["instagram", ig]] as const) {
    assert.match(src, /connectionId \? await updateQuery\.eq\("id", connectionId\) : await updateQuery;|connectionId \? await base\.eq\("id", connectionId\) : await base;/,
      `${name} 的 disconnect 必须在带 id 时收敛到那一行`);
    assert.match(src, /\.eq\("user_id", uid\)/, `${name} 的 disconnect 必须始终限定 user_id`);
    assert.match(src, /\.eq\("provider", PROVIDER\)/, `${name} 的 disconnect 必须始终限定 provider`);
  }
  // official provider 是路由到 store 的唯一通道 —— 它必须把 connectionId 传下去,
  // 否则上面两处收敛永远不会被触发。
  const official = read("src/lib/social/providers/official.ts");
  assert.match(official, /disconnectFacebookConnection\(input\.userId, input\.connectionId\)/);
  assert.match(official, /disconnectInstagramConnection\(input\.userId, input\.connectionId\)/);

  // 撤销现在包成 revokeAtProvider():两种模式把它放在序列的不同位置(软断开立刻撤销;
  // 硬移除要等取消成功之后 —— Codex #2)。点名连接这件事本身没变。
  // 路由必须把 connectionId 交给 provider.disconnect —— 这是上面那些收敛能被
  // 触发的唯一前提。少了这一行,store 侧写得再对也永远走"全平台清空"分支。
  const socialRoute = read("src/app/api/social/disconnect/route.ts");
  assert.match(
    socialRoute,
    /const revokeAtProvider = \(\) => getSocialProviderById\(connection\.authProvider\)\.disconnect\(\{\s*\n\s*userId: uid,\s*\n\s*connectionId,/,
    "路由必须按连接点名,不能只报 provider",
  );
  // 反向守卫:store 里不得存在"带了 id 却仍然全表更新"的写法。
  for (const [name, src] of [["facebook", fb], ["instagram", ig]] as const) {
    assert.doesNotMatch(src, /connection_status: "not_connected",[\s\S]{0,400}?\}\)\s*;\s*\n\s*\/\/ no user filter/,
      `${name} 的 disconnect 不得存在无过滤的写路径`);
  }
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
