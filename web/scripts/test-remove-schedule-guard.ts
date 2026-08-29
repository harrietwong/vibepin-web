/**
 * test-remove-schedule-guard.ts — 移除账号时的排程守卫:服务端自己查、取消成功
 * 之后才撤销凭据(Codex #1 / #2)。
 *
 * 这两个缺陷都不是"报错文案不好看",而是一次瞬时故障就能删掉商家还在用的账号,
 * 或者让一个"没被删掉"的账号从此发不出东西。所以这里不满足于读源码文本 —— 直接
 * 把两条 route 跑起来,用一个有序调用日志断言"到底做了什么、按什么顺序做的"。
 *
 * 守住四条:
 *  1. mode=remove 永远自己查排程。客户端那个计数只是方便,不是授权 ——
 *     它失败会答 0,也可能在商家于另一个标签页排了新内容之前就取好了。
 *  2. 查不动 ≠ 没有排程。读失败必须 503 schedule_check_failed 且一行都不删。
 *  3. 有排程又没说怎么处理 → 409 schedules_exist + 服务端计数,什么都不删。
 *  4. 撤销凭据必须排在取消成功之后。取消失败时行必须完好无损(令牌还在),
 *     否则"保住的"账号发不了它保住的那些排程。
 *  5. 删除这一步必须走 RPC remove_social_connection_if_unscheduled(v67):
 *     预查和删除是两次往返,中间另一个标签页排的内容会活下来指向一行已经不存在
 *     的账号。RPC 把"查"和"删"合成一条语句,是唯一的权威。RPC 说 deleted=false
 *     且还有排程 → 409,一行都不删;RPC 根本不在(迁移没跑)→ 503 且**不得**
 *     退回普通 delete —— 那个退路本身就是这个缺陷。
 *
 * Run: npx tsx scripts/test-remove-schedule-guard.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import Module from "node:module";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  OK  ${name}`);
}

const UID = "user-1";
const CONN = "conn-fb-2";

// ── 有序调用日志 ──────────────────────────────────────────────────────────────
// 顺序才是本文件的主张。只数次数无法区分"撤销→取消失败→保住行"和
// "取消失败→保住行(令牌完好)",而这正是 Codex #2 的全部内容。
let log: string[] = [];

// 每个桩的下一次返回值,由各用例设置。
let countOutcome: { count: number; readFailed: boolean } = { count: 0, readFailed: false };
let cancelOutcome = { cleared: 0, failed: 0, readFailed: false };
let pinCountOutcome: { count: number; readFailed: boolean } = { count: 0, readFailed: false };
let pinCancelOutcome = { cleared: 0, failed: 0, readFailed: false };
/* eslint-disable @typescript-eslint/no-explicit-any */
// RPC 的下一次返回值。默认:删成功。
let rpcResult: { data: any; error: any } = { data: [{ deleted: true, scheduled_count: 0 }], error: null };
let rpcArgs: Array<Record<string, unknown>> = [];
/* eslint-enable @typescript-eslint/no-explicit-any */
const RPC = "rpc:remove_social_connection_if_unscheduled";

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  // 假 supabase:这些用例一行真实数据库都不碰。
  if (/[\\/]lib[\\/]supabase(\.ts)?$/.test(request) || request === "@/lib/supabase") {
    return {
      createServerClient: () => ({
        from: () => ({}),
        // 删除这一步现在是一次 RPC。参数也断言:错传 uid/连接 id 会删掉别人的行。
        rpc: async (fn: string, args: Record<string, unknown>) => {
          log.push(`rpc:${fn}`);
          rpcArgs.push(args);
          return rpcResult;
        },
      }),
    };
  }
  // 鉴权:恒定同一个用户。
  if (/[\\/]server[\\/]authUser(\.ts)?$/.test(request) || request === "@/lib/server/authUser") {
    return {
      getUserIdFromBearer: async () => UID,
      getUserIdFromBearerOrCookies: async () => UID,
    };
  }
  // 多平台排程模块。
  if (/[\\/]social[\\/]scheduledForSocialConnection(\.ts)?$/.test(request)
    || request === "@/lib/server/social/scheduledForSocialConnection") {
    return {
      countScheduledForSocialConnection: async () => { log.push("count"); return countOutcome.count; },
      countScheduledForSocialConnectionStrict: async () => { log.push("countStrict"); return countOutcome; },
      cancelScheduledForSocialConnection: async () => { log.push("cancel"); return cancelOutcome; },
    };
  }
  // Pinterest 排程模块。
  if (/[\\/]pinterest[\\/]scheduledForConnection(\.ts)?$/.test(request)
    || request === "@/lib/server/pinterest/scheduledForConnection") {
    return {
      countScheduledForConnection: async () => { log.push("count"); return pinCountOutcome.count; },
      countScheduledForConnectionStrict: async () => { log.push("countStrict"); return pinCountOutcome; },
      cancelScheduledForConnection: async () => { log.push("cancel"); return pinCancelOutcome; },
    };
  }
  // 连接存储:删除/软断开都记进日志。
  if (/[\\/]social[\\/]server[\\/]socialConnectionStore(\.ts)?$/.test(request)
    || request === "@/lib/social/server/socialConnectionStore") {
    return {
      findConnection: async () => ({
        id: CONN, provider: "facebook", authProvider: "official",
        externalConnectionId: null,
      }),
      // 仍然打桩并记日志:路由不该再调它了,一旦调用日志里会立刻冒出 plainDelete。
      deleteConnection: async () => { log.push("plainDelete"); },
    };
  }
  if (/[\\/]server[\\/]pinterest[\\/]connectionStore(\.ts)?$/.test(request)
    || request === "@/lib/server/pinterest/connectionStore") {
    return {
      deleteConnection: async () => { log.push("plainDelete"); },
      forgetConnection: () => { log.push("forgetCache"); },
      disconnect: async () => { log.push("softDisconnect"); },
    };
  }
  // provider.disconnect:撤销凭据。这是 Codex #2 里必须最后发生的那一步。
  if (/[\\/]social[\\/]providers(\.ts)?$/.test(request)
    || request === "@/lib/social/providers") {
    return {
      getSocialProviderById: () => ({
        disconnect: async () => { log.push("revoke"); },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function socialRequest(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/social/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

function pinterestRequest(qs: string): Request {
  return new Request(`https://example.com/api/pinterest/disconnect?${qs}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer t" },
  });
}

async function main() {
const socialRoute = await import("../src/app/api/social/disconnect/route");
const pinterestRoute = await import("../src/app/api/pinterest/disconnect/route");

console.log("\n=== 1) FB/IG:mode=remove 永远自己查排程(Codex #1) ===");

await test("客户端没要求取消时,服务端仍然自己查了一遍 —— 计数不是客户端说了算", async () => {
  log = []; countOutcome = { count: 0, readFailed: false };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 200);
  // 关键:即使 cancelScheduled 没传,countStrict 也必须出现在日志里。
  // 旧代码在这条路径上什么都不查,直接删。
  assert.ok(log.includes("countStrict"), "remove 必须无条件查一次排程");
  assert.deepEqual(log, ["countStrict", "revoke", RPC],
    "查 → 撤销 → 原子删除;查在最前面,删除走 RPC 而不是普通 delete");
  assert.ok(!log.includes("plainDelete"), "不得再走不带排程检查的普通 delete");
  assert.deepEqual(rpcArgs.at(-1), { p_user_id: UID, p_connection_id: CONN },
    "RPC 必须同时带 uid 和连接 id —— 少一个就会删到别人的行");
});

await test("读排程失败 → 503 schedule_check_failed,一行都不删、也不撤销凭据", async () => {
  log = []; countOutcome = { count: 0, readFailed: true };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 503, "读失败是暂时性的,用 503 而不是 409");
  const body = await res.json() as { code?: string; userMessage?: string; ok?: boolean };
  assert.equal(body.code, "schedule_check_failed");
  assert.equal(body.ok, false);
  assert.ok((body.userMessage ?? "").length > 0, "必须给商家一句能照做的话");
  // 这是整条修复的要害:读不到 ≠ 没有排程,所以什么都不能动。
  assert.deepEqual(log, ["countStrict"], "读失败之后不得有任何写操作");
});

await test("有排程但没说怎么处理 → 409 schedules_exist,带服务端计数,什么都不删", async () => {
  log = []; countOutcome = { count: 3, readFailed: false };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string; scheduledCount?: number; userMessage?: string };
  assert.equal(body.code, "schedules_exist");
  assert.equal(body.scheduledCount, 3, "必须回服务端自己数的那个数,面板要用它重开对话框");
  assert.ok((body.userMessage ?? "").includes("3"), "话里要有数字,否则商家无从判断轻重");
  assert.deepEqual(log, ["countStrict"], "把决定交回去时不得删除或撤销");
});

console.log("\n=== 2) FB/IG:撤销必须排在取消成功之后(Codex #2) ===");

await test("取消成功 → 取消在前、撤销其次、删除最后", async () => {
  log = []; cancelOutcome = { cleared: 2, failed: 0, readFailed: false };
  const res = await socialRoute.POST(
    socialRequest({ connectionId: CONN, mode: "remove", cancelScheduled: true }),
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { cancelledScheduled?: number };
  assert.equal(body.cancelledScheduled, 2);
  assert.deepEqual(log, ["cancel", "revoke", RPC],
    "顺序就是契约:取消 → 撤销 → 原子删除");
});

await test("取消失败 → 行完好无损:没撤销、没删除(否则保住的账号发不出保住的排程)", async () => {
  log = []; cancelOutcome = { cleared: 1, failed: 2, readFailed: false };
  const res = await socialRoute.POST(
    socialRequest({ connectionId: CONN, mode: "remove", cancelScheduled: true }),
  );
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string };
  assert.equal(body.code, "schedule_cancel_failed");
  // 旧代码这里已经撤销过凭据了 —— 于是"未移除"的账号从此发布全失败。
  assert.deepEqual(log, ["cancel"], "取消失败后不得撤销凭据,更不得删除");
  assert.ok(!log.includes("revoke"), "撤销绝不能发生在取消成功之前");
});

await test("取消时读失败也一样:什么都不动", async () => {
  log = []; cancelOutcome = { cleared: 0, failed: 0, readFailed: true };
  const res = await socialRoute.POST(
    socialRequest({ connectionId: CONN, mode: "remove", cancelScheduled: true }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(log, ["cancel"]);
});

await test("软断开不变:立刻撤销、保留行,不查也不删", async () => {
  log = [];
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "disconnect" }));
  assert.equal(res.status, 200);
  // 软断开永远不碰排程 —— 行还在,发布时由 target_disconnected 拦住。
  assert.deepEqual(log, ["revoke"], "软断开只撤销凭据,不查排程、不删行");
});

console.log("\n=== 3) Pinterest:同样的两条规则 ===");

await test("Pinterest remove 也无条件自查;读失败 → 503,不删", async () => {
  log = []; pinCountOutcome = { count: 0, readFailed: true };
  const res = await pinterestRoute.DELETE(
    pinterestRequest(`mode=remove&connectionId=${CONN}`),
  );
  assert.equal(res.status, 503);
  const body = await res.json() as { code?: string };
  assert.equal(body.code, "schedule_check_failed");
  assert.deepEqual(log, ["countStrict"], "读失败之后不得有任何写操作");
});

await test("Pinterest:有排程又没说怎么处理 → 409 schedules_exist + 计数", async () => {
  log = []; pinCountOutcome = { count: 5, readFailed: false };
  const res = await pinterestRoute.DELETE(
    pinterestRequest(`mode=remove&connectionId=${CONN}`),
  );
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string; scheduledCount?: number };
  assert.equal(body.code, "schedules_exist");
  assert.equal(body.scheduledCount, 5);
  assert.deepEqual(log, ["countStrict"], "把决定交回去时不得删除");
});

await test("Pinterest:没有排程 → 查完就删", async () => {
  log = []; pinCountOutcome = { count: 0, readFailed: false };
  const res = await pinterestRoute.DELETE(
    pinterestRequest(`mode=remove&connectionId=${CONN}`),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(log, ["countStrict", RPC, "forgetCache"],
    "查 → 原子删除 → 清缓存(行在 SQL 里没的,本模块的缓存必须手动告知)");
});

await test("Pinterest:带 cancelScheduled 时取消在删除之前,且取消失败就不删", async () => {
  log = []; pinCancelOutcome = { cleared: 3, failed: 0, readFailed: false };
  let res = await pinterestRoute.DELETE(
    pinterestRequest(`mode=remove&connectionId=${CONN}&cancelScheduled=1`),
  );
  assert.equal(res.status, 200);
  // 这条路径不再单独预查:取消自己会读,并且会报 readFailed。
  assert.deepEqual(log, ["cancel", RPC, "forgetCache"], "取消 → 原子删除,且不重复预查");

  log = []; pinCancelOutcome = { cleared: 0, failed: 1, readFailed: false };
  res = await pinterestRoute.DELETE(
    pinterestRequest(`mode=remove&connectionId=${CONN}&cancelScheduled=1`),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(log, ["cancel"], "取消没全清就一行都不删");
});

await test("Pinterest 软断开(不带 mode)不查排程,保持原有行为", async () => {
  log = []; pinCountOutcome = { count: 9, readFailed: false };
  const res = await pinterestRoute.DELETE(pinterestRequest(`connectionId=${CONN}`));
  assert.equal(res.status, 200);
  // 软断开保留行,排程发布时会被 target_disconnected 挡住 —— 不该被排程数量拦住。
  assert.deepEqual(log, ["softDisconnect"], "软断开不查排程,也永远不删行");
});

console.log("\n=== 4) 删除必须是原子的:RPC 才是权威(Codex P0 #1) ===");

// 预查通过、RPC 却拒绝 —— 这正是本条修复存在的理由:两次往返之间,商家在另一个
// 标签页排了新内容。旧代码这时已经把行删了。
await test("FB/IG:预查为 0 但 RPC 说还有排程 → 409 schedules_exist,一行都没删", async () => {
  log = []; rpcArgs = [];
  countOutcome = { count: 0, readFailed: false };
  rpcResult = { data: [{ deleted: false, scheduled_count: 2 }], error: null };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 409);
  const body = await res.json() as { code?: string; scheduledCount?: number; userMessage?: string };
  assert.equal(body.code, "schedules_exist");
  assert.equal(body.scheduledCount, 2, "要回 RPC 自己数的那个数 —— 它和删除同一条语句,是唯一真过的数");
  assert.ok((body.userMessage ?? "").includes("2"));
  assert.ok(!log.includes("plainDelete"), "被拒之后绝不能再退回普通 delete");
  assert.deepEqual(log, ["countStrict", "revoke", RPC], "RPC 拒绝就到此为止");
});

await test("FB/IG:RPC 不存在(迁移没跑)→ 503 remove_unavailable,且不得退回普通 delete", async () => {
  log = []; rpcArgs = [];
  countOutcome = { count: 0, readFailed: false };
  rpcResult = { data: null, error: { code: "42883", message: "function ... does not exist" } };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 503, "能力不在是暂时性的,用 503");
  const body = await res.json() as { code?: string; userMessage?: string; ok?: boolean };
  assert.equal(body.code, "remove_unavailable");
  assert.equal(body.ok, false);
  assert.ok((body.userMessage ?? "").length > 0, "必须给商家一句能照做的话");
  // 这是 fail-closed 的全部内容:退回普通 delete 就等于把刚修掉的竞态原样装回去,
  // 而且恰好装在最没人盯着的那些数据库上。
  assert.ok(!log.includes("plainDelete"), "RPC 缺失时绝不能退回普通 delete");
  assert.deepEqual(log, ["countStrict", "revoke", RPC]);
});

await test("FB/IG:PostgREST 的 PGRST202 同样算能力缺失", async () => {
  log = []; countOutcome = { count: 0, readFailed: false };
  rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { code?: string }).code, "remove_unavailable");
});

await test("FB/IG:其它 RPC 错误也 fail-closed(503),而不是当成删成功", async () => {
  log = []; countOutcome = { count: 0, readFailed: false };
  rpcResult = { data: null, error: { code: "22P02", message: "invalid input syntax for type uuid" } };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 503, "不知道删没删成功时,只能说没删");
  assert.ok(!log.includes("plainDelete"));
});

await test("FB/IG:deleted=false 且 count=0(行本来就没了)算成功 —— 这个接口是幂等的", async () => {
  log = []; countOutcome = { count: 0, readFailed: false };
  rpcResult = { data: [{ deleted: false, scheduled_count: 0 }], error: null };
  const res = await socialRoute.POST(socialRequest({ connectionId: CONN, mode: "remove" }));
  assert.equal(res.status, 200, "上一次尝试已经删掉的行,正是调用方想要的结果");
});

await test("FB/IG:取消排程时的完整顺序 —— 取消 → 撤销 → RPC", async () => {
  log = []; rpcArgs = [];
  cancelOutcome = { cleared: 2, failed: 0, readFailed: false };
  rpcResult = { data: [{ deleted: true, scheduled_count: 0 }], error: null };
  const res = await socialRoute.POST(
    socialRequest({ connectionId: CONN, mode: "remove", cancelScheduled: true }),
  );
  assert.equal(res.status, 200);
  // 取消必须在删除之前(半途死掉时,宁可留着能看见的账号也不要留孤儿排程),
  // 而 RPC 必须是最后一步:它是唯一能保证"删的那一刻确实没有排程"的东西。
  assert.deepEqual(log, ["cancel", "revoke", RPC]);
  assert.deepEqual(rpcArgs.at(-1), { p_user_id: UID, p_connection_id: CONN });
});

await test("Pinterest:RPC 拒绝 → 409;RPC 缺失 → 503;两种情况都不删、不清缓存", async () => {
  log = []; pinCountOutcome = { count: 0, readFailed: false };
  rpcResult = { data: [{ deleted: false, scheduled_count: 4 }], error: null };
  let res = await pinterestRoute.DELETE(pinterestRequest(`mode=remove&connectionId=${CONN}`));
  assert.equal(res.status, 409);
  let body = await res.json() as { code?: string; scheduledCount?: number };
  assert.equal(body.code, "schedules_exist");
  assert.equal(body.scheduledCount, 4);
  assert.deepEqual(log, ["countStrict", RPC], "被拒之后不得清缓存(行还在)");

  log = [];
  rpcResult = { data: null, error: { code: "42883", message: "does not exist" } };
  res = await pinterestRoute.DELETE(pinterestRequest(`mode=remove&connectionId=${CONN}`));
  assert.equal(res.status, 503);
  body = await res.json() as { code?: string };
  assert.equal(body.code, "remove_unavailable");
  assert.ok(!log.includes("plainDelete"), "RPC 缺失时绝不能退回普通 delete");
  assert.ok(!log.includes("forgetCache"), "没删成功就不该清缓存");

  // 复位,免得污染后面的用例。
  rpcResult = { data: [{ deleted: true, scheduled_count: 0 }], error: null };
});

console.log("\n=== 5) 迁移文件本身(v67)===");

await test("migrate_v67 存在,且写的就是那条不可分割的语句", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const sql = readFileSync(
    join(process.cwd(), "..", "backend", "db", "migrate_v67_remove_connection_if_unscheduled.sql"),
    "utf8",
  );
  // 幂等:重跑必须是无操作,否则这条迁移不敢在服务中的库上执行。
  assert.ok(/create or replace function/i.test(sql), "必须 create or replace(幂等)");
  assert.ok(/remove_social_connection_if_unscheduled/.test(sql));
  assert.ok(/security definer/i.test(sql), "跨表删除必须 security definer");
  assert.ok(/set search_path\s*=\s*public/i.test(sql), "security definer 必须钉死 search_path");
  // 两种目标口径缺一不可:少了前者放过 Pinterest 老 Pin,少了后者放过 FB/IG。
  assert.ok(sql.includes("payload->>'targetConnectionId'"), "缺少 Pinterest 的 targetConnectionId 口径");
  assert.ok(sql.includes("scheduledDestinations") && sql.includes("socialConnectionId"),
    "缺少多平台 scheduledDestinations 口径");
  // 候选行的口径必须和 cron 的到期扫描一致,否则会漏掉它真会发的行。
  assert.ok(/scheduled_at is not null/i.test(sql));
  assert.ok(/deleted_at is null/i.test(sql));
  assert.ok(/archived_at is null/i.test(sql));
  // 函数默认对 PUBLIC 开放,只 grant 不 revoke 等于没限制。
  assert.ok(/revoke all on function/i.test(sql), "只 grant 不 revoke,'仅 service_role' 就是假的");
  assert.ok(/grant execute on function[\s\S]*to service_role/i.test(sql));
});

console.log("\n=== 6) 面板与这套契约对得上(PRD 0805 §11) ===");

await test("面板没有任何一条路径会在有排程时发 cancelScheduled:false", async () => {
  // 这是"规则 #1 + 对话框"能自洽的前提。服务端拒绝"有排程还不取消就删",
  // 所以客户端只要还留着那种调用,就等于留了一个永远弹回同一个对话框的死循环。
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const panel = readFileSync(
    join(process.cwd(), "src/components/social/SocialAccountsPanel.tsx"), "utf8",
  );

  // 对话框里唯一会删的分支必须带 true。
  assert.ok(
    panel.includes("removeAccount(account.provider, account, true)"),
    "「取消排程并移除」必须发 cancelScheduled:true",
  );
  // 而且对话框里不能再有 false 的那一条。
  assert.ok(
    !panel.includes("removeAccount(account.provider, account, false)"),
    "对话框不得再有「保留排程但移除账号」——服务端会用 409 schedules_exist 拒绝它",
  );
  // false 仅剩的合法用处:预查确认了 0 条,直接删。
  const zeroAt = panel.indexOf("await removeAccount(provider, account, false)");
  assert.ok(zeroAt > 0, "计数为 0 的直通路径要保留");
  const before = panel.slice(Math.max(0, zeroAt - 700), zeroAt);
  assert.ok(
    before.includes("if (scheduledCount > 0) {") && before.includes("return;"),
    "cancelScheduled:false 只能出现在'确认没有排程'之后",
  );

  // Keep = 关掉对话框,不发请求。
  assert.ok(!panel.includes("onKeep"), "Keep 现在就是 onDismiss,不该再有独立的 onKeep");

  // 503 remove_unavailable 必须有自己的分支:它说的是"什么都没改,过几分钟再试",
  // 而通用失败文案会让商家以为账号可能已经半删了。
  assert.ok(panel.includes('err.code === "remove_unavailable"'),
    "面板必须认得 remove_unavailable,否则 503 会掉进通用失败文案里");
  assert.ok(panel.includes("socialPanel.toast.removeUnavailable"),
    "服务端没给 message 时要有本地化兜底");
});

console.log(`\n${passed} 项断言全部通过。`);
}

main().catch(err => { console.error(err); process.exit(1); });
