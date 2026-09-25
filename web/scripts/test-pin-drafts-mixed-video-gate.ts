/**
 * test-pin-drafts-mixed-video-gate.ts — T2 block 2 of the mixed Pinterest+Instagram
 * single-video auto-split (design doc 0924-混合视频草稿自动拆分-技术设计-v0.1.md §2 (b′),
 * §3, Fable ruling 4).
 *
 * The server never splits; it REFUSES:
 *   1. an unsplit mixed single-video draft that carries a schedule →
 *      `mixed_video_requires_split` (retryable:false, per-draft — siblings still write);
 *   2. a scheduled Instagram child whose caption is empty / carries a link →
 *      `instagram_caption_required` / `instagram_caption_contains_link`.
 * An UNSCHEDULED mixed draft saves normally (the merchant is still editing), and
 * the split pair (Pinterest-only parent + Instagram-only child) is accepted. Saving
 * the split pair twice leaves exactly two rows (idempotent on the save path).
 * Also covers block 3's persistence: `copyProfile` / `splitFromDraftId` survive the
 * PUT → GET round trip untouched.
 *
 * Run: npx tsx scripts/test-pin-drafts-mixed-video-gate.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert/strict";
import Module from "node:module";
import { splitMixedVideoDraft } from "../src/lib/studio/splitMixedVideoDraft";
import type { PinDraft } from "../src/lib/pinDraftStore";

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
let writePayloads: Array<Record<string, unknown>> = [];
let meterCalls: string[] = [];
/** Units each quota pre-check asked for (T2 block 4). */
let allowanceAmounts: number[] = [];
let allowanceAllowed = true;
const unavailableDraftIds = new Set<string>();
/** 在下一次写入落地之前跑一次的钩子 —— 用它模拟 cron 抢在中间 CAS 写入。 */
let beforeWrite: (() => void) | null = null;
/** 下一次 insert 强制返回 23505(有人抢先建了这一行)。 */
let forceUniqueViolation = false;
/** 模拟 PostgREST 在写入时发现某个 promoted column 不存在。 */
let missingWriteErrors: Array<{ code: string; message: string }> = [];

