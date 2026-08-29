/**
 * test-schedule-cancel-cas.ts — 取消排程的写入必须是 compare-and-set。
 *
 * 这两个写者(多平台的 scheduledForSocialConnection、Pinterest 的
 * scheduledForConnection)原来都是:读 payload → 在一份**旧副本**上改 → 按
 * user + draft_id 无条件 update。中间商家做的任何事 —— 改文案、改时间、从另一个
 * 标签页多加一个发布目的地 —— 都被整份覆盖掉,而且没有任何地方报错。
 *
 * 它为什么是 P0 而不是"偶尔丢一次编辑":这两个函数的返回值决定了**账号能不能被
 * 删**。一次静默覆盖,商家就在同一个动作里同时失去刚排的内容和发它的账号。
 *
 * 所以本文件断言的是行为,不是源码文本:
 *   1. CAS 未命中 → 重新读 → 在**新** payload 上重算(不是在旧副本上重放)。
 *   2. 并发新增的目的地必须被保留 —— 它只存在于新 payload 里。
 *   3. 三次都未命中 → 一行都不写,计为 failed → 移除路由据此拒绝删除。
 *   4. 行没了 / 当前 payload 已经不指向这个账号 → 无操作的**成功**,不是失败:
 *      要取消的排程本来就不存在了,把它算成失败会挡住一次本来完全安全的移除。
 *
 * Run: npx tsx scripts/test-schedule-cancel-cas.ts   (from web/)
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";

import { cancelScheduledForSocialConnection } from "../src/lib/server/social/scheduledForSocialConnection";
import { cancelScheduledForConnection } from "../src/lib/server/pinterest/scheduledForConnection";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); }
}
function section(t: string) { console.log(`\n=== ${t} ===`); }

const UID = "user-1";
const CONN = "conn-a";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 一个"真会动"的假表。
 *
 * 关键在于它像真数据库一样执行 CAS:update 带着 observed 的
 * scheduled_at/updated_at 作为过滤条件,对不上就一行都不改并返回空数组 —— 也就是
 * 真实 PostgREST 在行被别人改过之后会做的事。用一个只会点数的 mock 是断言不出
 * "未命中之后到底在哪份 payload 上重算"的。
 */
interface FakeRow {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
  scheduled_at: string | null;
  updated_at: string | null;
  publish_claimed_at?: string | null;
}

interface FakeDbOptions {
  /** 每次 update **之前**跑一次,用来模拟"另一个请求刚刚改了这一行"。 */
  beforeUpdate?: (row: FakeRow, updateCount: number) => void;
  /** update 直接返回错误(模拟数据库故障)。 */
  updateError?: string | null;
  /** 重新读时假装行已经不在了。 */
  rereadMissing?: boolean;
}

