/**
 * Generation route image-metering tests (Phase 4I — SHADOW mode).
 * Run: npx tsx scripts/test-generation-metering.ts   (registered in CORE)
 *
 * Proves the metering wiring in /api/generate WITHOUT a real ledger or DB:
 *   - OFF mode (the default): ZERO ledger calls on every path — production unchanged.
 *   - SHADOW mode: a reserve failure (insufficient balance / RPC error) does NOT block
 *     generation (fail-open, the inverse of the moderation gate).
 *   - Anonymous inline callers and the FastAPI branch NEVER call the ledger.
 *   - A moderation-rejected request NEVER reserves (order proof: reserve sits after
 *     the gate).
 *   - ENFORCE mode returns the ai_image_limit_reached envelope on insufficient balance.
 *   - Module-unit contract of meterGeneration (mode flag, slot keys, request key).
 *
 * Seams (same idiom as test-generation-moderation-gate.ts): child_process.spawn is
 * faked to emit a valid generator result; @/lib/supabase is faked so no real DB is
 * touched; the moderation client is deterministic via MODERATION_MOCK_DECISION; and
 * the ledger RPC surface is intercepted by faking `createServerClient().rpc`.
 *
 * The route reads GENERATION_MODE and USAGE_METERING_MODE at MODULE LOAD, so every
 * runner evicts the route from require.cache and re-imports (tsx's CJS cache is keyed
 * on the resolved path; `?query=` busters do NOT create a new entry —
 * delete require.cache[require.resolve(...)] is what forces re-evaluation).
 */

// Env must be set BEFORE the route module loads.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.CREEM_API_KEY = "creem_test_fake";
process.env.ALLOW_GENERATION_MOCK_PROVIDER = "true";
process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = "true";
// Allow up to 4 images so the partial-settlement test can reserve 4 slots (default
// clamp is 2). This mirrors the route's own hard-cap env (ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4).
process.env.MAX_IMAGES_PER_REQUEST = "4";
process.env.FASTAPI_URL = "http://127.0.0.1:1"; // unroutable → FastAPI probe fails fast

import os from "node:os";
import path from "node:path";
process.env.VIBEPIN_GENERATION_LOCK_DIR = path.join(os.tmpdir(), `vibepin-metering-${Date.now()}`);

export {};

import { Module } from "node:module";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Fake supabase: counts enqueue inserts AND records ledger RPC calls ─────────
type RpcCall = { fn: string; args: Record<string, unknown> };
let rpcCalls: RpcCall[] = [];
let enqueueInsertCount = 0;

// Controls what the ledger RPC returns, so a test can force insufficient/error.
type LedgerMode = "reserve_ok" | "reserve_insufficient" | "reserve_error";
let ledgerMode: LedgerMode = "reserve_ok";

function ledgerResult(fn: string): { data: unknown; error: { message: string; code?: string } | null } {
  if (fn === "usage_ensure_account") {
    return { data: { ok: true, action: "created", account_id: "acct-1" }, error: null };
  }
  if (fn === "usage_reserve_generation_job") {
    if (ledgerMode === "reserve_error") return { data: null, error: { message: "ledger down" } };
    if (ledgerMode === "reserve_insufficient") {
      return { data: { ok: false, reason: "insufficient_capacity", job_id: null, available_recurring: 0, available_bonus: 0 }, error: null };
    }
    return { data: { ok: true, replayed: false, reservation_id: "res-1", job_id: "job-metered-1" }, error: null };
  }
  if (fn === "usage_reserve") {
    if (ledgerMode === "reserve_error") return { data: null, error: { message: "ledger down" } };
    if (ledgerMode === "reserve_insufficient") {
      return { data: { ok: false, reason: "insufficient_capacity", available_recurring: 0, available_bonus: 0 }, error: null };
    }
    return { data: { ok: true, replayed: false, reservation_id: "res-1" }, error: null };
  }
  if (fn === "usage_settle_reservation_item" || fn === "usage_release_reservation") {
    return { data: { ok: true }, error: null };
  }
  return { data: null, error: null };
}