function resetDb() {
  table = [];
  log = [];
  writePayloads = [];
  meterCalls = [];
  allowanceAmounts = [];
  allowanceAllowed = true;
  unavailableDraftIds.clear();
  beforeWrite = null;
  forceUniqueViolation = false;
  missingWriteErrors = [];
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
    writePayloads.push(...payloadRows.map(row => ({ ...row })));
    const missingWriteError = missingWriteErrors.shift();
    if (missingWriteError) return { data: null, error: missingWriteError };
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
      checkAllowance: async (_u: string, _t: string, amount: number) => {
        allowanceAmounts.push(amount);
        return { allowed: allowanceAllowed, used: allowanceAllowed ? 0 : 100, limit: 100 };
      },
      recordUsage: async (args: { referenceId?: string }) => {
        meterCalls.push(String(args.referenceId));
        return { ok: true };
      },
    };
  }
  // 目的地可用性:这些用例不测它,恒定"都可用"。
  if (/scheduledDestinationsAvailable(\.ts)?$/.test(request)
    || request === "@/lib/server/social/scheduledDestinationsAvailable") {
    return {
      unavailableScheduleDestinations: async (_userId: string, targets: Array<{ draftId: string }>) =>
        targets.filter(target => unavailableDraftIds.has(target.draftId)).map(target => ({
          draftId: target.draftId,
          provider: "pinterest",
          reason: "disconnected",
        })),
    };
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

const SCHEDULE = {
  scheduledDate: "2026-10-10", scheduledTime: "09:00", plannedAt: "2026-10-10T09:00:00.000Z",
  scheduleTimezone: "UTC",
};
const PIN_DEST = { provider: "pinterest", socialConnectionId: "pin-1", boardId: "board-1", capturedAt: "2026-09-20T00:00:00.000Z" };
const IG_DEST = { provider: "instagram", socialConnectionId: "ig-1", accountLabel: "@shop", capturedAt: "2026-09-20T00:00:00.000Z" };
const VIDEO = { id: "m1", kind: "video", url: "https://x/studio/uploads/u/v1.mp4", source: "upload" };
const CAPTION = "Cozy corner refresh\n\nComment RUG for the link!";

function mixedPayload(id: string, updatedAt: string, patch?: Record<string, unknown>): Record<string, unknown> {
  return {
    id, contentId: id, imageUrl: "https://x/poster.png", media: [VIDEO], coverMediaId: "m1",
    title: "Cozy corner", description: "Pinterest desc", destinationUrl: "https://shop.example/rug",
    boardId: "board-1", status: "ready", createdAt: "2026-09-01T00:00:00.000Z", updatedAt,
    source: "uploaded_image", ...SCHEDULE,
    scheduledDestinations: [PIN_DEST, IG_DEST],
    ...patch,
  };
}

type Outcome = { draftId: string; status: string; code?: string; userMessageKey?: string; retryable: boolean };

async function put(route: { PUT(req: Request): Promise<Response> }, drafts: Array<{ draftId: string; updatedAt: string; payload: Record<string, unknown> }>) {
  const res = await route.PUT(putRequest(drafts));
  const body = await res.json() as { applied: number; outcomes: Outcome[] };
  return { status: res.status, body, byId: new Map(body.outcomes.map(o => [o.draftId, o])) };
}

async function main() {
  const route = await import("../src/app/api/pin-drafts/route");

  console.log("\n=== (b′) server refuses an unsplit mixed single-video schedule ===");

  await test("scheduled mixed single-video → rejected mixed_video_requires_split, nothing written", async () => {
    resetDb();
    const { status, byId } = await put(route, [
      { draftId: "d1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d1", "2026-09-24T00:00:00.000Z") },
    ]);
    assert.equal(status, 200);
    const o = byId.get("d1")!;
    assert.equal(o.status, "rejected");
    assert.equal(o.code, "mixed_video_requires_split");
    assert.equal(o.retryable, false);
    assert.equal(o.userMessageKey, "studioBoard.card.syncIssue.mixedVideoRequiresSplit");
    assert.equal(table.length, 0, "a refused draft is not written");
    assert.equal(meterCalls.length, 0, "a refused schedule is never metered");
  });

  await test("UNSCHEDULED mixed single-video still saves (the merchant is still editing)", async () => {
    resetDb();
    const { byId } = await put(route, [
      { draftId: "d1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d1", "2026-09-24T00:00:00.000Z", { scheduledDate: "", scheduledTime: "", plannedAt: "" }) },
    ]);
    assert.equal(byId.get("d1")!.status, "applied");
    assert.equal(table.length, 1);
  });

  await test("a refused mixed draft never blocks an unrelated sibling in the same batch", async () => {
    resetDb();
    const { byId } = await put(route, [
      { draftId: "d1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d1", "2026-09-24T00:00:00.000Z") },
      { draftId: "d2", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d2", "2026-09-24T00:00:00.000Z", { scheduledDestinations: [PIN_DEST] }) },
    ]);
    assert.equal(byId.get("d1")!.code, "mixed_video_requires_split");
    assert.equal(byId.get("d2")!.status, "applied");
    assert.deepEqual(table.map(r => r.draft_id), ["d2"]);
  });

  await test("mixed IMAGE draft is out of scope (design §4) — still accepted", async () => {
    resetDb();
    const { byId } = await put(route, [
      { draftId: "d1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d1", "2026-09-24T00:00:00.000Z", { media: [{ id: "i1", kind: "image", url: "https://x/i1.png" }] }) },
    ]);
    assert.equal(byId.get("d1")!.status, "applied");
  });

  await test("a stray non-object media entry does not let a mixed video slip past (shared single-video test)", async () => {
    resetDb();
    const { byId } = await put(route, [
      { draftId: "d1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("d1", "2026-09-24T00:00:00.000Z", { media: [VIDEO, null] }) },
    ]);
    assert.equal(byId.get("d1")!.code, "mixed_video_requires_split");
  });

  console.log("\n=== the split pair is accepted, and saving it twice leaves two rows ===");

  const split = () => {
    const r = splitMixedVideoDraft(mixedPayload("d1", "2026-09-24T00:00:00.000Z") as unknown as PinDraft, {
      instagramCaption: CAPTION, now: new Date("2026-09-24T01:00:00.000Z"),
    });
    assert.equal(r.split, true);
    if (!r.split) throw new Error("unreachable");
    return r;
  };

  await test("split parent (Pinterest-only) + child (Instagram-only) both apply", async () => {
    resetDb();
    const { parent, child } = split();
    const { byId } = await put(route, [
      { draftId: parent.id, updatedAt: parent.updatedAt, payload: parent as unknown as Record<string, unknown> },
      { draftId: child.id, updatedAt: child.updatedAt, payload: child as unknown as Record<string, unknown> },
    ]);
    assert.equal(byId.get("d1")!.status, "applied");
    assert.equal(byId.get("d1__ig")!.status, "applied");
    assert.equal(table.length, 2);
  });

  await test("save path idempotency: splitting + saving the same draft twice never makes a third row", async () => {
    resetDb();
    for (let i = 0; i < 2; i++) {
      const { parent, child } = split();
      await put(route, [
        { draftId: parent.id, updatedAt: parent.updatedAt, payload: parent as unknown as Record<string, unknown> },
        { draftId: child.id, updatedAt: child.updatedAt, payload: child as unknown as Record<string, unknown> },
      ]);
      // A second split of the already-split parent is a no-op (no IG destination left).
      assert.equal(splitMixedVideoDraft(parent, { instagramCaption: CAPTION }).split, false);
    }
    assert.deepEqual(table.map(r => r.draft_id).sort(), ["d1", "d1__ig"]);
  });

  await test("block 3 persistence: copyProfile / splitFromDraftId survive PUT → GET", async () => {
    resetDb();
    const { parent, child } = split();
    await put(route, [
      { draftId: parent.id, updatedAt: parent.updatedAt, payload: parent as unknown as Record<string, unknown> },
      { draftId: child.id, updatedAt: child.updatedAt, payload: child as unknown as Record<string, unknown> },
    ]);
    const res = await route.GET(new Request("https://example.com/api/pin-drafts", { headers: { Authorization: "Bearer t" } }));
    const body = await res.json() as { drafts: Array<{ draftId: string; payload: Record<string, unknown> }> };
    const got = new Map(body.drafts.map(d => [d.draftId, d.payload]));
    assert.equal(got.get("d1__ig")!.copyProfile, "instagram_caption");
    assert.equal(got.get("d1__ig")!.splitFromDraftId, "d1");
    assert.equal(got.get("d1__ig")!.description, CAPTION, "the child's description IS the IG caption");
    assert.equal(got.get("d1")!.copyProfile, undefined, "the parent carries no copy profile");
  });

  console.log("\n=== the scheduled IG child's caption is validated with the shared rule ===");

  await test("scheduled child with an EMPTY caption → instagram_caption_required", async () => {
    resetDb();
    const { child } = split();
    const bad = { ...child, description: "   " };
    const { byId } = await put(route, [{ draftId: bad.id, updatedAt: bad.updatedAt, payload: bad as unknown as Record<string, unknown> }]);
    assert.equal(byId.get("d1__ig")!.code, "instagram_caption_required");
    assert.equal(byId.get("d1__ig")!.userMessageKey, "studioBoard.card.syncIssue.instagramCaptionRequired");
    assert.equal(table.length, 0);
  });

  await test("scheduled child whose caption carries a link → instagram_caption_contains_link", async () => {
    resetDb();
    const { child } = split();
    const bad = { ...child, description: "Shop now at cheerish.co" };
    const { byId } = await put(route, [{ draftId: bad.id, updatedAt: bad.updatedAt, payload: bad as unknown as Record<string, unknown> }]);
    assert.equal(byId.get("d1__ig")!.code, "instagram_caption_contains_link");
    assert.equal(byId.get("d1__ig")!.userMessageKey, "studioBoard.card.syncIssue.instagramCaptionContainsLink");
  });

  await test("an `__ig` id is validated as a child even when the copyProfile marker was stripped", async () => {
    resetDb();
    const { child } = split();
    const { copyProfile: _drop, ...stripped } = child;
    void _drop;
    const bad = { ...stripped, description: "" };
    const { byId } = await put(route, [{ draftId: bad.id, updatedAt: bad.updatedAt, payload: bad as unknown as Record<string, unknown> }]);
    assert.equal(byId.get("d1__ig")!.code, "instagram_caption_required");
  });

  await test("an UNSCHEDULED child with an empty caption still saves (still editing)", async () => {
    resetDb();
    const { child } = split();
    const draft = { ...child, description: "", scheduledDate: "", scheduledTime: "", plannedAt: "" };
    const { byId } = await put(route, [{ draftId: draft.id, updatedAt: draft.updatedAt, payload: draft as unknown as Record<string, unknown> }]);
    assert.equal(byId.get("d1__ig")!.status, "applied");
  });

  console.log("\n=== quota pre-check counts a split pair due together as ONE unit (T2 block 4) ===");

  await test("pair saved together at the SAME instant → pre-checked as 1 unit", async () => {
    resetDb();
    const { parent, child } = split();
    await put(route, [
      { draftId: parent.id, updatedAt: parent.updatedAt, payload: parent as unknown as Record<string, unknown> },
      { draftId: child.id, updatedAt: child.updatedAt, payload: child as unknown as Record<string, unknown> },
    ]);
    assert.deepEqual(allowanceAmounts, [1]);
  });

  await test("pair saved together at DIFFERENT instants → 2 units", async () => {
    resetDb();
    const { parent, child } = split();
    const moved = { ...child, scheduledDate: "2026-10-11", plannedAt: "2026-10-11T09:00:00.000Z" };
    await put(route, [
      { draftId: parent.id, updatedAt: parent.updatedAt, payload: parent as unknown as Record<string, unknown> },
      { draftId: moved.id, updatedAt: moved.updatedAt, payload: moved as unknown as Record<string, unknown> },
    ]);
    assert.deepEqual(allowanceAmounts, [2]);
  });

  await test("two unrelated drafts at the same instant stay 2 units", async () => {
    resetDb();
    await put(route, [
      { draftId: "a1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("a1", "2026-09-24T00:00:00.000Z", { scheduledDestinations: [PIN_DEST] }) },
      { draftId: "b1", updatedAt: "2026-09-24T00:00:00.000Z", payload: mixedPayload("b1", "2026-09-24T00:00:00.000Z", { scheduledDestinations: [PIN_DEST] }) },
    ]);
    assert.deepEqual(allowanceAmounts, [2]);
  });

  console.log(`\n${passed} passed`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
