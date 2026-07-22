/**
 * Generation route moderation-gate tests (Creem AI-compliance).
 * Run: npx tsx scripts/test-generation-moderation-gate.ts
 *
 * Drives the REAL POST /api/generate handler through the deterministic env seam
 * (ALLOW_GENERATION_MOCK_PROVIDER=true + MODERATION_MOCK_DECISION=…) so no live
 * Creem call happens. child_process.spawn is intercepted to (a) count dispatches
 * and (b) return a fake generator that emits a valid JSON result — so an
 * allow-decision request completes without a real subprocess.
 *
 * Verifies:
 *   - allow → dispatch invoked exactly once.
 *   - flag / deny → 400 prompt_rejected, dispatch ZERO times.
 *   - unknown / timeout / error / malformed / non2xx / missing_key → 503
 *     moderation_unavailable, dispatch ZERO times.
 *   - a rejected/unavailable prompt never acquires the per-user lock (no lock dir
 *     side-effects — asserted by dispatch=0 which sits AFTER the lock in the
 *     handler, so zero dispatch with a fresh lock root proves the gate short-
 *     circuits before lock acquisition).
 *   - retry (mode:"retry_single_output") and the FastAPI (requiresFullPayload=
 *     false) branch both hit the gate first.
 *   - CONTEXT DILUTION: each free-text field is moderated on its own RAW value,
 *     so a field that denies alone stays blocked even when the joined text is
 *     allowed (the production-proven bypass), and a composite-only deny also
 *     blocks. Driven by MODERATION_MOCK_MAP, which addresses one check at a time.
 *   - AMPLIFICATION: moderation is a PAID third-party API, so the number of
 *     OUTBOUND calls one request can provoke is itself a security property. The
 *     moderatePrompt client is spied on (moderateCallCount) so these tests assert
 *     CALL COUNTS, not just status codes:
 *       * an unauthenticated worker-mode request → 0 calls, 401
 *       * over-limit selectedTags / product_metadata → 0 calls, 400
 *       * an over-long single field → 0 calls, 400
 *       * no request can ever exceed MAX_MODERATION_CHECKS outbound calls
 *       * a legitimate maximum-size request → exactly the expected fixed count
 *   - MODEL KEY (image-generation hardening): `model_key` is client-controlled and
 *     picks which PAID provider the account is billed for. Both canonical keys are
 *     accepted and FORWARDED VERBATIM to the dispatch payload, the legacy
 *     `nano_banana` alias normalises to `gemini_image`, an omitted key takes the
 *     documented default, and anything else is 400 with ZERO enqueue / ZERO FastAPI
 *     / ZERO spawn. The payload is captured off the intercepted seams so "forwarded
 *     correctly" is asserted on the real value, not inferred from a status code.
 *   - RATE LIMIT (image-generation hardening): the durable per-user
 *     `image_generation` bucket runs BEFORE the moderation batch, so a throttled
 *     request costs zero outbound Creem calls and zero provider work. Includes the
 *     FAIL-CLOSED divergence: unlike the ai-copy routes, a limiter outage REFUSES.
 */

// Env must be set BEFORE the route module loads.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.CREEM_API_KEY = "creem_test_fake";
process.env.ALLOW_GENERATION_MOCK_PROVIDER = "true"; // unlocks the moderation env seam
// Point FastAPI at a dead host so tryFastAPI's /health probe fails fast and the
// handler falls through to the generator.py dispatch (which we intercept).
process.env.FASTAPI_URL = "http://127.0.0.1:1"; // unroutable → health fetch throws → null
// Isolated lock root so real lock dirs never collide / persist.
import os from "node:os";
import path from "node:path";
process.env.VIBEPIN_GENERATION_LOCK_DIR = path.join(os.tmpdir(), `vibepin-modgate-${Date.now()}`);

export {};

import { Module } from "node:module";
import { EventEmitter } from "node:events";

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

// ── Intercept supabase insert to count WP3 worker enqueues ─────────────────────
// The WP3-P1 worker path (GENERATION_MODE=worker) enqueues a generation_jobs row
// via createServerClient().from("generation_jobs").insert(). We count inserts so
// a rejected/unavailable prompt can be proven to NEVER enqueue a job (the queue
// is the easiest background bypass — the gate must sit before it).
let enqueueInsertCount = 0;
/** The `params` of the last enqueued generation_jobs row — lets a test assert what
 *  was actually FORWARDED (e.g. model_key), not merely that a 200 came back. */