function fakeServerClient() {
  return {
    // ensureUsageAccount → resolvePlan/fetchSignupInstant reach the auth admin API.
    // Return a fresh free user so ensure resolves to a "free" plan and a valid period.
    auth: {
      admin: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getUserById: async (id: string) => ({
          data: { user: { id, email: "u@example.com", created_at: new Date().toISOString(), app_metadata: {} } },
          error: null,
        }),
      },
    },
    from(table: string) {
      return {
        insert(_row: unknown) {
          if (table === "generation_jobs") enqueueInsertCount++;
          return {
            select() {
              return {
                single: async () => ({
                  data: { id: "job_plain", vibepin_user_id: "u", status: "queued", created_at: new Date().toISOString() },
                  error: null,
                }),
              };
            },
          };
        },
        select() {
          // Two consumers of .select():
          //   - generation_worker_status heartbeat lookup (.eq().maybeSingle/single)
          //   - creem_subscriptions grant lookup (.eq().in() → [])
          const chain = {
            eq() {
              return {
                maybeSingle: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
                single: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
                // creem_subscriptions: no active subscription → free plan.
                in: async () => ({ data: [], error: null }),
              };
            },
          };
          return chain;
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return ledgerResult(fn);
    },
  };
}

// ── Fake spawn: emits a valid generator result with `urlCount` urls ────────────
let spawnCount = 0;
let urlCount = 1;
function fakeSpawn() {
  spawnCount++;
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (chunk?: unknown) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdin = { write: () => {}, end: () => {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    const urls = Array.from({ length: urlCount }, (_, i) => `u${i}`);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, urls, keyword: "k", style: "lifestyle" }) + "\n"));
    child.emit("close", 0);
  });
  return child;
}

