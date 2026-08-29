/**
 * test-pin-draft-conditional-write.ts — /api/pin-drafts PUT 的写入必须是条件写
 * (compare-and-set on updated_at),不是无条件 upsert(Codex P0)。
 *
 * 这不是"并发写可能覆盖"的理论担忧,而是一条能让已发布结果消失的具体时序:
 *   1. 客户端 PUT 进来,读到行的 updated_at,判定自己不算过期(LWW 放行);
 *   2. 就在它还在校验排程目的地 / 配额的这段时间里,cron 用 CAS 把
 *      destinationResults 写进去并清掉排程(或者 Remove 用 CAS 取消了排程);
 *   3. 那条早就被放行的 PUT 落地,把整行换成它手上那份更旧的副本 ——
 *      已发布的结果凭空消失,scheduled_at 又回来了 → 重复发帖,或者一条
 *      "已被删除"的排程复活成孤儿。
 * cron 和取消侧各自的 CAS 挡不住这一幕:它们赢下了自己的比赛,然后被一个
 * 事后到达的盲写整行覆盖。所以 LWW 这个判断必须和写入原子地绑在一起。
 *
 * 守住六条:
 *  1. 存在的行走 UPDATE,谓词里必须带 vibepin_user_id + draft_id + 读到的那个
 *     updated_at 原文,并且 .select() 回来数匹配行数 —— 少了最后这条,写入就是盲写。
 *  2. 读到写之间行变了 → 0 行匹配 → 409 stale,并且**这一条 draft 一个字都没写进去**。
 *  3. 不存在的行走 INSERT;撞到 23505(别人抢先建了)→ 同样是 409 stale。
 *  4. 正常路径的行为不变:{applied, skippedStale},LWW 跳过仍然只算 skippedStale。
 *  5. 输掉 CAS 的 draft 不得计费 —— 它并没有排上,收它一次 scheduled_post 是收空气。
 *  6. 409 的 body 必须带 current(payload/updated_at/scheduled_at),客户端要拿它做合并。
 *
 * Run: npx tsx scripts/test-pin-draft-conditional-write.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  OK  ${name}`);
}

const UID = "11111111-1111-4111-8111-111111111111";

// ── 假 Supabase:一张内存表 + 有序调用日志 ──────────────────────────────────
// 顺序和谓词才是本文件的主张。只断言"最后行内容对不对"无法区分
// "条件写赢了" 和 "盲写覆盖了",而那正是这个缺陷的全部内容。

type Row = {
  vibepin_user_id: string;
  draft_id: string;
  payload: Record<string, unknown>;
  updated_at: string | null;
  scheduled_at?: string | null;
  deleted_at?: string | null;
  archived_at?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
};

let table: Row[] = [];
let log: string[] = [];
let meterCalls: string[] = [];
/** 在下一次写入落地之前跑一次的钩子 —— 用它模拟 cron 抢在中间 CAS 写入。 */
let beforeWrite: (() => void) | null = null;
/** 下一次 insert 强制返回 23505(有人抢先建了这一行)。 */
let forceUniqueViolation = false;

function resetDb() {
  table = [];
  log = [];
  meterCalls = [];
  beforeWrite = null;
  forceUniqueViolation = false;
}

type Filter = { op: "eq" | "is" | "in"; col: string; value: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(f => {
    const v = row[f.col] ?? null;
    if (f.op === "eq") return v === f.value;
    if (f.op === "is") return v === f.value;
    return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
  });
}