let lastEnqueuedParams: Record<string, unknown> | null = null;
function fakeServerClient() {
  return {
    from(table: string) {
      return {
        insert(_row: unknown) {
          if (table === "generation_jobs") {
            enqueueInsertCount++;
            const row = _row as { params?: Record<string, unknown> };
            lastEnqueuedParams = row?.params ?? null;
          }
          return {
            select() {
              return {
                single: async () => ({
                  data: { id: "job_fake", vibepin_user_id: "u", status: "pending", created_at: new Date().toISOString() },
                  error: null,
                }),
              };
            },
          };
        },
        select() {
          // worker-status heartbeat lookup: report a FRESH worker so enqueue proceeds.
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
                single: async () => ({ data: { name: "generation-worker", last_seen: new Date().toISOString() }, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

// ── Intercept child_process.spawn to count generator dispatches ────────────────
let spawnCount = 0;
/** The JSON payload piped to generator.py on the inline path — same purpose as
 *  lastEnqueuedParams, for the branch that spawns instead of enqueuing. */
let lastSpawnPayload: Record<string, unknown> | null = null;
function fakeSpawn() {
  spawnCount++;
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (chunk?: unknown) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdin = {
    write: (chunk?: unknown) => {
      try { lastSpawnPayload = JSON.parse(String(chunk)) as Record<string, unknown>; } catch { /* not the payload write */ }
    },
    end: () => {},
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // Emit a valid generator.py JSON result on the next tick, then close cleanly.
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, urls: ["u1"], keyword: "k", style: "lifestyle" }) + "\n"));
    child.emit("close", 0);
  });
  return child;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  const real = originalLoad.call(this, request, parent, isMain);
  if (request === "child_process") {
    return { ...real, spawn: fakeSpawn };
  }
  return real;
};

// ── Spy on the moderation client to count OUTBOUND calls ──────────────────────
// The amplification defect is about how many PAID third-party requests one HTTP
// request can provoke. Status codes alone cannot prove "zero outbound calls", so
// moderatePrompt is wrapped and every invocation counted. The wrapper delegates
// to the real implementation, so the deterministic MODERATION_MOCK_DECISION /
// MODERATION_MOCK_MAP seams (and the fail-closed contract they exercise) are
// completely unchanged — this only observes.
let moderateCallCount = 0;
let moderateExternalIds: string[] = [];

// Intercept the supabase module so the worker path's enqueue is countable and
// never touches a real DB. Path-based match on the resolved id (…/lib/supabase).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalResolve = (Module as any)._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "child_process") {
    const real = originalLoad.call(this, request, parent, isMain);
    return { ...real, spawn: fakeSpawn };
  }
  if (/[\\/]lib[\\/]supabase(\.ts)?$/.test(request) || request === "@/lib/supabase") {
    return { createServerClient: fakeServerClient };
  }
  if (/[\\/]creem[\\/]moderatePrompt(\.ts)?$/.test(request) || request === "@/lib/server/creem/moderatePrompt") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = originalLoad.call(this, request, parent, isMain) as any;
    return {
      ...real,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moderatePrompt: (input: any, deps?: any) => {
        moderateCallCount++;
        moderateExternalIds.push(String(input?.externalId ?? ""));
        return real.moderatePrompt(input, deps);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
void originalResolve;

// ── Durable rate-limit store fake ─────────────────────────────────────────────
// /api/generate consumes the `image_generation` bucket of lib/server/rateLimit.ts
// BEFORE the moderation batch. The real store would reach Supabase, so a fake that
// models the two Postgres constraints the limiter depends on is installed here —
// same fidelity contract as test-ai-provider-rate-limit.ts:
//   create() → PRIMARY KEY uniqueness (a duplicate returns false, i.e. 23505)
//   bump()   → compare-and-swap, applying only while `hits` is still what was read
// `failing = true` simulates the store being unreachable, which is how the
// FAIL-CLOSED divergence for this route is exercised.
type LimiterKey = { userId: string; route: string; windowStart: string };
const limiterKeyOf = (k: LimiterKey) => `${k.userId}|${k.route}|${k.windowStart}`;

class FakeLimiterStore {
  rows = new Map<string, { hits: number }>();
  failing = false;
  private guard() { if (this.failing) throw new Error("simulated supabase outage"); }
  async read(k: LimiterKey) { this.guard(); const r = this.rows.get(limiterKeyOf(k)); return r ? { hits: r.hits } : null; }
  async create(k: LimiterKey) {
    this.guard();
    const id = limiterKeyOf(k);
    if (this.rows.has(id)) return false; // PRIMARY KEY violation (23505)
    this.rows.set(id, { hits: 1 });
    return true;
  }
  async bump(k: LimiterKey, seen: number) {
    this.guard();
    const row = this.rows.get(limiterKeyOf(k));
    if (!row || row.hits !== seen) return false; // lost CAS
    row.hits = seen + 1;
    return true;
  }
  async prune() { this.guard(); }
  /** Pre-fill a window to `hits` so the very next request is over the ceiling. */
  fill(userId: string, route: string, windowStart: string, hits: number) {
    this.rows.set(limiterKeyOf({ userId, route, windowStart }), { hits });
  }
}

// The limiter module is loaded ONCE and shared by module identity, so installing the
// fake here is what the route handler sees — even across the route-module evictions
// these runners do (evicting the ROUTE does not evict the limiter).
const rateLimitModule = require("../src/lib/server/rateLimit") as typeof import("../src/lib/server/rateLimit");
let limiterStore = new FakeLimiterStore();
function resetLimiter() {
  limiterStore = new FakeLimiterStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rateLimitModule.__setRateLimitStoreForTests(limiterStore as any);
}
resetLimiter();

function makeReq(body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepin-test-user-id": `u_${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify(body),
  });
}
/** No auth header at all — the route must treat this as an anonymous caller. */
function makeAnonReq(body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
// Give each request a distinct owner so per-user locks never collide across tests.
process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = "true";

// A "full payload" body forces the generator.py branch (requiresFullPayload=true).
function fullBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyword: "cozy mug",
    prompt: "a cozy ceramic mug on a table",
    directionBrief: "warm minimal styling",
    category: "home",
    selectedTags: [{ id: "t1", label: "cozy", group: "mood" }],
    prompt_mode: "creative_direction_v2", // → requiresFullPayload true → generator.py path
    provider_mode: "mock",
    ...extra,
  };
}

async function runWith(decision: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  process.env.MODERATION_MOCK_DECISION = decision;
  spawnCount = 0;
  enqueueInsertCount = 0;
  moderateCallCount = 0;
  moderateExternalIds = [];
  lastEnqueuedParams = null;
  lastSpawnPayload = null;
  // Evict so this inline-mode run re-evaluates the module rather than inheriting
  // a copy left in worker mode by a preceding test (see runWorkerWith).
  delete require.cache[require.resolve("../src/app/api/generate/route")];
  const route = await import("../src/app/api/generate/route");
  const res = await route.POST(makeReq(body) as never);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

// Run with GENERATION_MODE=worker so the request would take the WP3 enqueue path
// if it reached it. The route reads GENERATION_MODE at MODULE LOAD, so set it and
// force a fresh module import via the query cache-buster.
async function runWorkerWith(decision: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  process.env.MODERATION_MOCK_DECISION = decision;
  process.env.GENERATION_MODE = "worker";
  spawnCount = 0;
  enqueueInsertCount = 0;
  moderateCallCount = 0;
  moderateExternalIds = [];
  lastEnqueuedParams = null;
  lastSpawnPayload = null;
  // GENERATION_MODE is captured at module top-level, so re-import a fresh copy.
  // Under tsx these imports resolve through the CJS cache, which is keyed on the
  // resolved file path and ignores the query string — evict the entry so the
  // module is genuinely re-evaluated with GENERATION_MODE=worker in scope.
  delete require.cache[require.resolve("../src/app/api/generate/route")];
  const route = await import(`../src/app/api/generate/route?worker=${decision}_${Math.random()}`);
  const res = await route.POST(makeReq(body) as never);
  const json = (await res.json()) as Record<string, unknown>;
  process.env.GENERATION_MODE = "inline";
  return { status: res.status, json };
}

// ── Per-check runners (context-dilution regression) ───────────────────────────
// MODERATION_MOCK_MAP addresses individual checks: "@<suffix>" targets a check by
// its content-free externalId suffix (keyword/prompt/direction/category/tagN/
// productN/composite), so a test can make ONE raw field deny while the composite
// allows — exactly the shape the flat MODERATION_MOCK_DECISION seam cannot express.
async function runWithMap(
  map: Record<string, string>,
  fallback: string,
  body: Record<string, unknown>,
  mode: "inline" | "worker" = "inline",
): Promise<{ status: number; json: Record<string, unknown> }> {
  process.env.MODERATION_MOCK_MAP = JSON.stringify(map);
  process.env.MODERATION_MOCK_DECISION = fallback;
  process.env.GENERATION_MODE = mode;
  spawnCount = 0;
  enqueueInsertCount = 0;
  moderateCallCount = 0;
  moderateExternalIds = [];
  lastEnqueuedParams = null;
  lastSpawnPayload = null;
  delete require.cache[require.resolve("../src/app/api/generate/route")];
  const route = await import(`../src/app/api/generate/route?map=${mode}_${Math.random()}`);
  const res = await route.POST(makeReq(body) as never);
  const json = (await res.json()) as Record<string, unknown>;
  process.env.GENERATION_MODE = "inline";
  delete process.env.MODERATION_MOCK_MAP;
  return { status: res.status, json };
}

// ── Amplification runners ─────────────────────────────────────────────────────
// Same shape as runWith/runWorkerWith, but sends a request with NO auth identity
// so the route's authentication step is exercised. The test-user header seam is
// temporarily disabled for the call so the route sees a genuinely anonymous
// caller (Supabase bearer/cookie lookups both resolve null against the fake env).
async function runAnon(
  decision: string,
  body: Record<string, unknown>,
  mode: "inline" | "worker",
): Promise<{ status: number; json: Record<string, unknown> }> {
  process.env.MODERATION_MOCK_DECISION = decision;
  process.env.GENERATION_MODE = mode;
  delete process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
  spawnCount = 0;
  enqueueInsertCount = 0;
  moderateCallCount = 0;
  moderateExternalIds = [];
  lastEnqueuedParams = null;
  lastSpawnPayload = null;
  try {
    // GENERATION_MODE is captured at module top-level, so the module must be
    // re-evaluated after the env flip above. tsx runs these imports through the
    // CJS loader (this suite hooks Module._load), whose cache is keyed on the
    // RESOLVED FILE PATH — a `?x=` query string does not create a separate entry.
    // Evicting the entry is therefore what actually forces a fresh evaluation.
    const routePath = require.resolve("../src/app/api/generate/route");
    delete require.cache[routePath];
    const route = await import(`../src/app/api/generate/route?anon=${mode}_${Math.random()}`);
    const res = await route.POST(makeAnonReq(body) as never);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  } finally {
    process.env.GENERATION_MODE = "inline";
    process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = "true";
  }
}

// ── Image-generation hardening runners ────────────────────────────────────────
// Like runWith/runWorkerWith, but (a) pin the user id so a test can pre-fill that
// user's rate-limit window, and (b) return the raw Response so header assertions
// (Retry-After) are possible.
function makeReqAs(userId: string, body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepin-test-user-id": userId },
    body: JSON.stringify(body),
  });
}