function makeDb(rows: FakeRow[], opts: FakeDbOptions = {}) {
  const stats = { selects: 0, rereads: 0, updates: 0 };

  function makeSelect(cols: string) {
    const filters: Array<(r: FakeRow) => boolean> = [];
    // 非 null 表示这是一次单行重读(CAS 未命中之后的那一次),而不是候选扫描。
    let limited: number | null = null;
    const chain: any = {
      eq(col: string, val: unknown) {
        if (col === "vibepin_user_id") filters.push(r => r.vibepin_user_id === val);
        else if (col === "draft_id") filters.push(r => r.draft_id === val);
        else if (col === "payload->>targetConnectionId") {
          filters.push(r => (r.payload.targetConnectionId ?? null) === val);
        }
        return chain;
      },
      not() { filters.push(r => r.scheduled_at !== null); return chain; },
      is() { return chain; },
      // CAS 未命中之后的单行重读走 .limit(1) —— 和模块里其它查询同一种链形。
      limit(n: number) { limited = n; stats.rereads++; return chain; },
      then(resolve: (v: unknown) => void) {
        stats.selects++;
        void cols;
        if (limited !== null && opts.rereadMissing) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        // 返回拷贝:调用方拿到的必须是快照而不是活引用,否则"在旧副本上重放"这个
        // 缺陷会被假表本身掩盖掉。
        let hits = rows.filter(r => filters.every(f => f(r))).map(r => structuredClone(r));
        if (limited !== null) hits = hits.slice(0, limited);
        return Promise.resolve({ data: hits, error: null }).then(resolve);
      },
    };
    return chain;
  }

  function makeUpdate(values: Record<string, unknown>) {
    const filters: Array<(r: FakeRow) => boolean> = [];
    const chain: any = {
      eq(col: string, val: unknown) {
        if (col === "vibepin_user_id") filters.push(r => r.vibepin_user_id === val);
        else if (col === "draft_id") filters.push(r => r.draft_id === val);
        else if (col === "scheduled_at") filters.push(r => r.scheduled_at === val);
        else if (col === "updated_at") filters.push(r => r.updated_at === val);
        return chain;
      },
      is(col: string) {
        if (col === "scheduled_at") filters.push(r => r.scheduled_at === null);
        else if (col === "updated_at") filters.push(r => r.updated_at === null);
        return chain;
      },
      select() {
        stats.updates++;
        if (opts.updateError) {
          return Promise.resolve({ data: null, error: { message: opts.updateError } });
        }
        // 并发写入就发生在这里 —— 读之后、写之前的那个窗口。
        for (const r of rows) opts.beforeUpdate?.(r, stats.updates);
        const hits = rows.filter(r => filters.every(f => f(r)));
        for (const r of hits) Object.assign(r, values);
        return Promise.resolve({ data: hits.map(r => ({ draft_id: r.draft_id })), error: null });
      },
    };
    return chain;
  }

  const db = {
    from() {
      return {
        select: (cols: string) => makeSelect(cols),
        update: (values: Record<string, unknown>) => makeUpdate(values),
      };
    },
  };
  return { db, rows, stats };
}

function socialRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    vibepin_user_id: UID,
    draft_id: "d-1",
    payload: {
      updatedAt: "2026-08-01T00:00:00.000Z",
      scheduledDestinations: [
        { provider: "facebook", socialConnectionId: CONN },
        { provider: "pinterest", socialConnectionId: "conn-keep" },
      ],
    },
    scheduled_at: "2026-09-01T10:00:00.123456+00:00",
    updated_at: "2026-08-01T00:00:00.111111+00:00",
    ...over,
  };
}

function pinterestRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    vibepin_user_id: UID,
    draft_id: "d-2",
    payload: {
      updatedAt: "2026-08-01T00:00:00.000Z",
      targetConnectionId: CONN,
      scheduledDate: "2026-09-01",
      scheduledTime: "10:00",
      plannedAt: "2026-09-01T10:00",
    },
    scheduled_at: "2026-09-01T10:00:00.123456+00:00",
    updated_at: "2026-08-01T00:00:00.111111+00:00",
    ...over,
  };
}