/** PostgREST 风格的链式 builder,只实现这条路由真正用到的那几个动作。 */
function makeBuilder(tableName: string) {
  const filters: Filter[] = [];
  let mode: "select" | "update" | "insert" | "upsert" = "select";
  let payloadRows: Row[] = [];
  let selectCols = "";

  const runSelect = () => {
    const found = table.filter(r => matches(r, filters));
    const cols = selectCols.split(",").map(c => c.trim()).filter(Boolean);
    const data = found.map(r => {
      if (cols.length === 0) return { ...r };
      const out: Record<string, unknown> = {};
      for (const c of cols) out[c] = r[c] ?? null;
      return out;
    });
    return { data, error: null };
  };

  const runWrite = () => {
    beforeWrite?.();
    beforeWrite = null;
    if (mode === "insert" || mode === "upsert") {
      for (const r of payloadRows) {
        const clash = table.find(t => t.vibepin_user_id === r.vibepin_user_id && t.draft_id === r.draft_id);
        if (clash) {
          if (mode === "insert" || forceUniqueViolation) {
            forceUniqueViolation = false;
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          Object.assign(clash, r);
          continue;
        }
        table.push({ ...r });
      }
      if (forceUniqueViolation) {
        forceUniqueViolation = false;
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      return { data: payloadRows.map(r => ({ ...r })), error: null };
    }
    // update
    const hit = table.filter(r => matches(r, filters));
    for (const r of hit) Object.assign(r, payloadRows[0]);
    return { data: hit.map(r => ({ draft_id: r.draft_id })), error: null };
  };

  const builder: Record<string, unknown> = {};
  const chain = () => builder;

  Object.assign(builder, {
    select(cols?: string) {
      selectCols = cols ?? "";
      if (mode === "update" || mode === "insert" || mode === "upsert") {
        // .update(...).select() —— 这就是"数匹配行数"的那一步。
        const res = runWrite();
        log.push(`${mode}:${tableName}:${describe(filters)}:select`);
        if (res.error) return Promise.resolve(res);
        return Promise.resolve({ data: res.data, error: null });
      }
      log.push(`select:${tableName}:${describe(filters)}:[${selectCols}]`);
      return chain();
    },
    eq(col: string, value: unknown) { filters.push({ op: "eq", col, value }); return chain(); },
    is(col: string, value: unknown) { filters.push({ op: "is", col, value }); return chain(); },
    in(col: string, value: unknown) { filters.push({ op: "in", col, value }); return chain(); },
    order() { return chain(); },
    limit() { return chain(); },
    or() { return chain(); },
    update(vals: Row) { mode = "update"; payloadRows = [vals]; return chain(); },
    insert(vals: Row | Row[]) { mode = "insert"; payloadRows = Array.isArray(vals) ? vals : [vals]; return chain(); },
    upsert(vals: Row | Row[]) { mode = "upsert"; payloadRows = Array.isArray(vals) ? vals : [vals]; return chain(); },
    maybeSingle() {
      const res = runSelect();
      log.push(`select:${tableName}:${describe(filters)}:maybeSingle`);
      return Promise.resolve({ data: res.data[0] ?? null, error: null });
    },
    // 未加 .select() 的写(纯 insert / update)在 await 时才执行。
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      try {
        const res = mode === "select" ? runSelect() : runWrite();
        log.push(`${mode}:${tableName}:${describe(filters)}`);
        resolve(res);
      } catch (e) { reject?.(e); }
    },
  });
  return builder;
}

function describe(filters: Filter[]): string {
  return filters.map(f => `${f.col}${f.op === "is" ? ".is." : "."}${JSON.stringify(f.value)}`).join("&");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (/[\\/]lib[\\/]supabase(\.ts)?$/.test(request) || request === "@/lib/supabase") {
    return { createServerClient: () => ({ from: (t: string) => makeBuilder(t) }) };
  }
  if (/[\\/]server[\\/]authUser(\.ts)?$/.test(request) || request === "@/lib/server/authUser") {
    return { getUserIdFromBearer: async () => UID, getUserIdFromBearerOrCookies: async () => UID };
  }
  if (/[\\/]server[\\/]entitlements(\.ts)?$/.test(request) || request === "@/lib/server/entitlements") {
    return { resolvePlan: async () => "pro" };
  }
  if (/[\\/]server[\\/]usage(\.ts)?$/.test(request) || request === "@/lib/server/usage") {
    return {
      checkAllowance: async () => ({ allowed: true, used: 0, limit: 100 }),
      recordUsage: async (args: { referenceId?: string }) => {
        meterCalls.push(String(args.referenceId));
        return { ok: true };
      },
    };
  }
  // 目的地可用性:这些用例不测它,恒定"都可用"。
  if (/scheduledDestinationsAvailable(\.ts)?$/.test(request)
    || request === "@/lib/server/social/scheduledDestinationsAvailable") {
    return { unavailableScheduleDestinations: async () => [] };
  }
  return originalLoad.call(this, request, parent, isMain);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function putRequest(drafts: Array<{ draftId: string; updatedAt: string; payload: Record<string, unknown> }>): Request {
  return new Request("https://example.com/api/pin-drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify({ drafts }),
  });
}

function draftPayload(id: string, updatedAt: string, patch?: Record<string, unknown>) {
  return {
    id, imageUrl: `https://x/${id}.png`, title: `t-${id}`, description: "d",
    status: "needs_review", createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
    source: "uploaded_image", ...patch,
  } as Record<string, unknown>;
}

function seedRow(id: string, updatedAt: string, patch?: Partial<Row>): Row {
  const row: Row = {
    vibepin_user_id: UID, draft_id: id,
    payload: draftPayload(id, updatedAt),
    updated_at: updatedAt, scheduled_at: null,
    deleted_at: null, archived_at: null, created_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
  table.push(row);
  return row;
}

async function main() {
  const route = await import("../src/app/api/pin-drafts/route");

  // ── 0) 源码契约 ────────────────────────────────────────────────────────────
  console.log("\n=== 0) 源码契约:写入语句本身必须带条件 ===");

  await test("PUT 里不再有无条件 upsert,UPDATE 谓词带 updated_at 且 select 回行数", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "../src/app/api/pin-drafts/route.ts"), "utf8")
      .replace(/\r\n?/g, "\n");
    const put = src.slice(src.indexOf("export async function PUT"), src.indexOf("async function enforceDraftCap"));
    assert.ok(
      !/\.upsert\(/.test(put),
      "PUT 里不得再出现 upsert —— 它无法携带每行不同的 updated_at 谓词,那正是这个缺陷",
    );
    assert.ok(/\.eq\("updated_at", observed\)/.test(put), "UPDATE 必须以读到的 updated_at 为谓词");
    assert.ok(/\.is\("updated_at", null\)/.test(put), "读到 null 时必须用 IS NULL,= NULL 永远不成立");
    assert.ok(/\.eq\("vibepin_user_id", userId\)/.test(put) && /\.eq\("draft_id", draftId\)/.test(put),
      "谓词必须同时锁住用户和 draft,否则会写到别人的行");
    assert.ok(/\.select\("draft_id"\)/.test(put), "必须 select 回来数匹配行数,否则依旧是盲写");
    assert.ok(/23505/.test(src), "INSERT 撞唯一键要能被识别成同一场竞态");
  });

  // ── 1) 正常路径不变 ────────────────────────────────────────────────────────
  console.log("\n=== 1) 正常路径:行为不变 ===");

  await test("新 draft → INSERT,{applied:1, skippedStale:0}", async () => {
    resetDb();
    const res = await route.PUT(putRequest([
      { draftId: "d1", updatedAt: "2026-06-01T00:00:00.000Z", payload: draftPayload("d1", "2026-06-01T00:00:00.000Z") },
    ]));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { applied: 1, skippedStale: 0 });
    assert.equal(table.length, 1);
    assert.ok(log.some(l => l.startsWith("insert:pin_drafts")), "行不存在时走 INSERT");
  });

  await test("已存在的 draft、无人插队 → CAS 命中,行被更新", async () => {
    resetDb();
    seedRow("d1", "2026-06-01T00:00:00.000Z");
    const res = await route.PUT(putRequest([
      { draftId: "d1", updatedAt: "2026-06-02T00:00:00.000Z", payload: draftPayload("d1", "2026-06-02T00:00:00.000Z", { title: "newer" }) },
    ]));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { applied: 1, skippedStale: 0 });
    assert.equal((table[0].payload as { title: string }).title, "newer");
    const upd = log.find(l => l.startsWith("update:pin_drafts"));
    assert.ok(upd, "行存在时走 UPDATE");
    assert.ok(upd!.includes('updated_at."2026-06-01T00:00:00.000Z"'),
      `UPDATE 谓词里必须带读到的 updated_at,实际: ${upd}`);
  });

  await test("LWW:比服务器旧的 PUT 仍然只算 skippedStale(不是 409)", async () => {
    resetDb();
    seedRow("d1", "2026-06-05T00:00:00.000Z");
    const res = await route.PUT(putRequest([
      { draftId: "d1", updatedAt: "2026-06-01T00:00:00.000Z", payload: draftPayload("d1", "2026-06-01T00:00:00.000Z") },
    ]));
    assert.equal(res.status, 200, "LWW 跳过是正常结果,不是冲突");
    assert.deepEqual(await res.json(), { applied: 0, skippedStale: 1 });
    assert.ok(!log.some(l => l.startsWith("update:") || l.startsWith("insert:")), "被 LWW 跳过的 draft 一个字都不该写");
  });

  // ── 2) 竞态:读到写之间行变了 ──────────────────────────────────────────────
  console.log("\n=== 2) 竞态:读到写之间行变了 → 409 stale,什么都不写 ===");

  await test("cron 在读之后 CAS 写入 → PUT 的 CAS 落空 → 409 stale,已发布结果不被抹掉", async () => {
    resetDb();
    const row = seedRow("d1", "2026-06-01T00:00:00.000Z", {
      scheduled_at: "2026-06-10T00:00:00.000Z",
      payload: draftPayload("d1", "2026-06-01T00:00:00.000Z", {
        scheduledDate: "2026-06-10", scheduledTime: "09:00", plannedAt: "2026-06-10T09:00:00.000Z",
      }),
    });
    // 客户端拿的是这行更早的副本,updatedAt 更"新"一点点,足以通过 LWW。
    const clientPayload = draftPayload("d1", "2026-06-02T00:00:00.000Z", {
      scheduledDate: "2026-06-10", scheduledTime: "09:00", plannedAt: "2026-06-10T09:00:00.000Z",
    });
    // cron 抢在写入落地之前:写进 destinationResults 并清掉排程。
    beforeWrite = () => {
      row.updated_at = "2026-06-03T00:00:00.000Z";
      row.scheduled_at = null;
      row.payload = draftPayload("d1", "2026-06-03T00:00:00.000Z", {
        scheduledDate: "", scheduledTime: "", plannedAt: "",
        destinationResults: [{ provider: "pinterest", status: "published", remotePinUrl: "https://pin/1" }],
      });
    };

    const res = await route.PUT(putRequest([
      { draftId: "d1", updatedAt: "2026-06-02T00:00:00.000Z", payload: clientPayload },
    ]));

    assert.equal(res.status, 409, "CAS 落空必须是 409,不能静静地覆盖");
    const body = await res.json() as {
      code?: string; applied?: number;
      current?: { payload?: Record<string, unknown>; updated_at?: string; scheduled_at?: string | null };
      stale?: Array<{ draftId?: string; current?: { payload?: Record<string, unknown> } }>;
    };
    assert.equal(body.code, "stale");
    assert.equal(body.applied, 0);
    assert.equal(body.stale?.[0]?.draftId, "d1");
    // 409 必须带上当前行,客户端要拿它做合并再重试。
    assert.equal(body.current?.updated_at, "2026-06-03T00:00:00.000Z");
    assert.equal(body.current?.scheduled_at, null);
    assert.ok(
      Array.isArray((body.current?.payload as { destinationResults?: unknown[] })?.destinationResults),
      "current 必须带回服务器那份带 destinationResults 的 payload",
    );
    // 最要害的一条:行没有被那份更旧的副本覆盖回去。
    assert.equal(row.updated_at, "2026-06-03T00:00:00.000Z", "cron 写入的 updated_at 必须原样保留");
    assert.equal(row.scheduled_at, null, "被清掉的排程不得复活 —— 复活就是重复发帖");
    assert.ok(
      (row.payload as { destinationResults?: unknown[] }).destinationResults,
      "已发布结果不得被抹掉",
    );
  });

  await test("批内一条冲突不影响另一条:干净的那条照样落库,冲突的那条一个字不写", async () => {
    resetDb();
    const a = seedRow("dA", "2026-06-01T00:00:00.000Z");
    seedRow("dB", "2026-06-01T00:00:00.000Z");
    let fired = false;
    beforeWrite = () => { fired = true; a.updated_at = "2026-06-09T00:00:00.000Z"; };
    // 第一次写(dA)之前把 dA 挪走;dB 的写不受影响。
    const res = await route.PUT(putRequest([
      { draftId: "dA", updatedAt: "2026-06-02T00:00:00.000Z", payload: draftPayload("dA", "2026-06-02T00:00:00.000Z", { title: "A-new" }) },
      { draftId: "dB", updatedAt: "2026-06-02T00:00:00.000Z", payload: draftPayload("dB", "2026-06-02T00:00:00.000Z", { title: "B-new" }) },
    ]));
    assert.ok(fired);
    assert.equal(res.status, 409);
    const body = await res.json() as { applied?: number; stale?: Array<{ draftId?: string }> };
    assert.equal(body.applied, 1, "没冲突的那条是独立的写,不该被同伴的冲突拖下水");
    assert.deepEqual(body.stale?.map(s => s.draftId), ["dA"]);
    assert.equal((table.find(r => r.draft_id === "dA")!.payload as { title: string }).title, "t-dA",
      "冲突那条必须保持服务器的内容");
    assert.equal((table.find(r => r.draft_id === "dB")!.payload as { title: string }).title, "B-new");
  });

  await test("INSERT 撞 23505(别人抢先建了)→ 同样是 409 stale,带 current", async () => {
    resetDb();
    // 读的时候表里没有这行 → 走 INSERT;写之前别人建好了。
    beforeWrite = () => { seedRow("dNew", "2026-06-07T00:00:00.000Z", { payload: draftPayload("dNew", "2026-06-07T00:00:00.000Z", { title: "someone-else" }) }); };
    const res = await route.PUT(putRequest([
      { draftId: "dNew", updatedAt: "2026-06-02T00:00:00.000Z", payload: draftPayload("dNew", "2026-06-02T00:00:00.000Z", { title: "mine" }) },
    ]));
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; current?: { updated_at?: string; payload?: { title?: string } } };
    assert.equal(body.code, "stale");
    assert.equal(body.current?.updated_at, "2026-06-07T00:00:00.000Z");
    assert.equal(table.find(r => r.draft_id === "dNew")!.payload.title, "someone-else",
      "抢先建好的那行不得被我们的 INSERT 覆盖");
  });

  // ── 3) 计费 ────────────────────────────────────────────────────────────────
  console.log("\n=== 3) 计费只跟着真正写进去的行 ===");

  await test("输掉 CAS 的排程 draft 不计 scheduled_post —— 它并没有排上", async () => {
    resetDb();
    const row = seedRow("dS", "2026-06-01T00:00:00.000Z");
    beforeWrite = () => { row.updated_at = "2026-06-09T00:00:00.000Z"; };
    const res = await route.PUT(putRequest([{
      draftId: "dS", updatedAt: "2026-06-02T00:00:00.000Z",
      payload: draftPayload("dS", "2026-06-02T00:00:00.000Z", {
        scheduledDate: "2026-07-01", scheduledTime: "10:00",
      }),
    }]));
    assert.equal(res.status, 409);
    assert.deepEqual(meterCalls, [], "没写进去的排程不得计费 —— 那是在收空气的钱");
  });

  await test("成功排程的 draft 照常计 scheduled_post 一次", async () => {
    resetDb();
    seedRow("dS", "2026-06-01T00:00:00.000Z");
    const res = await route.PUT(putRequest([{
      draftId: "dS", updatedAt: "2026-06-02T00:00:00.000Z",
      payload: draftPayload("dS", "2026-06-02T00:00:00.000Z", {
        scheduledDate: "2026-07-01", scheduledTime: "10:00",
      }),
    }]));
    assert.equal(res.status, 200);
    assert.deepEqual(meterCalls, ["dS"], "写成功的排程仍然要计一次");
  });

  console.log(`\n${passed} passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
