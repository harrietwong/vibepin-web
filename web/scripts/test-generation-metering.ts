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
process.env.GENERATION_INTENT_KEY_SALT = "test-stable-generation-intent-salt";
process.env.CREEM_API_KEY = "creem_test_fake";
process.env.ALLOW_GENERATION_MOCK_PROVIDER = "true";
process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = "true";
// Exercise the production default capacity contract. Individual deployments may
// lower MAX_IMAGES_PER_REQUEST, but an unset env must accept the UI's count=4.
delete process.env.MAX_IMAGES_PER_REQUEST;
delete process.env.ALLOW_MAX_IMAGES_PER_REQUEST_OVER_4;
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
let enqueuedRows: Array<Record<string, unknown>> = [];
let jobsByIntent = new Map<string, Record<string, unknown>>();
let workerHealthy = true;

// Controls what the ledger RPC returns, so a test can force insufficient/error.
// "reserve_insufficient_no_availability" mirrors an older/partial RPC payload that
// omits available_recurring/available_bonus entirely (decision #6, 2026-08-28: the
// route must still respond with nulls, not throw or leave the keys undefined).
type LedgerMode =
  | "reserve_ok"
  | "reserve_replay"
  | "reserve_conflict"
  | "reserve_insufficient"
  | "reserve_insufficient_no_availability"
  | "reserve_error"
  | "ensure_error";
let ledgerMode: LedgerMode = "reserve_ok";
// Users whose fake auth record carries app_metadata.plan = "pro" (resolvePlan's trusted
// cache path), so the REAL resolvePlan resolves them as a paid plan.
const proUsers = new Set<string>();