async function main() {

section("多平台:未命中后在新 payload 上重算");

await test("并发新增的目的地被保留 —— 重算发生在 NEW payload 上,不是旧副本", async () => {
  const row = socialRow();
  let injected = false;
  const { db, rows, stats } = makeDb([row], {
    beforeUpdate: (r, n) => {
      // 第一次 update 之前,商家在另一个标签页又加了一个 Instagram 目的地,并把
      // 行的 updated_at 推到了新值。第一次写因此必然未命中。
      if (n !== 1 || injected) return;
      injected = true;
      r.payload = {
        ...(r.payload as Record<string, unknown>),
        scheduledDestinations: [
          { provider: "facebook", socialConnectionId: CONN },
          { provider: "pinterest", socialConnectionId: "conn-keep" },
          { provider: "instagram", socialConnectionId: "conn-new" },
        ],
      };
      r.updated_at = "2026-08-02T00:00:00.222222+00:00";
    },
  });

  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.deepEqual(out, { cleared: 1, failed: 0, readFailed: false });
  assert.ok(stats.updates >= 2, "第一次写必须未命中,并且必须重试");
  assert.ok(stats.rereads >= 1, "未命中之后必须真的重新读一次");

  const dests = (rows[0].payload.scheduledDestinations ?? []) as Array<{ socialConnectionId: string }>;
  const ids = dests.map(d => d.socialConnectionId).sort();
  // 这一条就是整个 CAS 的意义:旧副本里根本没有 conn-new,若在旧副本上重放,
  // 商家刚加的那个目的地会被这次取消顺手抹掉。
  assert.deepEqual(ids, ["conn-keep", "conn-new"],
    "并发新增的目的地必须留下,被移除的只能是那个账号自己");
  assert.ok(!ids.includes(CONN), "目标账号的目的地必须被剥掉");
  assert.equal(rows[0].scheduled_at, "2026-09-01T10:00:00.123456+00:00",
    "还有目的地在,就不能把行整个取消排程");
});

await test("最后一个目的地被剥掉时才取消排程并释放认领锁", async () => {
  const row = socialRow({
    payload: {
      updatedAt: "2026-08-01T00:00:00.000Z",
      scheduledDestinations: [{ provider: "facebook", socialConnectionId: CONN }],
    },
    publish_claimed_at: "2026-08-01T00:00:00.000Z",
  });
  const { db, rows } = makeDb([row]);
  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.deepEqual(out, { cleared: 1, failed: 0, readFailed: false });
  assert.equal(rows[0].scheduled_at, null, "没有目的地了就必须掉出 cron 的到期扫描");
  assert.equal(rows[0].publish_claimed_at, null, "陈旧的认领锁必须释放");
});

await test("三次都未命中 → 一行都不写,计为 failed(移除据此拒绝)", async () => {
  const row = socialRow();
  let bump = 0;
  const { db, rows, stats } = makeDb([row], {
    // 每一次写之前这一行都被改一次 —— 活锁,不是可以重试的抖动。
    beforeUpdate: r => { bump++; r.updated_at = `2026-08-02T00:00:0${bump}.900000+00:00`; },
  });
  const before = structuredClone(rows[0].payload);
  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.equal(out.cleared, 0);
  assert.equal(out.failed, 1, "耗尽必须算失败 —— 移除路由靠这个数字拒绝删账号");
  assert.equal(out.readFailed, false);
  assert.deepEqual(rows[0].payload, before, "耗尽之后必须一个字节都没写");
  assert.equal(stats.updates, 3, "有界重试:3 次,不是无限");
});

await test("行在中途被删掉 → 无操作的成功,不是失败", async () => {
  const row = socialRow();
  const { db } = makeDb([row], {
    // 第一次写未命中,重新读时行已经不在了。
    beforeUpdate: (r, n) => { if (n === 1) r.updated_at = "2026-08-05T00:00:00.333333+00:00"; },
    rereadMissing: true,
  });
  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.equal(out.failed, 0, "行没了不是失败 —— 要取消的排程本来就不存在了");
  assert.equal(out.cleared, 0, "也不能算清掉了一条,那会虚报工作量");
});

await test("重读后 payload 已经不指向这个账号 → 无操作的成功", async () => {
  const row = socialRow();
  const { db, rows } = makeDb([row], {
    beforeUpdate: (r, n) => {
      if (n !== 1) return;
      // 另一个请求(或者商家自己)已经把这个目的地去掉了。
      r.payload = {
        ...(r.payload as Record<string, unknown>),
        scheduledDestinations: [{ provider: "pinterest", socialConnectionId: "conn-keep" }],
      };
      r.updated_at = "2026-08-06T00:00:00.444444+00:00";
    },
  });
  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.equal(out.failed, 0, "别人已经做完的事不是我们的失败");
  assert.equal(out.cleared, 0);
  const dests = (rows[0].payload.scheduledDestinations ?? []) as Array<{ socialConnectionId: string }>;
  assert.deepEqual(dests.map(d => d.socialConnectionId), ["conn-keep"],
    "不得把别人留下的目的地再动一次");
});

await test("update 直接报错 → failed,不重试到耗尽", async () => {
  const { db, stats } = makeDb([socialRow()], { updateError: "connection reset" });
  const out = await cancelScheduledForSocialConnection(db as any, UID, CONN);
  assert.equal(out.failed, 1);
  assert.equal(out.cleared, 0);
  assert.equal(stats.updates, 1, "真错误不是 CAS 未命中,不该重试");
});

section("Pinterest:同一条规则");

await test("未命中后在新 payload 上重算,并保留并发编辑", async () => {
  const row = pinterestRow();
  let injected = false;
  const { db, rows, stats } = makeDb([row], {
    beforeUpdate: (r, n) => {
      if (n !== 1 || injected) return;
      injected = true;
      // 商家在取消进行中改了标题。旧副本里没有这个标题。
      r.payload = { ...(r.payload as Record<string, unknown>), title: "商家刚改的标题" };
      r.updated_at = "2026-08-02T00:00:00.222222+00:00";
    },
  });
  const out = await cancelScheduledForConnection(db as any, UID, CONN);
  assert.deepEqual(out, { cleared: 1, failed: 0, readFailed: false });
  assert.ok(stats.updates >= 2, "第一次写必须未命中");
  assert.equal(rows[0].payload.title, "商家刚改的标题",
    "并发编辑必须活下来 —— 取消排程不是把整份草稿换掉");
  assert.equal(rows[0].scheduled_at, null, "Pin 必须掉出到期扫描");
  assert.equal(rows[0].publish_claimed_at, null);
  assert.equal(rows[0].payload.scheduledDate, "");
  assert.equal(rows[0].payload.plannedAt, "");
  assert.equal(rows[0].payload.targetConnectionId, CONN,
    "targetConnectionId 不动:重连之后意图还在");
});

await test("三次都未命中 → 一行都不写,计为 failed", async () => {
  const row = pinterestRow();
  let bump = 0;
  const { db, rows, stats } = makeDb([row], {
    beforeUpdate: r => { bump++; r.updated_at = `2026-08-03T00:00:0${bump}.550000+00:00`; },
  });
  const before = structuredClone(rows[0].payload);
  const out = await cancelScheduledForConnection(db as any, UID, CONN);
  assert.equal(out.cleared, 0);
  assert.equal(out.failed, 1, "耗尽必须算失败");
  assert.equal(stats.updates, 3, "有界重试:3 次");
  assert.deepEqual(rows[0].payload, before, "耗尽之后必须一个字节都没写");
  assert.equal(rows[0].scheduled_at, "2026-09-01T10:00:00.123456+00:00",
    "排程必须原样保留 —— 我们没能取消它,就不能假装取消了");
});

await test("重读后已经指向别的账号 → 无操作,绝不误取消别人的 Pin", async () => {
  const row = pinterestRow();
  const { db, rows } = makeDb([row], {
    beforeUpdate: (r, n) => {
      if (n !== 1) return;
      r.payload = { ...(r.payload as Record<string, unknown>), targetConnectionId: "other-conn" };
      r.updated_at = "2026-08-07T00:00:00.666666+00:00";
    },
  });
  const out = await cancelScheduledForConnection(db as any, UID, CONN);
  assert.equal(out.failed, 0);
  assert.equal(out.cleared, 0);
  assert.equal(rows[0].scheduled_at, "2026-09-01T10:00:00.123456+00:00",
    "这条 Pin 现在属于另一个账号,不能被这次取消动到");
});

section("移除路由据此拒绝(取消与删除是一个决定)");

await test("failed > 0 的取消结果会让 Remove 拒绝删除", async () => {
  // 这是 CAS 耗尽必须计为 failed 的唯一理由:路由把 failed>0 当成"不能删"。
  // 断言那条连线还在 —— 否则耗尽会退化成一次静默的成功删除。
  const { readFileSync } = await import("node:fs");
  const social = readFileSync("src/app/api/social/disconnect/route.ts", "utf8");
  const pin = readFileSync("src/app/api/pinterest/disconnect/route.ts", "utf8");
  assert.ok(/outcome\.readFailed \|\| outcome\.failed > 0/.test(social),
    "多平台路由必须在 failed>0 时拒绝");
  assert.ok(/cancelOutcome\.readFailed \|\| cancelOutcome\.failed > 0/.test(pin),
    "Pinterest 路由必须在 failed>0 时拒绝");
});

await test("两个写者都走共享的 CAS 循环,不是各自的近似复制", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of [
    "src/lib/server/social/scheduledForSocialConnection.ts",
    "src/lib/server/pinterest/scheduledForConnection.ts",
    "src/app/api/cron/publish-due/persistRow.ts",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.ok(/casReadMergeWrite/.test(src), `${f} 必须走共享的 CAS 循环`);
  }
});

  console.log(`\nSchedule cancel CAS: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

void main();