// ── Module interception ────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "child_process") {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, spawn: fakeSpawn };
  }
  // Match every spelling of the supabase module: the route's "@/lib/supabase", and the
  // RELATIVE "../supabase" / "../../supabase" that lib/server/** (ensureAccount,
  // entitlements) use. Resolving the filename and matching on the tail catches all.
  if (request === "@/lib/supabase" || /(^|[\\/])(\.\.[\\/])*supabase(\.ts)?$/.test(request)) {
    return { createServerClient: fakeServerClient };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ── Rate-limit fake (route consumes image_generation before moderation) ─────────
class FakeLimiterStore {
  rows = new Map<string, { hits: number }>();
  async read() { return null; }
  async create() { return true; }
  async bump() { return true; }
  async prune() {}
}
const rateLimitModule = require("../src/lib/server/rateLimit") as typeof import("../src/lib/server/rateLimit");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
rateLimitModule.__setRateLimitStoreForTests(new FakeLimiterStore() as any);

function fullBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyword: "cozy mug",
    prompt: "a cozy ceramic mug on a table",
    directionBrief: "warm minimal styling",
    category: "home",
    selectedTags: [{ id: "t1", label: "cozy", group: "mood" }],
    prompt_mode: "creative_direction_v2", // requiresFullPayload → generator.py path
    provider_mode: "mock",
    ...extra,
  };
}
function makeReq(body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepin-test-user-id": randomUUID() },
    body: JSON.stringify(body),
  });
}
function makeAnonReq(body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type RunOpts = {
  meterMode?: "off" | "shadow" | "enforce";
  genMode?: "inline" | "worker";
  decision?: string;
  anon?: boolean;
  ledger?: LedgerMode;
  urls?: number;
};

async function run(body: Record<string, unknown>, opts: RunOpts = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const meter = opts.meterMode ?? "off";
  if (meter === "off") delete process.env.USAGE_METERING_MODE;
  else process.env.USAGE_METERING_MODE = meter;
  process.env.GENERATION_MODE = opts.genMode ?? "inline";
  process.env.MODERATION_MOCK_DECISION = opts.decision ?? "allow";
  ledgerMode = opts.ledger ?? "reserve_ok";
  urlCount = opts.urls ?? 1;
  rpcCalls = [];
  enqueueInsertCount = 0;
  spawnCount = 0;
  const anonHeaderWasOn = process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
  if (opts.anon) delete process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
  try {
    delete require.cache[require.resolve("../src/app/api/generate/route")];
    const route = await import(`../src/app/api/generate/route?m=${meter}_${opts.genMode}_${Math.random()}`);
    const req = opts.anon ? makeAnonReq(body) : makeReq(body);
    const res = await route.POST(req as never);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  } finally {
    process.env.GENERATION_MODE = "inline";
    delete process.env.USAGE_METERING_MODE;
    if (anonHeaderWasOn) process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = anonHeaderWasOn;
  }
}

const ledgerCalls = () => rpcCalls.filter(c => c.fn.startsWith("usage_"));
const reserveCalls = () => rpcCalls.filter(c => c.fn === "usage_reserve" || c.fn === "usage_reserve_generation_job");

async function main() {
  console.log("\nGeneration route image-metering tests (Phase 4I shadow)\n");

  // ── Module-unit contract ─────────────────────────────────────────────────────
  const meter = await import("../src/lib/server/usage/meterGeneration");

  await test("UNIT: default mode is off; flag parses shadow/enforce", () => {
    delete process.env.USAGE_METERING_MODE;
    assertEq(meter.usageMeteringMode(), "off", "unset → off");
    assertEq(meter.meteringActive(), false, "off → inactive");
    process.env.USAGE_METERING_MODE = "shadow";
    assertEq(meter.usageMeteringMode(), "shadow", "shadow");
    assertEq(meter.meteringActive(), true, "shadow → active");
    process.env.USAGE_METERING_MODE = "ENFORCE";
    assertEq(meter.usageMeteringMode(), "enforce", "case-insensitive enforce");
    process.env.USAGE_METERING_MODE = "garbage";
    assertEq(meter.usageMeteringMode(), "off", "unknown value → off (safe default)");
    delete process.env.USAGE_METERING_MODE;
  });

  await test("UNIT: slot keys are s0..s{n-1}; length == quantity (matches worker)", () => {
    assertEq(meter.slotKeysForCount(1).join(","), "s0", "one slot");
    assertEq(meter.slotKeysForCount(4).join(","), "s0,s1,s2,s3", "four slots");
    assertEq(meter.slotKeysForCount(0).join(","), "s0", "clamped to at least one");
  });

  await test("UNIT: deriveRequestKey is stable per (user,requestId) and differs across users", () => {
    const a = meter.deriveRequestKey("u1", "gen_x");
    const b = meter.deriveRequestKey("u1", "gen_x");
    const c = meter.deriveRequestKey("u2", "gen_x");
    assertEq(a, b, "same inputs → same key (client retry does not double-reserve)");
    assert(a !== c, "different user → different key");
    assert(!a.includes("gen_x"), "the raw request id is not exposed verbatim in the key");
  });

  await test("UNIT: enforce limit body uses the ai_image_limit_reached envelope", () => {
    const b = meter.aiImageLimitResponseBody("gen_1");
    assertEq(b.code, "ai_image_limit_reached", "code");
    assertEq(b.error_type, "ai_image_limit_reached", "error_type");
    assertEq(b.ok, false, "ok:false");
    assertEq((b.urls as unknown[]).length, 0, "urls empty");
    assertEq(b.generation_request_id, "gen_1", "request id echoed");
  });

  // ── OFF MODE — the default; ZERO ledger calls on every path ───────────────────
  await test("OFF: inline generate makes ZERO ledger calls (unchanged behaviour)", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "off", genMode: "inline" });
    assertEq(status, 200, "status");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
    assertEq(ledgerCalls().length, 0, "no ledger RPC in off mode");
  });

  await test("OFF: worker enqueue makes ZERO ledger calls and uses the plain insert", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "off", genMode: "worker" });
    assertEq(status, 200, "status");
    assert(typeof json.jobId === "string", "jobId returned");
    assertEq(json.jobId, "job_plain", "plain-insert job id (not the metered one)");
    assertEq(enqueueInsertCount, 1, "one plain enqueue insert");
    assertEq(ledgerCalls().length, 0, "no ledger RPC in off mode");
  });

  // ── SHADOW MODE — reserve happens, but failures never block ───────────────────
  await test("SHADOW worker: reserve OK → uses the metered job id, no plain insert", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertEq(json.jobId, "job-metered-1", "returns the metered job id from the RPC");
    assertEq(enqueueInsertCount, 0, "no plain insert when the ledger reserve+enqueue succeeded");
    assert(reserveCalls().some(c => c.fn === "usage_reserve_generation_job"), "reserved via the job RPC");
  });

  await test("SHADOW worker: insufficient balance does NOT block — falls back to plain enqueue", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", ledger: "reserve_insufficient" });
    assertEq(status, 200, "generation still proceeds (fail-open)");
    assertEq(json.jobId, "job_plain", "fell back to the plain enqueue");
    assertEq(enqueueInsertCount, 1, "plain insert used as the fallback");
  });

  await test("SHADOW worker: ledger RPC error does NOT block — falls back to plain enqueue", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", ledger: "reserve_error" });
    assertEq(status, 200, "generation still proceeds despite the ledger error");
    assertEq(json.jobId, "job_plain", "fell back to plain enqueue");
  });

  await test("SHADOW inline: reserve OK → generates, then settles per slot", async () => {
    const { status, json } = await run(fullBody({ count: 2 }), { meterMode: "shadow", genMode: "inline", ledger: "reserve_ok", urls: 2 });
    assertEq(status, 200, "status");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
    const settles = rpcCalls.filter(c => c.fn === "usage_settle_reservation_item");
    assertEq(settles.length, 2, "two slots settled (2 urls returned)");
    assert(settles.every(c => c.args.p_outcome === "succeeded"), "both succeeded");
  });

  await test("SHADOW inline: partial success settles s0 success, remainder terminal_failed", async () => {
    const { status } = await run(fullBody({ count: 4 }), { meterMode: "shadow", genMode: "inline", ledger: "reserve_ok", urls: 2 });
    assertEq(status, 200, "status");
    const settles = rpcCalls.filter(c => c.fn === "usage_settle_reservation_item");
    assertEq(settles.length, 4, "all four reserved slots settled");
    const outcomes = settles.map(c => c.args.p_outcome);
    assertEq(outcomes.filter(o => o === "succeeded").length, 2, "2 succeeded (2 urls)");
    assertEq(outcomes.filter(o => o === "terminal_failed").length, 2, "2 terminal_failed");
  });

  await test("SHADOW inline: reserve error does NOT block and does NOT settle", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "inline", ledger: "reserve_error" });
    assertEq(status, 200, "still generates");
    assertEq(json.ok, true, "ok");
    assertEq(rpcCalls.filter(c => c.fn === "usage_settle_reservation_item").length, 0, "no settle when reserve failed");
  });

  // ── SCOPE — anon and FastAPI never touch the ledger ───────────────────────────
  await test("SCOPE: anonymous inline caller NEVER calls the ledger (no usage account)", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "inline", anon: true });
    assertEq(status, 200, "anonymous inline still generates");
    assertEq(json.ok, true, "ok");
    assertEq(ledgerCalls().length, 0, "anon caller must never touch the ledger");
  });

  await test("SCOPE: FastAPI branch never reserves (fire-and-forget, excluded)", async () => {
    // A minimal body (no CD v2, no images, no styleRef) → requiresFullPayload=false.
    // FastAPI probe fails (dead host) → falls through to inline, which DOES reserve —
    // so to isolate the FastAPI exclusion we assert the reserve is NOT a FastAPI-path
    // reserve: there is no reserve BEFORE the inline dispatch attributable to FastAPI.
    // Simplest robust proof: the FastAPI helper path itself issues zero ledger calls,
    // which holds because the code has no reserve there. We assert via a body that
    // takes FastAPI first and confirm no reserve fires before the (failed) probe by
    // counting: with a dead FastAPI host the request falls to inline and reserves once
    // there, never twice.
    const body = { keyword: "plain keyword", prompt: "", directionBrief: "", category: "", selectedTags: [], provider_mode: "mock" };
    const { status } = await run(body, { meterMode: "shadow", genMode: "inline" });
    assertEq(status, 200, "status");
    // Exactly one reserve (the inline fallback), never an extra FastAPI-path reserve.
    assertEq(reserveCalls().length, 1, "reserve happens once (inline), not on the FastAPI branch");
  });

  // ── ORDER — moderation precedes reserve ───────────────────────────────────────
  await test("ORDER: a moderation-rejected request NEVER reserves", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", decision: "deny" });
    assertEq(status, 400, "rejected");
    assertEq(json.error_type, "prompt_rejected", "prompt_rejected");
    assertEq(reserveCalls().length, 0, "no reserve when moderation rejected (reserve sits after the gate)");
    assertEq(enqueueInsertCount, 0, "and no enqueue");
  });

  await test("ORDER: a moderation-unavailable request NEVER reserves (503)", async () => {
    const { status } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", decision: "timeout" });
    assertEq(status, 503, "moderation unavailable → 503");
    assertEq(reserveCalls().length, 0, "no reserve when moderation failed closed");
  });

  // ── ENFORCE — the branch exists (not enabled in prod) ─────────────────────────
  await test("ENFORCE worker: insufficient balance → 402 ai_image_limit_reached", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_insufficient" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_image_limit_reached", "code");
    assertEq(enqueueInsertCount, 0, "no fallback enqueue in enforce mode");
  });

  await test("ENFORCE inline: insufficient balance → 402, no dispatch", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_insufficient" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_image_limit_reached", "code");
    assertEq(spawnCount, 0, "no generator dispatch when the limit was reached");
  });

  await test("ENFORCE worker: sufficient balance still generates normally", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertEq(json.jobId, "job-metered-1", "metered job id");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  rateLimitModule.__setRateLimitStoreForTests(null);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