function ledgerResult(fn: string, args: Record<string, unknown>): { data: unknown; error: { message: string; code?: string } | null } {
  const intentMapKey = `${String(args.p_user_id)}:${String(args.p_intent_key)}`;
  const fingerprint = String(args.p_intent_fingerprint ?? "");
  if (fn === "generation_lookup_job_by_intent") {
    const existing = jobsByIntent.get(intentMapKey);
    if (!existing) return { data: { found: false }, error: null };
    if (existing.generation_intent_fingerprint !== fingerprint) {
      return { data: null, error: { message: "generation intent conflict", code: "23505" } };
    }
    return { data: {
      found: true, replayed: true, job_id: existing.id,
      job_status: existing.status, job_results: existing.results,
      reservation_id: existing.usage_reservation_id ?? null,
    }, error: null };
  }
  if (fn === "generation_enqueue_job_idempotent") {
    const existing = jobsByIntent.get(intentMapKey);
    if (existing) {
      if (existing.generation_intent_fingerprint !== fingerprint) {
        return { data: null, error: { message: "generation intent conflict", code: "23505" } };
      }
      return { data: {
        ok: true, replayed: true, job_id: existing.id,
        job_status: existing.status, job_results: existing.results,
      }, error: null };
    }
    enqueueInsertCount++;
    const slotKeys = args.p_slot_keys as string[];
    const results = slotKeys.map((_, slot) => ({ slot, status: "pending", imageUrl: null, error: null }));
    const stored = {
      id: jobsByIntent.size === 0 ? "job_plain" : `job_plain_${jobsByIntent.size + 1}`,
      vibepin_user_id: args.p_user_id,
      generation_intent_key: args.p_intent_key,
      generation_intent_fingerprint: fingerprint,
      status: "queued", results, params: args.p_params,
    };
    jobsByIntent.set(intentMapKey, stored);
    enqueuedRows.push(stored);
    return { data: { ok: true, replayed: false, job_id: stored.id, job_status: "queued", job_results: results }, error: null };
  }
  if (fn === "usage_ensure_account") {
    if (ledgerMode === "ensure_error") return { data: null, error: { message: "ensure down" } };
    return { data: { ok: true, action: "created", account_id: "acct-1" }, error: null };
  }
  if (fn === "usage_reserve_generation_job_v2") {
    if (ledgerMode === "reserve_error") return { data: null, error: { message: "ledger down" } };
    if (ledgerMode === "reserve_conflict") return { data: null, error: { message: "generation intent conflict", code: "23505" } };
    if (ledgerMode === "reserve_replay") {
      return {
        data: {
          ok: true,
          replayed: true,
          reservation_id: "res-1",
          job_id: "job-metered-1",
          job_status: "done",
          job_results: [{ slot: 0, status: "done", imageUrl: "https://example.test/replayed.png", error: null }],
        },
        error: null,
      };
    }
    if (ledgerMode === "reserve_insufficient") {
      return { data: { ok: false, reason: "insufficient_capacity", job_id: null, available_recurring: 0, available_bonus: 0 }, error: null };
    }
    if (ledgerMode === "reserve_insufficient_no_availability") {
      return { data: { ok: false, reason: "insufficient_capacity", job_id: null }, error: null };
    }
    const slotKeys = args.p_slot_keys as string[];
    const results = slotKeys.map((_, slot) => ({ slot, status: "pending", imageUrl: null, error: null }));
    const stored = {
      id: "job-metered-1", vibepin_user_id: args.p_user_id,
      generation_intent_key: args.p_intent_key,
      generation_intent_fingerprint: fingerprint,
      status: "queued", results, params: args.p_params, usage_reservation_id: "res-1",
    };
    jobsByIntent.set(intentMapKey, stored);
    return { data: { ok: true, replayed: false, reservation_id: "res-1", job_id: stored.id, job_status: "queued", job_results: results }, error: null };
  }
  if (fn === "usage_reserve") {
    if (ledgerMode === "reserve_error") return { data: null, error: { message: "ledger down" } };
    if (ledgerMode === "reserve_insufficient") {
      return { data: { ok: false, reason: "insufficient_capacity", available_recurring: 0, available_bonus: 0 }, error: null };
    }
    if (ledgerMode === "reserve_insufficient_no_availability") {
      return { data: { ok: false, reason: "insufficient_capacity" }, error: null };
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
          data: { user: { id, email: "u@example.com", created_at: new Date().toISOString(), app_metadata: proUsers.has(id) ? { plan: "pro" } : {} } },
          error: null,
        }),
      },
    },
    from(table: string) {
      return {
        insert(_row: unknown) {
          return {
            select() {
              return {
                single: async () => {
                  if (table !== "generation_jobs") return { data: null, error: null };
                  enqueueInsertCount++;
                  const row = _row as Record<string, unknown>;
                  enqueuedRows.push(row);
                  const mapKey = `${String(row.vibepin_user_id)}:${String(row.generation_intent_key)}`;
                  const existing = jobsByIntent.get(mapKey);
                  if (existing) {
                    return { data: null, error: { message: "duplicate key", code: "23505" } };
                  }
                  const stored = {
                    ...row,
                    id: jobsByIntent.size === 0 ? "job_plain" : `job_plain_${jobsByIntent.size + 1}`,
                    created_at: new Date().toISOString(),
                  };
                  jobsByIntent.set(mapKey, stored);
                  return { data: stored, error: null };
                },
              };
            },
          };
        },
        select() {
          // Three consumers of .select():
          //   - generation_worker_status heartbeat lookup (.eq().maybeSingle/single)
          //   - creem_subscriptions grant lookup (.eq().in() → [])
          //   - usage_accounts availability readback (.eq().maybeSingle) — decision #11
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(field: string, value: unknown) { filters[field] = value; return chain; },
            maybeSingle: async () => {
              if (table === "generation_jobs") {
                const mapKey = `${String(filters.vibepin_user_id)}:${String(filters.generation_intent_key)}`;
                return { data: jobsByIntent.get(mapKey) ?? null, error: null };
              }
              if (table === "usage_accounts") {
                return { data: { ai_images_used: 10, ai_images_limit: 100, ai_images_reserved: 5 }, error: null };
              }
              return { data: { name: "generation-worker", last_seen: workerHealthy ? new Date().toISOString() : "2000-01-01T00:00:00.000Z" }, error: null };
            },
            single: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
            // creem_subscriptions: no active subscription → free plan.
            in: async () => ({ data: [], error: null }),
          };
          return chain;
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return ledgerResult(fn, args);
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
    const urls = Array.from({ length: urlCount }, (_, i) => `https://example.test/generated/${i}.png`);
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
// The harness intentionally needs the CommonJS cache seam before dynamically
// importing the route under test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
function makeReq(body: Record<string, unknown>, userId = randomUUID()): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepin-test-user-id": userId },
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
  // Per-type enforce switch (decision #8, 2026-08-28). Defaults to ON so every
  // pre-existing "ENFORCE ... -> 402" case below keeps asserting the blocking path
  // unchanged; pass `false` to prove enforce-mode WITHOUT the flag does not block.
  enforceAiImages?: boolean;
  preserveJobs?: boolean;
  userId?: string;
  workerHealthy?: boolean;
};

async function run(body: Record<string, unknown>, opts: RunOpts = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const meter = opts.meterMode ?? "off";
  if (meter === "off") delete process.env.USAGE_METERING_MODE;
  else process.env.USAGE_METERING_MODE = meter;
  if (opts.enforceAiImages === false) delete process.env.USAGE_ENFORCE_AI_IMAGES;
  else process.env.USAGE_ENFORCE_AI_IMAGES = "true";
  process.env.GENERATION_MODE = opts.genMode ?? "inline";
  process.env.MODERATION_MOCK_DECISION = opts.decision ?? "allow";
  ledgerMode = opts.ledger ?? "reserve_ok";
  urlCount = opts.urls ?? 1;
  rpcCalls = [];
  enqueueInsertCount = 0;
  enqueuedRows = [];
  if (!opts.preserveJobs) jobsByIntent = new Map();
  spawnCount = 0;
  workerHealthy = opts.workerHealthy !== false;
  const anonHeaderWasOn = process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
  if (opts.anon) delete process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
  try {
    delete require.cache[require.resolve("../src/app/api/generate/route")];
    const route = await import(`../src/app/api/generate/route?m=${meter}_${opts.genMode}_${Math.random()}`);
    const req = opts.anon ? makeAnonReq(body) : makeReq(body, opts.userId as `${string}-${string}-${string}-${string}-${string}` | undefined);
    const res = await route.POST(req as never);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  } finally {
    process.env.GENERATION_MODE = "inline";
    delete process.env.USAGE_METERING_MODE;
    delete process.env.USAGE_ENFORCE_AI_IMAGES;
    if (anonHeaderWasOn) process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = anonHeaderWasOn;
  }
}

const ledgerCalls = () => rpcCalls.filter(c => c.fn.startsWith("usage_"));
const reserveCalls = () => rpcCalls.filter(c => c.fn === "usage_reserve" || c.fn === "usage_reserve_generation_job_v2");

async function main() {
  console.log("\nGeneration route image-metering tests (Phase 4I shadow)\n");

  // ── Module-unit contract ─────────────────────────────────────────────────────
  const meter = await import("../src/lib/server/usage/meterGeneration");
  const intentFingerprint = await import("../src/lib/server/generationIntent");

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

  await test("UNIT: a THROWING reserve RPC resolves to kind:error (worker + inline), never rejects", async () => {
    process.env.USAGE_METERING_MODE = "enforce";
    const throwingRpc = async () => { throw new Error("socket hang up"); };
    const ensure = async () => ({}) as never;
    const worker = await meter.reserveGenerationJobViaLedger({
      userId: "u-throw",
      count: 1,
      generationRequestId: "req-throw",
      intentKey: "a".repeat(48),
      intentFingerprint: "b".repeat(64),
      params: {},
      deps: { rpc: throwingRpc, ensure },
    });
    assertEq(worker.kind, "error", "worker reserve transport throw → error (caller policy applies, not a 500)");
    const inline = await meter.reserveInline({
      userId: "u-throw",
      count: 1,
      generationRequestId: "req-throw",
      deps: { rpc: throwingRpc, ensure },
    });
    assertEq(inline.kind, "error", "inline reserve transport throw → error");
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

  // ── Product decision #6 (2026-08-28): the 402 body must carry availability ────
  await test("UNIT: enforce limit body WITHOUT availability omits the availability fields' values (undefined)", () => {
    const b = meter.aiImageLimitResponseBody("gen_1");
    assertEq(b.available_recurring, undefined, "no availability arg → no available_recurring key set");
    assertEq(b.available_bonus, undefined, "no availability arg → no available_bonus key set");
    assertEq(b.requested, undefined, "no availability arg → no requested key set");
  });

  await test("UNIT: enforce limit body WITH availability carries available_recurring/available_bonus/requested", () => {
    const b = meter.aiImageLimitResponseBody("gen_1", { availableRecurring: 3, availableBonus: 2, requested: 5 });
    assertEq(b.available_recurring, 3, "available_recurring");
    assertEq(b.available_bonus, 2, "available_bonus");
    assertEq(b.requested, 5, "requested");
    // Existing keys are unchanged when availability is also passed.
    assertEq(b.code, "ai_image_limit_reached", "code unchanged");
    assertEq(b.error_type, "ai_image_limit_reached", "error_type unchanged");
    assertEq(b.ok, false, "ok:false unchanged");
    assertEq((b.urls as unknown[]).length, 0, "urls empty unchanged");
    assertEq(b.generation_request_id, "gen_1", "request id echoed unchanged");
  });

  await test("UNIT: enforce limit body WITH availability but null recurring/bonus keeps the keys present as null", () => {
    const b = meter.aiImageLimitResponseBody("gen_1", { availableRecurring: null, availableBonus: null, requested: 1 });
    assertEq(b.available_recurring, null, "available_recurring null (unknown), key still present");
    assertEq(b.available_bonus, null, "available_bonus null (unknown), key still present");
    assertEq(b.requested, 1, "requested");
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

  await test("UNIT: durable intent key is stable across service-role rotation", () => {
    const savedService = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const before = meter.deriveDurableGenerationIntentKey("u1", "gen_x");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "rotated-service-key";
    const after = meter.deriveDurableGenerationIntentKey("u1", "gen_x");
    process.env.SUPABASE_SERVICE_ROLE_KEY = savedService;
    assertEq(after, before, "service credential rotation must not alter a durable intent key");
  });

  await test("UNIT: durable intent salt missing/blank fails closed", () => {
    const saved = process.env.GENERATION_INTENT_KEY_SALT;
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.GENERATION_INTENT_KEY_SALT;
      else process.env.GENERATION_INTENT_KEY_SALT = value;
      let threw = false;
      try {
        meter.deriveDurableGenerationIntentKey("u1", "gen_x");
      } catch (error) {
        threw = error instanceof meter.GenerationIntentSaltUnavailableError;
      }
      assert(threw, `salt ${JSON.stringify(value)} must fail closed`);
    }
    process.env.GENERATION_INTENT_KEY_SALT = saved;
  });

  await test("UNIT: immutable fingerprint is canonical by object-key order and ignores undefined optionals", () => {
    const left = intentFingerprint.deriveGenerationIntentFingerprint(2, {
      prompt: "same", nested: { b: 2, a: 1 }, optional: undefined,
    });
    const right = intentFingerprint.deriveGenerationIntentFingerprint(2, {
      nested: { a: 1, b: 2 }, prompt: "same",
    });
    assertEq(left, right, "logical request must have one fingerprint");
    assert(/^[0-9a-f]{64}$/.test(left), "fingerprint must be a 64-hex digest");
  });

  await test("CAPACITY: real route defaults to four slots per reference and hard-clamps larger requests", async () => {
    const first = await run(fullBody({ count: 4, generationRequestId: "capacity-a" }), {
      meterMode: "off", genMode: "worker",
    });
    assertEq(first.status, 200, "count=4 status");
    assertEq(first.json.slots, 4, "the default route must expose all four UI-requested slots");
    assertEq(enqueuedRows.length, 1, "one real route enqueue");
    const firstParams = enqueuedRows[0].params as Record<string, unknown>;
    assertEq(firstParams.count, 4, "worker params keep count=4");
    assertEq(firstParams.actualImageCount, 4, "worker params record actual count=4");
    assertEq(firstParams.countClamped, false, "a valid UI count=4 is not clamped");

    const oversized = await run(fullBody({ count: 8, generationRequestId: "capacity-b" }), {
      meterMode: "off", genMode: "worker",
    });
    assertEq(oversized.status, 200, "oversized status");
    assertEq(oversized.json.slots, 4, "the default server hard cap remains four");
    assertEq(enqueuedRows.length, 1, "one enqueue for the oversized request");
    const oversizedParams = enqueuedRows[0].params as Record<string, unknown>;
    assertEq(oversizedParams.count, 4, "oversized worker params are hard-clamped");
    assertEq(oversizedParams.requestedImageCount, 8, "original requested count remains auditable");
    assertEq(oversizedParams.actualImageCount, 4, "actual count records the hard cap");
    assertEq(oversizedParams.countClamped, true, "hard-cap clamp is explicit");
  });

  // ── P0 durable intent: replay precedes every fresh-request gate ──────────────
  await test("INTENT: exact replay survives mode transition, unhealthy worker, and denied moderation", async () => {
    const userId = "00000000-0000-4000-8000-000000000071";
    const body = fullBody({ count: 2, generationRequestId: "stable-group-0", generation_intent_version: 1 });
    const first = await run(body, { meterMode: "off", genMode: "worker", userId });
    assertEq(first.status, 200, "fresh enqueue status");
    const originalJob = first.json.jobId;

    const replay = await run(body, {
      meterMode: "enforce", genMode: "worker", userId, preserveJobs: true,
      workerHealthy: false, decision: "deny", ledger: "reserve_insufficient",
    });
    assertEq(replay.status, 200, "replay bypasses fresh-request gates");
    assertEq(replay.json.jobId, originalJob, "original job returned");
    assertEq(replay.json.replayed, true, "response marks replay");
    assertEq(enqueueInsertCount, 0, "no second enqueue");
    assertEq(reserveCalls().length, 0, "no second reservation");
  });

  await test("INTENT: changed immutable count/prompt/product/ref/model/format/retry target returns 409", async () => {
    const userId = "00000000-0000-4000-8000-000000000072";
    const base = fullBody({ count: 2, generationRequestId: "immutable-group-0", generation_intent_version: 1 });
    const created = await run(base, { meterMode: "off", genMode: "worker", userId });
    assertEq(created.status, 200, "fixture created");
    const mutations: Array<Record<string, unknown>> = [
      { count: 3 },
      { prompt: "changed prompt" },
      { product_images: ["https://example.test/product.png"] },
      { style_ref: "https://example.test/reference.png" },
      { model_key: "gpt_image" },
      { format: "square 1:1" },
      { mode: "retry_single_output", retryOfOutputId: "output-other", retryOutputIndex: 1 },
    ];
    for (const mutation of mutations) {
      const replay = await run({ ...base, ...mutation }, {
        meterMode: "shadow", genMode: "worker", userId, preserveJobs: true,
      });
      assertEq(replay.status, 409, `immutable mutation ${Object.keys(mutation).join(",")} must conflict`);
      assertEq(enqueueInsertCount, 0, "conflict writes no job");
      assertEq(reserveCalls().length, 0, "conflict writes no reservation");
    }
  });

  await test("INTENT: queued/running/done/partial/failed all replay the original lifecycle", async () => {
    const userId = "00000000-0000-4000-8000-000000000073";
    const body = fullBody({ generationRequestId: "lifecycle-group-0", generation_intent_version: 1 });
    await run(body, { meterMode: "off", genMode: "worker", userId });
    const stored = Array.from(jobsByIntent.values())[0];
    for (const status of ["queued", "running", "done", "partial", "failed"]) {
      stored.status = status;
      const replay = await run(body, {
        meterMode: "enforce", genMode: "worker", userId, preserveJobs: true,
        workerHealthy: false, decision: "timeout", ledger: "reserve_insufficient",
      });
      assertEq(replay.status, 200, `${status} replay status`);
      assertEq(replay.json.status, status, `${status} preserved`);
      assertEq(replay.json.replayed, true, `${status} marked replay`);
    }
  });

  await test("INTENT: same client id is isolated by user; a new group key creates new work", async () => {
    const request = fullBody({ generationRequestId: "shared-client-id", generation_intent_version: 1 });
    const a = await run(request, { genMode: "worker", userId: "00000000-0000-4000-8000-000000000074" });
    const b = await run(request, { genMode: "worker", userId: "00000000-0000-4000-8000-000000000075", preserveJobs: true });
    const c = await run({ ...request, generationRequestId: "shared-client-id-g1" }, {
      genMode: "worker", userId: "00000000-0000-4000-8000-000000000074", preserveJobs: true,
    });
    assert(a.json.jobId !== b.json.jobId, "cross-user intent must not collide");
    assert(a.json.jobId !== c.json.jobId, "different group intent must not collide");
    assertEq(jobsByIntent.size, 3, "three independent anchors");
  });

  await test("INTENT: durable Create Pin request fails closed outside worker mode", async () => {
    const result = await run(fullBody({ generation_intent_version: 1, generationRequestId: "worker-only-g0" }), { genMode: "inline" });
    assertEq(result.status, 503, "inline durable request refused");
    assertEq(result.json.error, "durable_generation_requires_worker", "fixed refusal code");
    assertEq(spawnCount, 0, "no inline provider call");
  });

  // ── SHADOW MODE — reserve happens, but failures never block ───────────────────
  await test("SHADOW worker: reserve OK → uses the metered job id, no plain insert", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "shadow", genMode: "worker", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertEq(json.jobId, "job-metered-1", "returns the metered job id from the RPC");
    assertEq(enqueueInsertCount, 0, "no plain insert when the ledger reserve+enqueue succeeded");
    assert(reserveCalls().some(c => c.fn === "usage_reserve_generation_job_v2"), "reserved via the v2 job RPC");
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
    // Product decision #6 (2026-08-28): the fake RPC's insufficient payload carries
    // available_recurring: 0, available_bonus: 0 — the route must forward them verbatim.
    assertEq(json.available_recurring, 0, "available_recurring forwarded from the ledger RPC");
    assertEq(json.available_bonus, 0, "available_bonus forwarded from the ledger RPC");
    assertEq(json.requested, 4, "requested echoes the slot count asked for (default count=4)");
  });

  await test("ENFORCE inline: insufficient balance → 402, no dispatch", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_insufficient" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_image_limit_reached", "code");
    assertEq(spawnCount, 0, "no generator dispatch when the limit was reached");
    assertEq(json.available_recurring, 0, "available_recurring forwarded from the ledger RPC");
    assertEq(json.available_bonus, 0, "available_bonus forwarded from the ledger RPC");
    assertEq(json.requested, 4, "requested echoes the slot count asked for (default count=4)");
  });

  await test("ENFORCE worker: insufficient balance with NO availability in the RPC payload → nulls, not undefined", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_insufficient_no_availability" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_image_limit_reached", "code");
    assertEq(json.available_recurring, null, "missing RPC field → null (not undefined)");
    assertEq(json.available_bonus, null, "missing RPC field → null (not undefined)");
    assertEq(json.requested, 4, "requested is still echoed from the route's own count, independent of the RPC payload");
  });

  await test("ENFORCE inline: insufficient balance with NO availability in the RPC payload → nulls, not undefined", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_insufficient_no_availability" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_image_limit_reached", "code");
    assertEq(json.available_recurring, null, "missing RPC field → null (not undefined)");
    assertEq(json.available_bonus, null, "missing RPC field → null (not undefined)");
    assertEq(json.requested, 4, "requested is still echoed from the route's own count, independent of the RPC payload");
  });

  await test("ENFORCE worker: sufficient balance still generates normally", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertEq(json.jobId, "job-metered-1", "metered job id");
  });

  // ── PER-TYPE ENFORCE SWITCH (decision #8, 2026-08-28) ─ the global mode alone
  // blocks nothing until USAGE_ENFORCE_AI_IMAGES is also set ─────────────────
  await test("ENFORCE worker WITHOUT USAGE_ENFORCE_AI_IMAGES: insufficient balance does NOT block", async () => {
    const { status, json } = await run(fullBody(), {
      meterMode: "enforce", genMode: "worker", ledger: "reserve_insufficient", enforceAiImages: false,
    });
    assertEq(status, 200, "generation still proceeds — the global mode alone does not block");
    assertEq(json.jobId, "job_plain", "fell back to the plain enqueue, same as shadow");
  });

  await test("ENFORCE inline WITHOUT USAGE_ENFORCE_AI_IMAGES: insufficient balance does NOT block", async () => {
    const { status, json } = await run(fullBody(), {
      meterMode: "enforce", genMode: "inline", ledger: "reserve_insufficient", enforceAiImages: false,
    });
    assertEq(status, 200, "generation still proceeds — the global mode alone does not block");
    assertEq(json.ok, true, "ok");
  });

  // ── Decision #11 (2026-08-28): the metered enqueue response carries a usage block ─
  await test("SHADOW worker: reserved response includes usage.reserved and usage.availableAfterReservation", async () => {
    const { status, json } = await run(fullBody({ count: 1 }), { meterMode: "shadow", genMode: "worker", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    const usage = json.usage as Record<string, unknown> | undefined;
    assert(!!usage && typeof usage === "object", "usage object present on the metered response");
    assertEq(usage!.reserved, 1, "reserved echoes the slot count");
    assertEq(usage!.availableAfterReservation, 85, "computed from usage_accounts: limit 100 - used 10 - reserved 5");
  });

  await test("OFF worker: the plain enqueue response has NO usage field (unmetered path unchanged)", async () => {
    const { json } = await run(fullBody(), { meterMode: "off", genMode: "worker" });
    assertEq(json.usage, undefined, "off mode: byte-for-byte unchanged, no usage field");
  });

  // ── ENFORCE + LEDGER CANNOT ANSWER (decision 2026-09-25) ─────────────────────
  // enforce + USAGE_ENFORCE_AI_IMAGES on, reserve returns error/skipped:
  // free (or unresolvable) plan → 503 usage_unavailable, nothing dispatched;
  // paid plan → proceeds unmetered.
  const FREE_USER = "00000000-0000-4000-8000-0000000000f1";
  const PRO_USER = "00000000-0000-4000-8000-0000000000f2";
  proUsers.add(PRO_USER);

  await test("ENFORCE-UNAVAILABLE worker: RPC error + free plan → 503 usage_unavailable, ZERO enqueue", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_error", userId: FREE_USER });
    assertEq(status, 503, "free user refused when the ledger cannot answer");
    assertEq(json.code, "usage_unavailable", "code");
    assertEq(json.error_type, "usage_unavailable", "error_type");
    assertEq(json.ok, false, "ok:false");
    assert(Array.isArray(json.urls) && (json.urls as unknown[]).length === 0, "urls: [] (image envelope)");
    assert(typeof json.generation_request_id === "string", "request id echoed");
    assert(typeof json.error === "string" && (json.error as string).length > 0, "prose in error");
    assertEq(enqueueInsertCount, 0, "no plain enqueue fallback");
    assertEq(jobsByIntent.size, 0, "no job row written");
  });

  await test("ENFORCE-UNAVAILABLE worker: RPC error + pro plan → proceeds via the plain (unmetered) enqueue", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_error", userId: PRO_USER });
    assertEq(status, 200, "paid plan keeps generating");
    assertEq(json.jobId, "job_plain", "plain enqueue");
    assertEq(enqueueInsertCount, 1, "exactly one plain enqueue");
    assertEq(json.usage, undefined, "unmetered response carries no usage block");
  });

  await test("ENFORCE-UNAVAILABLE worker: ensure failure + free plan → 503, ZERO enqueue", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "ensure_error", userId: FREE_USER });
    assertEq(status, 503, "ensure failure is 'ledger cannot answer'");
    assertEq(json.code, "usage_unavailable", "code");
    assertEq(enqueueInsertCount, 0, "no enqueue");
    assertEq(reserveCalls().length, 0, "reserve RPC never reached after ensure failed");
  });

  await test("ENFORCE-UNAVAILABLE worker: plan lookup THROWS → treated as free → 503 (even for a paid user)", async () => {
    meter.__setLedgerUnavailableResolvePlanForTests(async () => { throw new Error("plan lookup down"); });
    try {
      const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_error", userId: PRO_USER });
      assertEq(status, 503, "unresolvable plan is refused");
      assertEq(json.code, "usage_unavailable", "code");
      assertEq(enqueueInsertCount, 0, "no enqueue");
    } finally {
      meter.__setLedgerUnavailableResolvePlanForTests(null);
    }
  });

  await test("ENFORCE-UNAVAILABLE inline: RPC error + free plan → 503, generator NOT spawned, lock released", async () => {
    const first = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_error", userId: FREE_USER });
    assertEq(first.status, 503, "free user refused");
    assertEq(first.json.code, "usage_unavailable", "code");
    assertEq(spawnCount, 0, "generator never dispatched");
    // Same user again: a leaked per-user lock would surface as 429 user_generation_limit.
    const second = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_error", userId: FREE_USER });
    assertEq(second.status, 503, "second request reaches the same decision — the lock was released");
    assert(second.json.error_type !== "user_generation_limit", "no leaked generation lock");
  });

  await test("ENFORCE-UNAVAILABLE inline: RPC error + pro plan → generates unmetered, no settle", async () => {
    const { status, json } = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_error", userId: PRO_USER });
    assertEq(status, 200, "paid plan keeps generating");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
    assertEq(rpcCalls.filter(c => c.fn === "usage_settle_reservation_item").length, 0, "nothing reserved → nothing settled");
  });

  await test("ENFORCE-UNAVAILABLE: enforce WITHOUT USAGE_ENFORCE_AI_IMAGES + RPC error + free → still generates (switch off never blocks)", async () => {
    const w = await run(fullBody(), { meterMode: "enforce", genMode: "worker", ledger: "reserve_error", userId: FREE_USER, enforceAiImages: false });
    assertEq(w.status, 200, "worker proceeds");
    assertEq(w.json.jobId, "job_plain", "plain enqueue");
    const i = await run(fullBody(), { meterMode: "enforce", genMode: "inline", ledger: "reserve_error", userId: FREE_USER, enforceAiImages: false });
    assertEq(i.status, 200, "inline proceeds");
    assertEq(spawnCount, 1, "dispatched");
  });

  await test("SOURCE: /api/generate no longer uses the legacy usage_events quota (checkAllowance/recordUsage)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(process.cwd(), "src/app/api/generate/route.ts"), "utf8");
    assert(!/from\s+["']@\/lib\/server\/usage["']/.test(src), "no import from @/lib/server/usage");
    assert(!/\bcheckAllowance\s*\(/.test(src), "no checkAllowance( call");
    assert(!/\brecordUsage\s*\(/.test(src), "no recordUsage( call");
    assert(!/quota_exceeded/.test(src), "no legacy 429 quota_exceeded response");
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
