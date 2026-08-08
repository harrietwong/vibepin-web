/**
 * AI-copy TEXT-metering tests (Phase 4T — SHADOW mode).
 * Run: npx tsx scripts/test-text-metering.ts   (registered in CORE)
 *
 * Proves the metering wiring in /api/ai-copy WITHOUT a real ledger or DB:
 *   - OFF mode (the default): ZERO ledger calls, response byte-unchanged — prod safe.
 *   - SHADOW happy path: exactly ONE usage_reserve (ai_text_generation, slots ["s0"])
 *     + ONE settle-succeeded, no matter how many internal model calls fired.
 *   - SHADOW quality-gate fail: reserve then RELEASE → net zero charge.
 *   - SHADOW ledger failure (rpc throws / errors): generation still PROCEEDS (fail-open,
 *     the inverse of the moderation gate) and the response is unchanged.
 *   - 401 (no auth): ZERO ledger calls (auth precedes metering).
 *   - internal quality-gate retry: STILL exactly ONE reserve + ONE settle (F2).
 *   - Module-unit contract of meterTextGeneration (single slot, ai_text_generation type,
 *     text_generation operation, enforce limit body).
 *
 * Seams (same idiom as test-ai-provider-auth-boundary.ts + test-generation-metering.ts):
 * getUserIdFromBearerOrCookies, the visionServer provider helpers and the keyword lookup
 * are faked so no network/provider key is needed; @/lib/supabase is faked so no DB is
 * touched and `createServerClient().rpc` is a counting spy over the usage_* RPCs; the
 * rate limiter store is faked so consumeRateLimit is deterministic.
 *
 * The route reads USAGE_METERING_MODE at REQUEST time (usageMeteringMode() reads the env
 * live), but the module is still re-imported per run so mode changes take clean effect;
 * tsx's CJS cache is keyed on the resolved path (`?query=` busters do NOT create a new
 * entry — delete require.cache[require.resolve(...)] is what forces re-evaluation).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

import { Module } from "node:module";

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

// ── Auth seam ───────────────────────────────────────────────────────────────────
const VALID_BEARER = "valid-access-token";
function fakeGetUserIdFromBearerOrCookies(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  return Promise.resolve(bearer === VALID_BEARER ? "user-text-1" : null);
}

// ── Ledger RPC spy over the fake supabase client ────────────────────────────────
type RpcCall = { fn: string; args: Record<string, unknown> };
let rpcCalls: RpcCall[] = [];
// Controls what the reserve RPC returns, plus whether rpc() THROWS (unreachable DB).
type LedgerMode = "reserve_ok" | "reserve_insufficient" | "reserve_error" | "reserve_throws";
let ledgerMode: LedgerMode = "reserve_ok";

function ledgerResult(fn: string): { data: unknown; error: { message: string; code?: string } | null } {
  if (fn === "usage_ensure_account") {
    return { data: { ok: true, action: "created", account_id: "acct-1" }, error: null };
  }
  if (fn === "usage_reserve") {
    if (ledgerMode === "reserve_error") return { data: null, error: { message: "ledger down" } };
    if (ledgerMode === "reserve_insufficient") {
      return { data: { ok: false, reason: "insufficient_capacity", available_recurring: 0, available_bonus: 0 }, error: null };
    }
    return { data: { ok: true, replayed: false, reservation_id: "res-text-1" }, error: null };
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
        getUserById: async (id: string) => ({
          data: { user: { id, email: "u@example.com", created_at: new Date().toISOString(), app_metadata: {} } },
          error: null,
        }),
      },
    },
    from(_table: string) {
      return {
        select() {
          const chain = {
            eq() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
                single: async () => ({ data: null, error: null }),
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
      if (ledgerMode === "reserve_throws" && fn === "usage_reserve") {
        throw new Error("supabase unreachable");
      }
      return ledgerResult(fn);
    },
  };
}

// ── visionServer provider seams (wrap the REAL module; only paid seams stubbed) ──
const calls = { generateCopyFromAnalysis: 0, chatJson: 0, retrievePinterestKeywords: 0 };
function resetCalls() { calls.generateCopyFromAnalysis = 0; calls.chatJson = 0; calls.retrievePinterestKeywords = 0; }

// Gate behaviour per generateCopyFromAnalysis call:
//   "pass"       — every call returns good copy (no retry).
//   "fail"       — every call returns bad copy (gate fails → retry also fails → 422).
//   "fail_then_pass" — first call bad (forces the internal retry), retry good → 200.
let gateBehaviour: "pass" | "fail" | "fail_then_pass" = "pass";
let genCallSeq = 0;
function goodCopy() {
  return {
    title: "A cozy handmade ceramic mug for slow mornings",
    description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home with soft light.",
    altText: "White ceramic mug on linen",
    imageSummary: "A test image summary",
    visibleObjects: ["mug"],
    colors: ["white"],
    style: "minimal",
    keywords: ["ceramic mug"],
  };
}
function badCopy() {
  // Empty title reliably fails qualityIssues regardless of preset thresholds.
  return { ...goodCopy(), title: "", description: "" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: fakeGetUserIdFromBearerOrCookies };
  }
  // Match @/lib/supabase AND the relative ../supabase spellings lib/server/** uses.
  if (request === "@/lib/supabase" || /(^|[\\/])(\.\.[\\/])*supabase(\.ts)?$/.test(request)) {
    return { createServerClient: fakeServerClient };
  }
  if (request.includes("ai-copy/visionServer")) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      providerConfig: () => ({
        provider: "test", key: "test-key", baseUrl: "https://provider.example",
        textModel: "test-text", visionModel: "test-vision",
      }),
      generateCopyFromAnalysis: async () => {
        const seq = genCallSeq++;
        calls.generateCopyFromAnalysis++;
        if (gateBehaviour === "fail") return badCopy();
        if (gateBehaviour === "fail_then_pass") return seq === 0 ? badCopy() : goodCopy();
        return goodCopy();
      },
      chatJson: async () => { calls.chatJson++; return { title: "Refined", description: "Refined description" }; },
    };
  }
  if (request.includes("ai-copy/keywordContext")) {
    return {
      retrievePinterestKeywords: async () => {
        calls.retrievePinterestKeywords++;
        return { queryTerms: [], candidates: [], recommended: [], rejected: [], poolSize: 0 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ── Rate-limit fake (route consumes ai_copy before metering) ────────────────────
class FakeLimiterStore {
  async read() { return null; }
  async create() { return true; }
  async bump() { return true; }
  async prune() {}
}
const rateLimitModule = require("../src/lib/server/rateLimit") as typeof import("../src/lib/server/rateLimit");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
rateLimitModule.__setRateLimitStoreForTests(new FakeLimiterStore() as any);

// ── Request bodies ──────────────────────────────────────────────────────────────
// Fast text path: a cached analysis + recommended keywords → ONE generateCopyFromAnalysis.
function happyBody(): Record<string, unknown> {
  return {
    draftId: "d1",
    imageUrl: "https://cdn.example/img.png",
    language: "en",
    imageAnalysis: {
      status: "ready",
      imageSummary: "A test image summary",
      visibleObjects: ["mug"],
      colors: ["white"],
      style: "minimal",
      ocrText: "",
      category: "home",
    },
    recommendedKeywords: ["ceramic mug"],
  };
}
function makeReq(auth: boolean, body: Record<string, unknown> = happyBody()): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${VALID_BEARER}`;
  return new Request("https://vibepin.co/api/ai-copy", { method: "POST", headers, body: JSON.stringify(body) });
}

type RunOpts = { meterMode?: "off" | "shadow" | "enforce"; ledger?: LedgerMode; auth?: boolean; gate?: "pass" | "fail" | "fail_then_pass"; body?: Record<string, unknown> };
async function run(opts: RunOpts = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const meter = opts.meterMode ?? "off";
  if (meter === "off") delete process.env.USAGE_METERING_MODE;
  else process.env.USAGE_METERING_MODE = meter;
  ledgerMode = opts.ledger ?? "reserve_ok";
  gateBehaviour = opts.gate ?? "pass";
  genCallSeq = 0;
  rpcCalls = [];
  resetCalls();
  try {
    delete require.cache[require.resolve("../src/app/api/ai-copy/route")];
    const route = await import("../src/app/api/ai-copy/route");
    const res = await route.POST(makeReq(opts.auth ?? true, opts.body ?? happyBody()) as never);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  } finally {
    delete process.env.USAGE_METERING_MODE;
  }
}

const ledgerCalls = () => rpcCalls.filter(c => c.fn.startsWith("usage_"));
const reserveCalls = () => rpcCalls.filter(c => c.fn === "usage_reserve");
const settleCalls = () => rpcCalls.filter(c => c.fn === "usage_settle_reservation_item");
const releaseCalls = () => rpcCalls.filter(c => c.fn === "usage_release_reservation");

// The byte-for-byte response an OFF-mode happy run produces — the invariant metering
// must never disturb (F7: no `usage` field, output unchanged).
function assertHappyOutput(json: Record<string, unknown>) {
  assertEq(json.ok, true, "ok");
  assert(json.usage === undefined, "no `usage` field added to the response (F7)");
  const output = json.output as Record<string, unknown>;
  assert(output && typeof output === "object", "output present");
  assert(typeof output.title === "string" && (output.title as string).length > 0, "title present");
  assert(typeof output.description === "string", "description present");
  assert(Array.isArray(output.tags), "tags array");
  assert(Array.isArray(output.keywords), "keywords array");
}

async function main() {
  console.log("\nAI-copy TEXT-metering tests (Phase 4T shadow)\n");

  // ── Module-unit contract ─────────────────────────────────────────────────────
  const meter = await import("../src/lib/server/usage/meterTextGeneration");

  await test("UNIT: single canonical slot key ['s0']", () => {
    assertEq([...meter.TEXT_SLOT_KEYS].join(","), "s0", "one text slot");
  });

  await test("UNIT: reserve OFF → no ledger call, kind 'off'", async () => {
    delete process.env.USAGE_METERING_MODE;
    const r = await meter.reserveTextGeneration({ userId: "u1", generationRequestId: "req_1" });
    assertEq(r.kind, "off", "off mode short-circuits before any RPC");
  });

  await test("UNIT: reserve SHADOW calls usage_reserve with ai_text_generation + text_generation", async () => {
    process.env.USAGE_METERING_MODE = "shadow";
    const seen: RpcCall[] = [];
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      seen.push({ fn, args });
      if (fn === "usage_reserve") return { data: { ok: true, reservation_id: "res-u" }, error: null };
      return { data: { ok: true }, error: null };
    };
    const ensure = (async () => ({ ok: true })) as never;
    const r = await meter.reserveTextGeneration({ userId: "u1", generationRequestId: "req_1", deps: { rpc, ensure } });
    assertEq(r.kind, "reserved", "reserved");
    const reserve = seen.find(c => c.fn === "usage_reserve");
    assert(!!reserve, "usage_reserve was called");
    assertEq(reserve!.args.p_usage_type, "ai_text_generation", "usage_type");
    assertEq(reserve!.args.p_operation, "text_generation", "operation");
    assertEq((reserve!.args.p_slot_keys as string[]).join(","), "s0", "single slot key");
    delete process.env.USAGE_METERING_MODE;
  });

  await test("UNIT: enforce limit body uses the ai_text_limit_reached envelope", () => {
    const b = meter.aiTextLimitResponseBody("req_1");
    assertEq(b.code, "ai_text_limit_reached", "code");
    assertEq(b.error_type, "ai_text_limit_reached", "error_type");
    assertEq(b.ok, false, "ok:false");
    assertEq(b.requestId, "req_1", "request id echoed");
    assert(typeof b.userMessage === "string" && (b.userMessage as string).length > 0, "user-safe message");
  });

  // ── OFF MODE — the default; ZERO ledger calls, response byte-unchanged ─────────
  await test("OFF: happy path makes ZERO ledger calls and returns unchanged copy", async () => {
    const { status, json } = await run({ meterMode: "off" });
    assertEq(status, 200, "status");
    assertHappyOutput(json);
    assertEq(ledgerCalls().length, 0, "no ledger RPC in off mode");
    assertEq(calls.generateCopyFromAnalysis, 1, "one model call (fast path)");
  });

  // ── SHADOW MODE — reserve+settle once, failures never block ───────────────────
  await test("SHADOW happy: exactly ONE reserve + ONE settle-succeeded", async () => {
    const { status, json } = await run({ meterMode: "shadow", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertHappyOutput(json);
    assertEq(reserveCalls().length, 1, "exactly one reserve");
    const reserve = reserveCalls()[0];
    assertEq(reserve.args.p_usage_type, "ai_text_generation", "usage_type ai_text_generation");
    assertEq((reserve.args.p_slot_keys as string[]).join(","), "s0", "single slot");
    assertEq(settleCalls().length, 1, "exactly one settle");
    assertEq(settleCalls()[0].args.p_outcome, "succeeded", "settled as succeeded");
    assertEq(releaseCalls().length, 0, "no release on success");
  });

  await test("SHADOW internal retry (first fails gate, retry passes): still ONE reserve + ONE settle (F2)", async () => {
    const { status, json } = await run({ meterMode: "shadow", ledger: "reserve_ok", gate: "fail_then_pass" });
    assertEq(status, 200, "the internal retry recovered → 200");
    assertHappyOutput(json);
    // The route fired TWO model calls (initial + internal quality-gate retry)...
    assertEq(calls.generateCopyFromAnalysis, 2, "the internal retry actually fired");
    // ...but metering still saw exactly one reserve and one settle. (F2.)
    assertEq(reserveCalls().length, 1, "one reserve despite two internal model calls");
    assertEq(settleCalls().length, 1, "one settle despite two internal model calls");
    assertEq(releaseCalls().length, 0, "no release on the recovered success");
  });

  await test("SHADOW quality-gate fail (both attempts bad): reserve then RELEASE, net zero charge", async () => {
    const { status, json } = await run({ meterMode: "shadow", ledger: "reserve_ok", gate: "fail" });
    assertEq(status, 422, "quality gate failure surfaces as 422");
    assertEq(json.ok, false, "ok:false");
    assertEq(reserveCalls().length, 1, "reserved once");
    assertEq(settleCalls().length, 0, "no settle-succeeded on failure");
    assertEq(releaseCalls().length, 1, "reservation released → net zero charge");
    // Internal retry fired (first + retry both bad) → still ONE reserve, ONE release.
    assert(calls.generateCopyFromAnalysis >= 2, "the internal retry did fire");
  });

  await test("SHADOW ledger error: generation PROCEEDS (fail-open), no settle", async () => {
    const { status, json } = await run({ meterMode: "shadow", ledger: "reserve_error" });
    assertEq(status, 200, "still generates despite the ledger error");
    assertHappyOutput(json);
    assertEq(settleCalls().length, 0, "no settle when reserve failed");
    assertEq(releaseCalls().length, 0, "no release when nothing was reserved");
  });

  await test("SHADOW ledger THROWS (Supabase unreachable): generation still PROCEEDS", async () => {
    const { status, json } = await run({ meterMode: "shadow", ledger: "reserve_throws" });
    assertEq(status, 200, "an rpc that throws must not break generation (fail-open)");
    assertHappyOutput(json);
  });

  // ── AUTH — a 401 never touches the ledger ─────────────────────────────────────
  await test("AUTH: unauthenticated request → 401, ZERO ledger calls", async () => {
    const { status, json } = await run({ meterMode: "shadow", auth: false });
    assertEq(status, 401, "401");
    assertEq(json.error, "unauthenticated", "unauthenticated");
    assertEq(ledgerCalls().length, 0, "auth precedes metering — no ledger call");
  });

  // ── ENFORCE — the branch exists (not enabled in prod) ─────────────────────────
  await test("ENFORCE: insufficient balance → 402 ai_text_limit_reached, no generation", async () => {
    const { status, json } = await run({ meterMode: "enforce", ledger: "reserve_insufficient" });
    assertEq(status, 402, "limit response status");
    assertEq(json.code, "ai_text_limit_reached", "code");
    assertEq(calls.generateCopyFromAnalysis, 0, "no model call when the limit was reached");
    assertEq(settleCalls().length, 0, "nothing to settle");
  });

  await test("ENFORCE: sufficient balance still generates normally", async () => {
    const { status, json } = await run({ meterMode: "enforce", ledger: "reserve_ok" });
    assertEq(status, 200, "status");
    assertHappyOutput(json);
    assertEq(reserveCalls().length, 1, "reserved once");
    assertEq(settleCalls().length, 1, "settled once");
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