async function runAs(
  userId: string,
  body: Record<string, unknown>,
  mode: "inline" | "worker" = "inline",
  decision = "allow",
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  process.env.MODERATION_MOCK_DECISION = decision;
  process.env.GENERATION_MODE = mode;
  spawnCount = 0;
  enqueueInsertCount = 0;
  moderateCallCount = 0;
  moderateExternalIds = [];
  lastEnqueuedParams = null;
  lastSpawnPayload = null;
  try {
    delete require.cache[require.resolve("../src/app/api/generate/route")];
    const route = await import(`../src/app/api/generate/route?as=${mode}_${Math.random()}`);
    const res = (await route.POST(makeReqAs(userId, body) as never)) as Response;
    const json = (await res.clone().json()) as Record<string, unknown>;
    return { status: res.status, json, res };
  } finally {
    process.env.GENERATION_MODE = "inline";
  }
}

let uniqueUserSeq = 0;
/** A fresh user id, so each test starts on an empty rate-limit window. */
const freshUser = () => `u_hard_${++uniqueUserSeq}_${Math.random().toString(36).slice(2)}`;

async function main() {
  console.log("\nGeneration route moderation-gate tests\n");

  await test("allow → dispatch invoked exactly once", async () => {
    const { status, json } = await runWith("allow", fullBody());
    assertEq(spawnCount, 1, "generator.py dispatched exactly once");
    assertEq(status, 200, "status");
    assertEq(json.ok, true, "ok");
  });

  await test("flag → 400 prompt_rejected, ZERO dispatch", async () => {
    const { status, json } = await runWith("flag", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
    assertEq(json.code, "prompt_rejected", "code");
    assert(Array.isArray(json.urls) && (json.urls as unknown[]).length === 0, "urls empty");
  });

  await test("deny → 400 prompt_rejected, ZERO dispatch", async () => {
    const { status, json } = await runWith("deny", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  for (const mode of ["unknown", "timeout", "error", "malformed", "non2xx", "missing_key"]) {
    await test(`${mode} → 503 moderation_unavailable, ZERO dispatch`, async () => {
      const { status, json } = await runWith(mode, fullBody());
      assertEq(spawnCount, 0, "no dispatch");
      assertEq(status, 503, "status");
      assertEq(json.error_type, "moderation_unavailable", "error_type");
      assertEq(json.code, "moderation_unavailable", "code");
    });
  }

  await test("retry (mode:retry_single_output) — allow dispatches once", async () => {
    const { status } = await runWith("allow", fullBody({ mode: "retry_single_output", count: 4 }));
    assertEq(spawnCount, 1, "retry dispatched once");
    assertEq(status, 200, "status");
  });

  await test("retry — deny is blocked before dispatch (400, ZERO dispatch)", async () => {
    const { status, json } = await runWith("deny", fullBody({ mode: "retry_single_output" }));
    assertEq(spawnCount, 0, "no dispatch on rejected retry");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("FastAPI branch (requiresFullPayload=false) — deny blocked before any dispatch", async () => {
    // No CD v2, no images, no styleRef → requiresFullPayload=false. Gate runs
    // BEFORE the FastAPI probe, so a deny returns 400 and never touches dispatch.
    const body = { keyword: "plain keyword", prompt: "", directionBrief: "", category: "", selectedTags: [] };
    const { status, json } = await runWith("deny", body);
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("FastAPI branch — unavailable blocked before FastAPI probe (503, ZERO dispatch)", async () => {
    const body = { keyword: "plain keyword", prompt: "", directionBrief: "", category: "", selectedTags: [] };
    const { status, json } = await runWith("non2xx", body);
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 503, "status");
    assertEq(json.error_type, "moderation_unavailable", "error_type");
  });

  // ── WP3 worker enqueue path — the easiest background bypass; must be gated ─────
  await test("WORKER: deny → 400, ZERO enqueue (no generation_jobs insert)", async () => {
    const { status, json } = await runWorkerWith("deny", fullBody());
    assertEq(enqueueInsertCount, 0, "no generation_jobs enqueue on a denied worker request");
    assertEq(spawnCount, 0, "no generator dispatch either");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("WORKER: flag → 400, ZERO enqueue", async () => {
    const { status, json } = await runWorkerWith("flag", fullBody());
    assertEq(enqueueInsertCount, 0, "no enqueue on flagged worker request");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  for (const mode of ["unknown", "timeout", "error", "malformed", "non2xx", "missing_key"]) {
    await test(`WORKER: ${mode} → 503, ZERO enqueue`, async () => {
      const { status, json } = await runWorkerWith(mode, fullBody());
      assertEq(enqueueInsertCount, 0, `no enqueue on ${mode} worker request`);
      assertEq(status, 503, "status");
      assertEq(json.error_type, "moderation_unavailable", "error_type");
    });
  }

  // ── Context dilution (the production-proven bypass) ─────────────────────────
  // Measured against the live Creem endpoint: a violent prompt that is DENIED on
  // its own is ALLOWED once benign context (keyword + category + tag labels) is
  // newline-joined onto it. Moderating only the joined text therefore lets that
  // prompt through. Each case below pins one half of the two-layer contract.

  await test("DILUTION: violence in ONE field blocked though composite allows (benign category+tags)", async () => {
    const { status, json } = await runWithMap(
      { "@prompt": "deny", "@composite": "allow" },
      "allow",
      fullBody({ prompt: "a violent scene", category: "home decor", selectedTags: [{ id: "t1", label: "cozy", group: "mood" }] }),
    );
    assertEq(spawnCount, 0, "no dispatch when a raw field is denied");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("DILUTION: composite allow + raw keyword deny → still blocked", async () => {
    const { status, json } = await runWithMap({ "@keyword": "deny", "@composite": "allow" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("DILUTION: composite allow + raw directionBrief deny → still blocked", async () => {
    const { status, json } = await runWithMap({ "@direction": "deny", "@composite": "allow" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  // category/selectedTags come from a fixed UI catalogue but are NOT whitelisted
  // server-side (route.ts takes body.category verbatim and blind-casts
  // selectedTags), so a direct API caller can inject text there — they get their
  // own individual checks, not just composite membership.
  await test("DILUTION: raw category deny (unvalidated server-side) → blocked", async () => {
    const { status, json } = await runWithMap({ "@category": "deny", "@composite": "allow" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("DILUTION: raw selectedTags label deny → blocked", async () => {
    const { status, json } = await runWithMap({ "@tag1": "deny", "@composite": "allow" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("DILUTION: raw product_metadata title deny → blocked", async () => {
    const { status, json } = await runWithMap(
      { "@product1": "deny", "@composite": "allow" },
      "allow",
      fullBody({ product_metadata: [{ title: "a product title", productUrl: "https://example.com/p" }] }),
    );
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("SPLIT INTENT: every raw field allows but composite denies → still blocked", async () => {
    const { status, json } = await runWithMap({ "@composite": "deny" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch when only the composite denies");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("FAIL-CLOSED: a single check unavailable (rest allow) → 503, ZERO dispatch", async () => {
    const { status, json } = await runWithMap({ "@direction": "timeout" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 503, "status");
    assertEq(json.error_type, "moderation_unavailable", "error_type");
  });

  await test("PRECEDENCE: one field denied + another unavailable → 400 prompt_rejected", async () => {
    const { status, json } = await runWithMap({ "@prompt": "deny", "@keyword": "timeout" }, "allow", fullBody());
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "rejected wins over unavailable");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("ALL ALLOW: safe prompt still generates (dispatch exactly once)", async () => {
    const { status, json } = await runWithMap({ "@composite": "allow" }, "allow", fullBody());
    assertEq(spawnCount, 1, "safe request dispatched once");
    assertEq(status, 200, "status");
    assertEq(json.ok, true, "ok");
  });

  // Coverage across the remaining dispatch paths for the per-field layer.
  await test("WORKER: raw field deny with composite allow → 400, ZERO enqueue", async () => {
    const { status, json } = await runWithMap({ "@prompt": "deny", "@composite": "allow" }, "allow", fullBody(), "worker");
    assertEq(enqueueInsertCount, 0, "no generation_jobs enqueue");
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("WORKER: single check unavailable → 503, ZERO enqueue", async () => {
    const { status, json } = await runWithMap({ "@keyword": "non2xx" }, "allow", fullBody(), "worker");
    assertEq(enqueueInsertCount, 0, "no enqueue");
    assertEq(status, 503, "status");
    assertEq(json.error_type, "moderation_unavailable", "error_type");
  });

  await test("RETRY: raw field deny with composite allow → 400, ZERO dispatch", async () => {
    const { status, json } = await runWithMap(
      { "@prompt": "deny", "@composite": "allow" },
      "allow",
      fullBody({ mode: "retry_single_output" }),
    );
    assertEq(spawnCount, 0, "no dispatch on rejected retry");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  await test("FASTAPI branch: raw keyword deny with composite allow → 400 before the probe", async () => {
    // requiresFullPayload=false → the FastAPI probe would run next; the gate must
    // still short-circuit on a per-field deny.
    const body = { keyword: "plain keyword", prompt: "", directionBrief: "", category: "", selectedTags: [] };
    const { status, json } = await runWithMap({ "@keyword": "deny", "@composite": "allow" }, "allow", body);
    assertEq(spawnCount, 0, "no dispatch");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "prompt_rejected", "error_type");
  });

  // ── Check construction: raw values only, content-free externalId suffixes ─────
  await test("checks carry RAW field values — no labels, prefixes or sibling text", async () => {
    const route = await import("../src/app/api/generate/route");
    const checks = route.buildModerationChecks({
      keyword: "cozy mug",
      prompt: "a cozy ceramic mug",
      directionBrief: "warm minimal styling",
      category: "home decor",
      selectedTags: [{ label: "cozy" }],
      productMetadata: [{ title: "Ceramic Mug" }],
    }) as Array<{ suffix: string; text: string }>;
    const bySuffix = Object.fromEntries(checks.map(c => [c.suffix, c.text]));
    assertEq(bySuffix.keyword, "cozy mug", "keyword check is the raw value");
    assertEq(bySuffix.prompt, "a cozy ceramic mug", "prompt check is the raw value");
    assertEq(bySuffix.direction, "warm minimal styling", "direction check is the raw value");
    assertEq(bySuffix.category, "home decor", "category check is the raw value");
    assertEq(bySuffix.tag1, "cozy", "tag check is the raw label");
    assertEq(bySuffix.product1, "Ceramic Mug", "product title check is the raw value");
    assert(bySuffix.composite.includes("cozy mug") && bySuffix.composite.includes("Ceramic Mug"), "composite joins the fields");
    assertEq(checks[checks.length - 1].suffix, "composite", "composite is last");
    assert(checks.every(c => /^(keyword|prompt|direction|category|tag\d+|product\d+|composite)$/.test(c.suffix)), "suffixes are content-free");
  });

  await test("empty fields produce no check (no wasted moderation call)", async () => {
    const route = await import("../src/app/api/generate/route");
    const checks = route.buildModerationChecks({
      keyword: "cozy mug", prompt: "", directionBrief: "   ", category: "", selectedTags: [{ label: "" }], productMetadata: null,
    }) as Array<{ suffix: string; text: string }>;
    assertEq(checks.map(c => c.suffix).join(","), "keyword,composite", "only non-empty fields + composite");
  });

  // ── REQUEST AMPLIFICATION ────────────────────────────────────────────────────
  // Moderation is a PAID third-party API. Before this fix the moderation batch
  // ran ~60 lines BEFORE the worker path's 401, so an unauthenticated request
  // could burn up to 6 outbound Creem calls; and `selectedTags` /
  // `product_metadata` were blind `as` casts with no length or structure
  // validation, so 10,000 tags meant 10,000 outbound calls. Every assertion below
  // checks the OUTBOUND CALL COUNT, not merely the status code.

  const { INPUT_LIMITS, MAX_MODERATION_CHECKS } = await import("../src/app/api/generate/route");
  const LIMITS = INPUT_LIMITS as Record<string, number>;
  const MAX_CHECKS = MAX_MODERATION_CHECKS as unknown as number;

  await test("AUTH: unauthenticated worker-mode request → 401 with ZERO moderation calls", async () => {
    const { status, json } = await runAnon("allow", fullBody(), "worker");
    assertEq(moderateCallCount, 0, "NO outbound moderation call before the 401");
    assertEq(status, 401, "status");
    assertEq(json.error, "unauthorized", "error");
    assertEq(enqueueInsertCount, 0, "no enqueue");
    assertEq(spawnCount, 0, "no dispatch");
  });

  await test("AUTH: unauthenticated worker request cannot be amplified by a big tag array", async () => {
    // Even a maximum-size legitimate body must not buy a single call when the
    // caller is anonymous — auth precedes moderation unconditionally.
    const tags = Array.from({ length: LIMITS.TAGS }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    const { status } = await runAnon("allow", fullBody({ selectedTags: tags }), "worker");
    assertEq(moderateCallCount, 0, "still zero outbound calls");
    assertEq(status, 401, "status");
  });

  await test("WORKER MODE: an allowed request enqueues and never spawns", async () => {
    // Pins the branch itself, not just its moderation behaviour: in worker mode
    // an allowed request must insert exactly one generation_jobs row, must NOT
    // spawn generator.py, and must return a jobId rather than urls.
    const { status, json } = await runWorkerWith("allow", fullBody());
    assertEq(spawnCount, 0, "worker mode must NOT spawn generator.py");
    assertEq(enqueueInsertCount, 1, "worker mode enqueues exactly one job");
    assertEq(status, 200, "status");
    assert(typeof json.jobId === "string", "worker mode returns a jobId, not urls");
  });

  await test("AUTH: authenticated worker request still succeeds (no regression)", async () => {
    const { status, json } = await runWorkerWith("allow", fullBody());
    assert(moderateCallCount > 0, "an authenticated request DOES get moderated");
    assertEq(status, 200, "status");
    assertEq(enqueueInsertCount, 1, "enqueued exactly once");
    assert(typeof json.jobId === "string", "jobId returned");
  });

  await test("AUTH: inline path still serves anonymous callers (documented behaviour kept)", async () => {
    // The inline generator.py path has always accepted anonymous requests — the
    // `anon:`/`session:` lock owner exists precisely for them. This fix must not
    // silently break that; only GENERATION_MODE=worker (production) is hardened.
    const { status, json } = await runAnon("allow", fullBody(), "inline");
    assertEq(status, 200, "anonymous inline request still generates");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
    assert(moderateCallCount > 0, "and it was moderated");
  });

  await test("BOUND: over-limit selectedTags → 400 invalid_request, ZERO moderation calls", async () => {
    const tags = Array.from({ length: LIMITS.TAGS + 1 }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    const { status, json } = await runWith("allow", fullBody({ selectedTags: tags }));
    assertEq(moderateCallCount, 0, "ZERO outbound calls for an over-limit tag array");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
    assertEq(json.code, "invalid_request", "code");
    assertEq(spawnCount, 0, "no dispatch");
  });

  await test("BOUND: a 10,000-tag array buys ZERO moderation calls (the amplification payload)", async () => {
    const tags = Array.from({ length: 10_000 }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    const { status, json } = await runWith("allow", fullBody({ selectedTags: tags }));
    assertEq(moderateCallCount, 0, "10,000 tags must not produce 10,000 outbound calls");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  await test("BOUND: over-limit product_metadata → 400 invalid_request, ZERO moderation calls", async () => {
    const products = Array.from({ length: LIMITS.PRODUCTS + 1 }, (_, i) => ({ title: `product ${i}`, productUrl: "https://example.com/p" }));
    const { status, json } = await runWith("allow", fullBody({ product_metadata: products }));
    assertEq(moderateCallCount, 0, "ZERO outbound calls for an over-limit product array");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  for (const [field, key] of [
    ["keyword", "KEYWORD"],
    ["prompt", "PROMPT"],
    ["directionBrief", "DIRECTION_BRIEF"],
    ["category", "CATEGORY"],
  ] as Array<[string, string]>) {
    await test(`BOUND: over-long ${field} → 400 invalid_request, ZERO moderation calls`, async () => {
      const { status, json } = await runWith("allow", fullBody({ [field]: "x".repeat(LIMITS[key] + 1) }));
      assertEq(moderateCallCount, 0, `ZERO outbound calls for an over-long ${field}`);
      assertEq(status, 400, "status");
      assertEq(json.error_type, "invalid_request", "error_type");
      assertEq(spawnCount, 0, "no dispatch");
    });
  }

  await test("BOUND: over-long tag label → 400 invalid_request, ZERO moderation calls", async () => {
    const { status, json } = await runWith("allow", fullBody({
      selectedTags: [{ id: "t1", label: "x".repeat(LIMITS.TAG_LABEL + 1), group: "mood" }],
    }));
    assertEq(moderateCallCount, 0, "ZERO outbound calls");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  await test("BOUND: over-long product title → 400 invalid_request, ZERO moderation calls", async () => {
    const { status, json } = await runWith("allow", fullBody({
      product_metadata: [{ title: "x".repeat(LIMITS.PRODUCT_TITLE + 1), productUrl: "https://example.com/p" }],
    }));
    assertEq(moderateCallCount, 0, "ZERO outbound calls");
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  // ── STRUCTURE: the blind `as` casts are gone ────────────────────────────────
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["selectedTags entry is an array", { selectedTags: [["not", "an", "object"]] }],
    ["selectedTags entry is null", { selectedTags: [null] }],
    ["selectedTags entry is a string", { selectedTags: ["cozy"] }],
    ["selectedTags is not an array", { selectedTags: { label: "cozy" } }],
    ["selectedTags label is a nested object", { selectedTags: [{ id: "t1", label: { evil: 1 }, group: "mood" }] }],
    ["selectedTags label is a number", { selectedTags: [{ id: "t1", label: 42, group: "mood" }] }],
    ["product_metadata entry is an array", { product_metadata: [["nope"]] }],
    ["product_metadata entry is null", { product_metadata: [null] }],
    ["product_metadata title is a nested object", { product_metadata: [{ title: { evil: 1 } }] }],
    ["product_metadata title is a number", { product_metadata: [{ title: 7 }] }],
  ];
  for (const [label, extra] of malformed) {
    await test(`STRUCTURE: ${label} → 400 invalid_request, ZERO moderation calls`, async () => {
      const { status, json } = await runWith("allow", fullBody(extra));
      assertEq(moderateCallCount, 0, "ZERO outbound calls for a malformed payload");
      assertEq(status, 400, "status");
      assertEq(json.error_type, "invalid_request", "error_type");
      assertEq(spawnCount, 0, "no dispatch");
    });
  }

  // ── The hard ceiling ────────────────────────────────────────────────────────
  await test("CEILING: MAX_MODERATION_CHECKS comfortably fits a legitimate maximum request", () => {
    // 4 scalar fields + TAGS + PRODUCTS + 1 composite is the largest list the
    // per-field caps can produce. The ceiling must sit at or above it, or a legal
    // request would 400.
    const worstLegit = 4 + LIMITS.TAGS + LIMITS.PRODUCTS + 1;
    assert(MAX_CHECKS >= worstLegit, `MAX_MODERATION_CHECKS (${MAX_CHECKS}) >= worst legitimate list (${worstLegit})`);
    assert(MAX_CHECKS < 100, `ceiling stays tight (${MAX_CHECKS} < 100)`);
  });

  await test("CEILING: a legitimate MAXIMUM-size request makes exactly the expected fixed call count", async () => {
    const tags = Array.from({ length: LIMITS.TAGS }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    const products = Array.from({ length: LIMITS.PRODUCTS }, (_, i) => ({ title: `product ${i}`, productUrl: "https://example.com/p" }));
    const { status, json } = await runWith("allow", fullBody({ selectedTags: tags, product_metadata: products }));
    // keyword + prompt + direction + category + TAGS + PRODUCTS + composite
    const expected = 4 + LIMITS.TAGS + LIMITS.PRODUCTS + 1;
    assertEq(moderateCallCount, expected, "exactly the expected fixed number of outbound calls");
    assert(moderateCallCount <= MAX_CHECKS, "and within the ceiling");
    assertEq(status, 200, "a maximum-size legitimate request still generates");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
  });

  await test("CEILING: no crafted payload can exceed MAX_MODERATION_CHECKS outbound calls", async () => {
    // Sweep escalating malicious sizes; each must either be rejected with zero
    // calls or stay at/below the ceiling. Never in between.
    for (const n of [25, 50, 100, 500, 5000]) {
      const tags = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
      const products = Array.from({ length: n }, (_, i) => ({ title: `product ${i}` }));
      const { status } = await runWith("allow", fullBody({ selectedTags: tags, product_metadata: products }));
      assert(
        moderateCallCount <= MAX_CHECKS,
        `n=${n}: outbound calls ${moderateCallCount} must never exceed ${MAX_CHECKS}`,
      );
      assertEq(moderateCallCount, 0, `n=${n}: an over-limit payload is rejected with zero calls`);
      assertEq(status, 400, `n=${n}: status`);
    }
  });

  await test("CEILING: over-limit request is rejected BEFORE any partial batch is fired", async () => {
    // The failure mode this guards against is "truncate to the cap and continue",
    // which would still bill N calls AND moderate less text than was submitted.
    const tags = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    const { json } = await runWith("allow", fullBody({ selectedTags: tags }));
    assertEq(moderateCallCount, 0, "not even a partial (capped) batch is issued");
    assertEq(moderateExternalIds.length, 0, "no externalIds recorded → no call attempted");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  // ── At-limit requests are ACCEPTED (the caps are not off-by-one) ─────────────
  await test("AT-LIMIT: exactly-at-cap values are accepted and generate normally", async () => {
    const { status, json } = await runWith("allow", fullBody({
      keyword: "x".repeat(LIMITS.KEYWORD),
      prompt: "y".repeat(LIMITS.PROMPT),
      directionBrief: "z".repeat(LIMITS.DIRECTION_BRIEF),
      category: "c".repeat(LIMITS.CATEGORY),
      selectedTags: [{ id: "t1", label: "l".repeat(LIMITS.TAG_LABEL), group: "mood" }],
      product_metadata: [{ title: "t".repeat(LIMITS.PRODUCT_TITLE) }],
    }));
    assertEq(status, 200, "an at-cap request is legal");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
    assertEq(moderateCallCount, 4 + 1 + 1 + 1, "keyword+prompt+direction+category+tag1+product1+composite");
  });

  await test("BOUND: validation runs on the WORKER path too (400, ZERO calls, ZERO enqueue)", async () => {
    const tags = Array.from({ length: LIMITS.TAGS + 5 }, (_, i) => ({ id: `t${i}`, label: `tag ${i}`, group: "mood" }));
    process.env.GENERATION_MODE = "worker";
    process.env.MODERATION_MOCK_DECISION = "allow";
    spawnCount = 0; enqueueInsertCount = 0; moderateCallCount = 0; moderateExternalIds = [];
    const route = await import(`../src/app/api/generate/route?bound=${Math.random()}`);
    const res = await route.POST(makeReq(fullBody({ selectedTags: tags })) as never);
    const json = (await res.json()) as Record<string, unknown>;
    process.env.GENERATION_MODE = "inline";
    assertEq(moderateCallCount, 0, "ZERO outbound calls");
    assertEq(enqueueInsertCount, 0, "ZERO enqueue");
    assertEq(res.status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
  });

  await test("BOUND: validation does not truncate — an accepted request keeps every tag", async () => {
    const route = await import("../src/app/api/generate/route");
    const result = route.validateGenerationInput({
      keyword: "cozy mug",
      prompt: "p",
      directionBrief: "d",
      category: "home",
      selectedTags: [
        { id: "t1", label: "cozy", group: "mood" },
        { id: "t2", label: "warm", group: "mood" },
      ],
      productMetadata: [{ title: "Ceramic Mug", productUrl: "https://example.com/p" }],
    }) as { ok: boolean; selectedTags: Array<{ label: string }>; productMetadata: Array<{ title?: string }> | null };
    assertEq(result.ok, true, "valid input accepted");
    assertEq(result.selectedTags.length, 2, "both tags preserved");
    assertEq(result.selectedTags[1].label, "warm", "label preserved verbatim");
    assertEq(result.productMetadata?.length, 1, "product preserved");
    assertEq(result.productMetadata?.[0].title, "Ceramic Mug", "title preserved verbatim");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // MODEL KEY VALIDATION (image-generation hardening)
  // ══════════════════════════════════════════════════════════════════════════════
  // `model_key` was taken verbatim off the body and forwarded to both dispatch
  // branches; generator.py::_resolve_model_id mapped ANY unknown key onto GPT
  // Image, so arbitrary client text silently chose a specific PAID model and (via
  // _model_supports_image_input, which branches on the RESOLVED model) changed
  // capability too. Every assertion below checks the FORWARDED VALUE off the
  // intercepted dispatch seam, because a route that 200s while quietly sending the
  // wrong model would pass a status-code-only test and still bill the wrong provider.

  const { CANONICAL_IMAGE_MODEL_KEYS, DEFAULT_IMAGE_MODEL_KEY, validateImageModelKey } =
    await import("../src/lib/server/imageModelKey");

  for (const key of CANONICAL_IMAGE_MODEL_KEYS) {
    await test(`MODEL KEY: "${key}" is accepted and forwarded verbatim (inline dispatch)`, async () => {
      resetLimiter();
      const { status } = await runAs(freshUser(), fullBody({ model_key: key }));
      assertEq(status, 200, "status");
      assertEq(spawnCount, 1, "dispatched once");
      assertEq(lastSpawnPayload?.model_key, key, "the generator payload carries the requested key");
    });

    await test(`MODEL KEY: "${key}" is forwarded verbatim on the WORKER enqueue path`, async () => {
      resetLimiter();
      const { status } = await runAs(freshUser(), fullBody({ model_key: key }), "worker");
      assertEq(status, 200, "status");
      assertEq(enqueueInsertCount, 1, "enqueued once");
      assertEq(lastEnqueuedParams?.model_key, key, "the queued job params carry the requested key");
    });
  }

  await test("MODEL KEY: legacy `nano_banana` normalises to gemini_image before dispatch", async () => {
    // The alias must never reach the provider layer: it is accepted for historical
    // persisted drafts (SetupSnapshot.modelKey) and rewritten at the boundary.
    resetLimiter();
    const { status } = await runAs(freshUser(), fullBody({ model_key: "nano_banana" }));
    assertEq(status, 200, "an old draft's key still works");
    assertEq(spawnCount, 1, "dispatched once");
    assertEq(lastSpawnPayload?.model_key, "gemini_image", "normalised, NOT forwarded as the alias");
  });

  await test("MODEL KEY: `nano_banana` also normalises on the worker path", async () => {
    resetLimiter();
    const { status } = await runAs(freshUser(), fullBody({ model_key: "nano_banana" }), "worker");
    assertEq(status, 200, "status");
    assertEq(lastEnqueuedParams?.model_key, "gemini_image", "queued job carries the canonical key");
  });

  await test("MODEL KEY: omitted → the documented default (gemini_image)", async () => {
    resetLimiter();
    const { status } = await runAs(freshUser(), fullBody());
    assertEq(status, 200, "status");
    assertEq(lastSpawnPayload?.model_key, DEFAULT_IMAGE_MODEL_KEY, "default applied");
    assertEq(DEFAULT_IMAGE_MODEL_KEY, "gemini_image", "the documented default is gemini_image");
  });

  // The heart of the fix: an unknown key must be REFUSED, never coerced.
  const badKeys: Array<[string, unknown]> = [
    ["an arbitrary string", "totally_made_up_model"],
    ["a plausible-looking provider id", "gpt-image-2"],
    ["a near-miss of a real key", "gemini-image"],
    ["empty-ish garbage with whitespace", "  not_a_model  "],
    ["a number", 42],
    ["an object (the String() coercion payload)", { evil: 1 }],
    ["an array", ["gpt_image"]],
    ["a boolean", true],
  ];
  for (const [label, value] of badKeys) {
    await test(`MODEL KEY: ${label} → 400, ZERO spawn / enqueue / moderation`, async () => {
      resetLimiter();
      const { status, json } = await runAs(freshUser(), fullBody({ model_key: value }));
      assertEq(status, 400, "status");
      assertEq(json.error_type, "invalid_request", "reuses the route's existing error envelope");
      assertEq(json.code, "invalid_request", "code");
      assertEq(spawnCount, 0, "ZERO generator dispatch");
      assertEq(enqueueInsertCount, 0, "ZERO enqueue");
      // The whole point of validating before the moderation batch: an invalid model
      // must not buy a single PAID Creem call.
      assertEq(moderateCallCount, 0, "ZERO outbound moderation calls");
    });

    await test(`MODEL KEY (worker): ${label} → 400, ZERO enqueue`, async () => {
      resetLimiter();
      const { status, json } = await runAs(freshUser(), fullBody({ model_key: value }), "worker");
      assertEq(status, 400, "status");
      assertEq(json.error_type, "invalid_request", "error_type");
      assertEq(enqueueInsertCount, 0, "ZERO enqueue");
      assertEq(moderateCallCount, 0, "ZERO outbound moderation calls");
    });
  }

  await test("MODEL KEY: an invalid key is NEVER coerced onto a valid/paid model", async () => {
    // Explicitly pins the anti-regression: the old behaviour returned 200 having
    // silently substituted GPT Image. A 200 here at all would be the bug back.
    resetLimiter();
    const { status } = await runAs(freshUser(), fullBody({ model_key: "anything_at_all" }));
    assert(status !== 200, "an unknown key must not succeed");
    assertEq(lastSpawnPayload, null, "nothing was ever handed to the provider layer");
    assertEq(lastEnqueuedParams, null, "and nothing was queued");
  });

  await test("MODEL KEY: the FastAPI branch is also gated (no probe on an invalid key)", async () => {
    // requiresFullPayload=false → this body would take the FastAPI path. Validation
    // sits ahead of it, so an invalid key 400s before any outbound work.
    resetLimiter();
    const { status, json } = await runAs(freshUser(), {
      keyword: "plain keyword", prompt: "", directionBrief: "", category: "", selectedTags: [],
      model_key: "made_up",
    });
    assertEq(status, 400, "status");
    assertEq(json.error_type, "invalid_request", "error_type");
    assertEq(moderateCallCount, 0, "ZERO moderation calls");
    assertEq(spawnCount, 0, "ZERO dispatch");
  });

  // Unit-level contract (no handler needed).
  await test("MODEL KEY: validateImageModelKey contract", () => {
    assertEq(validateImageModelKey(undefined).ok, true, "absent is valid");
    assertEq((validateImageModelKey(undefined) as { modelKey: string }).modelKey, "gemini_image", "absent → default");
    assertEq((validateImageModelKey(null) as { modelKey: string }).modelKey, "gemini_image", "null → default");
    assertEq((validateImageModelKey("") as { modelKey: string }).modelKey, "gemini_image", "empty → default");
    assertEq((validateImageModelKey("  ") as { modelKey: string }).modelKey, "gemini_image", "whitespace → default");
    assertEq((validateImageModelKey("gpt_image") as { modelKey: string }).modelKey, "gpt_image", "canonical passthrough");
    assertEq((validateImageModelKey("nano_banana") as { modelKey: string }).modelKey, "gemini_image", "alias normalised");
    assertEq(validateImageModelKey("nope").ok, false, "unknown rejected");
    assertEq(validateImageModelKey(7).ok, false, "non-string rejected");
    // The rejected value is attacker-controlled and gets rendered into a user-facing
    // string, so it must not be echoed back.
    const detail = (validateImageModelKey("<script>x</script>") as { detail: string }).detail;
    assert(!detail.includes("<script>"), "the rejected value is not echoed into the error detail");
    assertEq(CANONICAL_IMAGE_MODEL_KEYS.length, 2, "the closed set stays closed (gemini_image, gpt_image)");
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // DURABLE RATE LIMIT on /api/generate (image-generation hardening)
  // ══════════════════════════════════════════════════════════════════════════════
  // An ABUSE CEILING on request velocity. The existing os.tmpdir() TTL lock is
  // per-Lambda-instance and cannot bound total spend; this bucket is the shared
  // Postgres window. Every denial assertion also requires ZERO outbound moderation
  // calls and ZERO dispatch — a 429 that still burned the paid moderation batch
  // would pass a status-only test and still cost money.

  const { RATE_LIMITS, windowStartMs } = rateLimitModule;
  const GEN_RULE = RATE_LIMITS.image_generation;

  await test("RATE LIMIT: the image_generation bucket exists and is conservative", () => {
    assert(GEN_RULE, "bucket configured");
    assertEq(GEN_RULE.windowSeconds, 300, "5-minute fixed window, like the other buckets");
    assert(GEN_RULE.limit <= 60, `an abuse ceiling, not a quota (${GEN_RULE.limit} <= 60)`);
    assert(GEN_RULE.limit >= 20, `but above every legitimate flow (${GEN_RULE.limit} >= 20)`);
    // The divergence that must not be "unified" away.
    assertEq(GEN_RULE.failClosed, true, "image_generation is the fail-CLOSED bucket");
    assert(!RATE_LIMITS.ai_copy.failClosed, "ai_copy stays fail-open");
    assert(!RATE_LIMITS.ai_copy_analyze.failClosed, "ai_copy_analyze stays fail-open");
    assert(!RATE_LIMITS.quality_judge.failClosed, "quality_judge stays fail-open");
  });

  await test("RATE LIMIT: exceeded → 429 with Retry-After, ZERO provider/enqueue/moderation", async () => {
    resetLimiter();
    const userId = freshUser();
    // Pre-fill this user's current window to the ceiling so the next request denies.
    const windowStart = new Date(windowStartMs(Date.now(), GEN_RULE.windowSeconds)).toISOString();
    limiterStore.fill(`user:${userId}`, "image_generation", windowStart, GEN_RULE.limit);

    const { status, json, res } = await runAs(userId, fullBody());
    assertEq(status, 429, "status");
    assertEq(json.code, "rate_limited", "stable machine-readable code");
    const retryAfter = Number(res.headers.get("Retry-After"));
    assert(Number.isFinite(retryAfter) && retryAfter >= 1, `Retry-After present and positive (got ${res.headers.get("Retry-After")})`);
    assert(retryAfter <= GEN_RULE.windowSeconds, "Retry-After never exceeds the window length");
    assertEq(moderateCallCount, 0, "ZERO outbound moderation calls — the limiter precedes the paid batch");
    assertEq(spawnCount, 0, "ZERO provider dispatch");
    assertEq(enqueueInsertCount, 0, "ZERO enqueue");
  });

  await test("RATE LIMIT: exceeded on the WORKER path too → 429, ZERO enqueue", async () => {
    resetLimiter();
    const userId = freshUser();
    const windowStart = new Date(windowStartMs(Date.now(), GEN_RULE.windowSeconds)).toISOString();
    limiterStore.fill(`user:${userId}`, "image_generation", windowStart, GEN_RULE.limit);

    const { status } = await runAs(userId, fullBody(), "worker");
    assertEq(status, 429, "status");
    assertEq(enqueueInsertCount, 0, "ZERO generation_jobs enqueue");
    assertEq(moderateCallCount, 0, "ZERO outbound moderation calls");
  });

  await test("RATE LIMIT: FAIL CLOSED when the store is unavailable (opposite of ai-copy)", async () => {
    // This is the deliberate divergence. On /api/ai-copy a store outage ADMITS the
    // request; here the most expensive route in the product REFUSES it.
    resetLimiter();
    limiterStore.failing = true;
    const { status, json, res } = await runAs(freshUser(), fullBody());
    assertEq(status, 503, "refused — 503, because an outage is not the caller's fault");
    assertEq(json.code, "rate_limiter_unavailable", "distinct code from a genuine 429");
    assert(res.headers.get("Retry-After"), "Retry-After still offered");
    assertEq(moderateCallCount, 0, "ZERO outbound moderation calls");
    assertEq(spawnCount, 0, "ZERO provider dispatch");
    assertEq(enqueueInsertCount, 0, "ZERO enqueue");
  });

  await test("RATE LIMIT: fail-closed also holds on the worker path", async () => {
    resetLimiter();
    limiterStore.failing = true;
    const { status } = await runAs(freshUser(), fullBody(), "worker");
    assertEq(status, 503, "refused");
    assertEq(enqueueInsertCount, 0, "ZERO enqueue");
  });

  await test("RATE LIMIT: the OTHER buckets still FAIL OPEN (divergence is scoped)", async () => {
    // Guards against a future "unify the limiters" change quietly making the
    // text/vision routes fail closed too — that would be an availability regression.
    resetLimiter();
    limiterStore.failing = true;
    for (const route of ["ai_copy", "ai_copy_analyze", "quality_judge"] as const) {
      const d = await rateLimitModule.consumeRateLimit("u_scoped", route);
      assertEq(d.allowed, true, `${route} still admits during an outage`);
      assertEq(d.reason, "limiter_unavailable", `${route} reports the outage honestly`);
    }
    const gen = await rateLimitModule.consumeRateLimit("u_scoped", "image_generation");
    assertEq(gen.allowed, false, "image_generation refuses");
    assertEq(gen.reason, "limiter_unavailable", "and says why");
  });

  await test("RATE LIMIT: a legitimate usage rate is NOT throttled", async () => {
    // The real worst case for this route: a user generates, then retries every
    // output of a maximum 4-image run, repeatedly. Each retry is ONE request
    // (`mode: retry_single_output`); there is no client fan-out loop on this route.
    // 5 runs x (1 generate + 4 retries) = 25 requests inside one window.
    resetLimiter();
    const userId = freshUser();
    for (let run = 0; run < 5; run++) {
      const gen = await runAs(userId, fullBody({ count: 4 }));
      assertEq(gen.status, 200, `run ${run}: the generate request is served`);
      for (let i = 0; i < 4; i++) {
        const retry = await runAs(userId, fullBody({ mode: "retry_single_output", retryOutputIndex: i }));
        assertEq(retry.status, 200, `run ${run} retry ${i}: served`);
      }
    }
    // 25 admitted requests, still inside the ceiling.
    assert(GEN_RULE.limit > 25, `the chosen limit (${GEN_RULE.limit}) leaves headroom above a 25-request session`);
  });

  await test("RATE LIMIT: the ceiling actually binds after `limit` admitted requests", async () => {
    // Proves the counter is real (not merely that a pre-filled row denies): drive
    // the handler until it flips, and check it flipped at exactly the configured
    // limit, having admitted every request before that.
    resetLimiter();
    const userId = freshUser();
    let admitted = 0;
    let denialStatus = 0;
    for (let i = 0; i < GEN_RULE.limit + 1; i++) {
      const { status } = await runAs(userId, fullBody());
      if (status === 200) { admitted++; continue; }
      denialStatus = status;
      break;
    }
    assertEq(admitted, GEN_RULE.limit, "exactly `limit` requests were admitted");
    assertEq(denialStatus, 429, "request limit+1 is throttled");
  });

  await test("RATE LIMIT: one user's exhausted window does not throttle another user", async () => {
    resetLimiter();
    const victim = freshUser();
    const windowStart = new Date(windowStartMs(Date.now(), GEN_RULE.windowSeconds)).toISOString();
    limiterStore.fill(`user:${freshUser()}`, "image_generation", windowStart, GEN_RULE.limit);
    const { status } = await runAs(victim, fullBody());
    assertEq(status, 200, "an unrelated account is unaffected");
  });

  await test("RATE LIMIT: an anonymous inline caller is limited, not exempt", async () => {
    // The inline path deliberately serves anonymous callers. They must not become an
    // unlimited hole simply by omitting the Authorization header — they are keyed on
    // the SAME `session:`/`anon:` identity the per-user TTL lock already uses.
    resetLimiter();
    const clientId = `anon_client_${Math.random().toString(36).slice(2)}`;
    const windowStart = new Date(windowStartMs(Date.now(), GEN_RULE.windowSeconds)).toISOString();
    limiterStore.fill(`session:${clientId}`, "image_generation", windowStart, GEN_RULE.limit);

    delete process.env.ALLOW_GENERATION_AUTH_TEST_HEADER;
    try {
      process.env.MODERATION_MOCK_DECISION = "allow";
      process.env.GENERATION_MODE = "inline";
      spawnCount = 0; enqueueInsertCount = 0; moderateCallCount = 0;
      delete require.cache[require.resolve("../src/app/api/generate/route")];
      const route = await import(`../src/app/api/generate/route?anonlimit=${Math.random()}`);
      const res = await route.POST(makeAnonReq(fullBody({ studioClientId: clientId })) as never);
      assertEq(res.status, 429, "an anonymous caller is throttled on its stable session identity");
      assertEq(moderateCallCount, 0, "ZERO outbound moderation calls");
      assertEq(spawnCount, 0, "ZERO dispatch");
    } finally {
      process.env.ALLOW_GENERATION_AUTH_TEST_HEADER = "true";
    }
  });

  await test("RATE LIMIT: the anonymous inline path still WORKS when under the ceiling", async () => {
    // The documented anonymous path must not be broken by the limiter — only bounded.
    resetLimiter();
    const { status, json } = await runAnon("allow", fullBody(), "inline");
    assertEq(status, 200, "anonymous inline generation still succeeds");
    assertEq(json.ok, true, "ok");
    assertEq(spawnCount, 1, "dispatched once");
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
