/**
 * Per-user durable rate limiting on the AI provider routes (Phase 1B PR2).
 * Run: npx tsx scripts/test-ai-provider-rate-limit.ts
 *
 * PR1 (test-ai-provider-auth-boundary.ts) put authentication on /api/ai-copy,
 * /api/ai-copy/analyze and /api/quality-judge. That converted UNLIMITED ANONYMOUS
 * provider spend into UNLIMITED PER-ACCOUNT provider spend: a disposable or
 * compromised account could still run up unbounded cost. This suite pins the ceiling.
 *
 * THE POINT OF THIS SUITE: a 429 that still burned a vision call would pass a
 * status-code-only test and still cost money. So every denial assertion also counts
 * the provider seams (fetchImageAsDataUrl / chatJson / analyzeImageStructured /
 * judgeImageQuality) and requires EXACTLY ZERO.
 *
 * FAKE STORE FIDELITY (read this before trusting the concurrency test): the fake
 * store below models the two Postgres constraints the real limiter depends on —
 *   (a) `create` enforces PRIMARY KEY uniqueness: a second create for the same
 *       (user, route, window_start) returns false, exactly as the real store maps
 *       error.code "23505" to false;
 *   (b) `bump` is a real compare-and-swap: it applies ONLY while the stored `hits`
 *       still equals the value the caller read, exactly as the real store's
 *       `.eq("hits", seen).select()` matched-row count decides.
 * Both are evaluated synchronously against a single shared Map inside one
 * already-resolved microtask, so an interleaving that would be a lost race in
 * Postgres is a lost race here too. See the "concurrency" tests.
 *
 * Fakes are injected through Module._load (same idiom as
 * test-ai-provider-auth-boundary.ts). No network, no DB, no provider key needed.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

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

// ── Provider seam spies ─────────────────────────────────────────────────────────

const calls = {
  fetchImageAsDataUrl: 0,
  chatJson: 0,
  analyzeImageStructured: 0,
  judgeImageQuality: 0,
  generateCopyFromAnalysis: 0,
  analyzeAndWriteCopy: 0,
  retrievePinterestKeywords: 0,
};
function resetCalls() {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
}
/** Total provider-SPEND calls across the four seams the brief requires counting. */
function providerCalls(): number {
  return calls.fetchImageAsDataUrl + calls.chatJson + calls.analyzeImageStructured + calls.judgeImageQuality;
}

// ── Injected auth ───────────────────────────────────────────────────────────────
// A bearer token maps 1:1 to a user id, so a test can drive two distinct accounts.

function fakeGetUserIdFromBearerOrCookies(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!bearer) return Promise.resolve(null);
  return Promise.resolve(bearer); // token IS the user id in this harness
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: fakeGetUserIdFromBearerOrCookies };
  }
  if (request.includes("ai-copy/visionServer")) {
    // Wrap the REAL module so pure helpers keep their real behaviour; only the seams
    // that spend money become counting stubs.
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      providerConfig: () => ({
        provider: "test",
        key: "test-key",
        baseUrl: "https://provider.example",
        textModel: "test-text",
        visionModel: "test-vision",
      }),
      fetchImageAsDataUrl: async () => {
        calls.fetchImageAsDataUrl++;
        return { dataUrl: "data:image/png;base64,AAAA", bytes: 4, latencyMs: 1 };
      },
      chatJson: async () => {
        calls.chatJson++;
        return { title: "Refined title", description: "Refined description" };
      },
      analyzeImageStructured: async () => {
        calls.analyzeImageStructured++;
        return {
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          ocrText: "",
          category: "home",
        };
      },
      analyzeAndWriteCopy: async () => {
        calls.analyzeAndWriteCopy++;
        return {
          title: "A cozy handmade ceramic mug for slow mornings",
          description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
          altText: "White ceramic mug on linen",
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          keywords: ["ceramic mug"],
        };
      },
      generateCopyFromAnalysis: async () => {
        calls.generateCopyFromAnalysis++;
        return {
          title: "A cozy handmade ceramic mug for slow mornings",
          description: "A cozy handmade ceramic mug photographed on a linen surface, perfect for slow mornings at home.",
          altText: "White ceramic mug on linen",
          imageSummary: "A test image summary",
          visibleObjects: ["mug"],
          colors: ["white"],
          style: "minimal",
          keywords: ["ceramic mug"],
        };
      },
    };
  }
  if (request.includes("ai-copy/qualityJudgeServer")) {
    return {
      judgeImageQuality: async () => {
        calls.judgeImageQuality++;
        return {
          scores: { relevance: 4, composition: 4, realism: 4, text: 4, safety: 5 },
          reasons: ["internal"],
        };
      },
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

// ── The fake durable store ──────────────────────────────────────────────────────
// Models the REAL Postgres constraints the limiter relies on. If this fake were not
// atomic, the concurrency test would prove nothing — so it is deliberately written
// to reject exactly what Postgres would reject:
//
//   create() → PRIMARY KEY (vibepin_user_id, route, window_start). A second create
//              for a key that already exists returns false, mirroring the real
//              store mapping error.code === "23505" to false.
//   bump()   → UPDATE … SET hits = seen+1 WHERE … AND hits = seen. Applies only
//              while the stored value still equals what the caller read, mirroring
//              `.eq("hits", seen).select()` returning 0 rows on a lost race.
//
// Both read and write the shared Map in ONE synchronous block, so no other caller
// can interleave between the check and the write — the same all-or-nothing property
// a single Postgres statement has. Concurrency is exercised by driving many route
// handlers in parallel with Promise.all: each one awaits the store between its read
// and its write, which is precisely where a non-atomic limiter would double-admit.

type StoreKey = { userId: string; route: string; windowStart: string };
const keyOf = (k: StoreKey) => `${k.userId}|${k.route}|${k.windowStart}`;

class FakeStore {
  rows = new Map<string, { hits: number; createdAt: number }>();
  /** When set, every operation throws — simulates Supabase being unreachable. */
  failing = false;
  pruneCalls: Array<{ key: string; olderThan: string }> = [];
  createAttempts = 0;
  bumpLosses = 0;

  private guard() {
    if (this.failing) throw new Error("simulated supabase outage");
  }
  async read(k: StoreKey) {
    this.guard();
    const row = this.rows.get(keyOf(k));
    return row ? { hits: row.hits } : null;
  }
  async create(k: StoreKey) {
    this.guard();
    this.createAttempts++;
    const id = keyOf(k);
    if (this.rows.has(id)) return false; // ← PRIMARY KEY violation (23505)
    this.rows.set(id, { hits: 1, createdAt: Date.now() });
    return true;
  }
  async bump(k: StoreKey, seen: number) {
    this.guard();
    const id = keyOf(k);
    const row = this.rows.get(id);
    // ← CAS: `WHERE hits = seen`. Zero matched rows ⇒ someone else moved it.
    if (!row || row.hits !== seen) { this.bumpLosses++; return false; }
    row.hits = seen + 1;
    return true;
  }
  async prune(k: StoreKey, olderThanIso: string) {
    this.guard();
    this.pruneCalls.push({ key: keyOf(k), olderThan: olderThanIso });
  }
}

// The limiter module is loaded ONCE and shared: the routes import the same instance
// (module identity via the CJS cache), so installing the fake store here is what the
// route handlers see.
const rateLimitModule = require("../src/lib/server/rateLimit") as typeof import("../src/lib/server/rateLimit");
const { RATE_LIMITS, __setRateLimitStoreForTests, consumeRateLimit, windowStartMs, secondsUntilWindowEnd } = rateLimitModule;

let store = new FakeStore();
function resetStore() {
  store = new FakeStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setRateLimitStoreForTests(store as any);
}

// ── Route loading ───────────────────────────────────────────────────────────────
// Under tsx these dynamic imports resolve through the CJS require cache, keyed on the
// RESOLVED FILE PATH — a `?x=` cache-buster does nothing. Evicting the entry is what
// forces re-evaluation.

const ROUTES = {
  "ai-copy": "../src/app/api/ai-copy/route",
  analyze: "../src/app/api/ai-copy/analyze/route",
  "quality-judge": "../src/app/api/quality-judge/route",
} as const;
type RouteName = keyof typeof ROUTES;

const URLS: Record<RouteName, string> = {
  "ai-copy": "https://vibepin.co/api/ai-copy",
  analyze: "https://vibepin.co/api/ai-copy/analyze",
  "quality-judge": "https://vibepin.co/api/quality-judge",
};

/** Route name → the limiter key that route consumes. */
const ROUTE_KEY: Record<RouteName, keyof typeof RATE_LIMITS> = {
  "ai-copy": "ai_copy",
  analyze: "ai_copy_analyze",
  "quality-judge": "quality_judge",
};

async function loadRoute(name: RouteName): Promise<{ POST: (req: Request) => Promise<Response> }> {
  const spec = ROUTES[name];
  delete require.cache[require.resolve(spec)];
  return import(spec) as Promise<{ POST: (req: Request) => Promise<Response> }>;
}

/** Cached handlers — evicting the route cache per call would be pointless churn and
 *  would NOT reset the limiter (its state lives in the store, not the module). */
const handlers: Partial<Record<RouteName, { POST: (req: Request) => Promise<Response> }>> = {};
async function handler(name: RouteName) {
  if (!handlers[name]) handlers[name] = await loadRoute(name);
  return handlers[name]!;
}

function happyBody(name: RouteName): unknown {
  if (name === "ai-copy") {
    return {
      draftId: "d1",
      imageUrl: "https://cdn.example/img.png",
      language: "en",
      // Cached analysis → fast text path (one generateCopyFromAnalysis call).
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
  return { draftId: "d1", imageUrl: "https://cdn.example/img.png" };
}

function makeReq(name: RouteName, userId: string): Request {
  return new Request(URLS[name], {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userId}` },
    body: JSON.stringify(happyBody(name)),
  });
}

async function call(name: RouteName, userId: string) {
  const h = await handler(name);
  const res = await h.POST(makeReq(name, userId));
  const json = (await res.json()) as { ok?: boolean; error?: string; userMessage?: string };
  return { res, json };
}

/**
 * Pre-fill the store so `n` slots of `route`'s window are already consumed by `userId`,
 * WITHOUT going through the routes (keeps provider-call counters meaningful).
 */
function preconsume(userId: string, route: RouteName, n: number, nowMs = Date.now()) {
  const rule = RATE_LIMITS[ROUTE_KEY[route]];
  const ws = new Date(windowStartMs(nowMs, rule.windowSeconds)).toISOString();
  store.rows.set(`${userId}|${ROUTE_KEY[route]}|${ws}`, { hits: n, createdAt: nowMs });
}

const ALL: RouteName[] = ["ai-copy", "analyze", "quality-judge"];

async function main() {
  console.log("\nAI provider route per-user rate limits\n");

  // ── 1. Under the limit → success; the request that exceeds it → 429 + ZERO spend ──

  for (const name of ALL) {
    const rule = RATE_LIMITS[ROUTE_KEY[name]];

    await test(`${name}: request under the limit succeeds`, async () => {
      resetStore();
      preconsume("u1", name, rule.limit - 2);
      resetCalls();
      const { res, json } = await call(name, "u1");
      assertEq(res.status, 200, "status");
      assertEq(json.ok, true, "ok flag");
      // The route genuinely ran to completion rather than being short-circuited. Note
      // /api/ai-copy's FAST path (cached analysis) spends via generateCopyFromAnalysis
      // and never touches the four raw seams, so count spend seams + copy seams here.
      const spent = providerCalls() + calls.generateCopyFromAnalysis + calls.analyzeAndWriteCopy;
      assert(spent > 0, `a provider seam actually ran (the route was not short-circuited), got ${spent}`);
    });

    await test(`${name}: the request that EXCEEDS the limit returns 429`, async () => {
      resetStore();
      preconsume("u1", name, rule.limit); // window already full
      resetCalls();
      const { res, json } = await call(name, "u1");
      assertEq(res.status, 429, "status");
      assertEq(json.ok, false, "ok flag");
      assertEq(json.error, "rate_limited", "stable error code");
      assert(typeof json.userMessage === "string" && json.userMessage.length > 0, "userMessage present");
      assert(!/rate_limited/.test(json.userMessage ?? ""), "userMessage is user-safe, not the raw code");
    });

    await test(`${name}: the 429 invokes ZERO provider calls`, async () => {
      resetStore();
      preconsume("u1", name, rule.limit);
      resetCalls();
      const { res } = await call(name, "u1");
      assertEq(res.status, 429, "status");
      assertEq(calls.fetchImageAsDataUrl, 0, "fetchImageAsDataUrl calls");
      assertEq(calls.chatJson, 0, "chatJson calls");
      assertEq(calls.analyzeImageStructured, 0, "analyzeImageStructured calls");
      assertEq(calls.judgeImageQuality, 0, "judgeImageQuality calls");
      assertEq(providerCalls(), 0, "TOTAL provider calls");
      // Nothing downstream ran either.
      assertEq(calls.generateCopyFromAnalysis, 0, "generateCopyFromAnalysis calls");
      assertEq(calls.analyzeAndWriteCopy, 0, "analyzeAndWriteCopy calls");
      assertEq(calls.retrievePinterestKeywords, 0, "retrievePinterestKeywords calls");
    });

    await test(`${name}: the 429 carries a sane Retry-After`, async () => {
      resetStore();
      preconsume("u1", name, rule.limit);
      const { res } = await call(name, "u1");
      assertEq(res.status, 429, "status");
      const raw = res.headers.get("retry-after");
      assert(raw !== null, "Retry-After header present");
      const secs = Number(raw);
      assert(Number.isInteger(secs), `Retry-After is an integer number of seconds (got ${raw})`);
      assert(secs >= 1, "Retry-After >= 1");
      assert(secs <= rule.windowSeconds, `Retry-After never exceeds the window (${rule.windowSeconds}s)`);
    });
  }

  // ── 2. Per-user isolation ────────────────────────────────────────────────────

  await test("per-user: user A exhausting the limit does NOT throttle user B", async () => {
    resetStore();
    const rule = RATE_LIMITS.ai_copy;
    preconsume("userA", "ai-copy", rule.limit);

    resetCalls();
    const a = await call("ai-copy", "userA");
    assertEq(a.res.status, 429, "user A is limited");
    assertEq(providerCalls(), 0, "user A spent nothing");

    resetCalls();
    const b = await call("ai-copy", "userB");
    assertEq(b.res.status, 200, "user B is unaffected");
    assertEq(b.json.ok, true, "user B ok flag");
    assertEq(calls.generateCopyFromAnalysis, 1, "user B reached the provider");
  });

  await test("per-user: many users each get their OWN full allowance", async () => {
    resetStore();
    const rule = RATE_LIMITS.quality_judge;
    for (const u of ["ua", "ub", "uc"]) preconsume(u, "quality-judge", rule.limit - 1);
    for (const u of ["ua", "ub", "uc"]) {
      const { res } = await call("quality-judge", u);
      assertEq(res.status, 200, `${u} still has its last slot`);
    }
    for (const u of ["ua", "ub", "uc"]) {
      const { res } = await call("quality-judge", u);
      assertEq(res.status, 429, `${u} is now exhausted`);
    }
  });

  // ── 3. Per-route isolation ───────────────────────────────────────────────────

  await test("per-route: exhausting /api/ai-copy does NOT throttle /api/quality-judge", async () => {
    resetStore();
    preconsume("u1", "ai-copy", RATE_LIMITS.ai_copy.limit);

    const copy = await call("ai-copy", "u1");
    assertEq(copy.res.status, 429, "ai-copy is limited");

    resetCalls();
    const judge = await call("quality-judge", "u1");
    assertEq(judge.res.status, 200, "quality-judge is unaffected");
    assertEq(calls.judgeImageQuality, 1, "the judge seam ran");
  });

  await test("per-route: exhausting /api/ai-copy/analyze does NOT throttle /api/ai-copy", async () => {
    resetStore();
    preconsume("u1", "analyze", RATE_LIMITS.ai_copy_analyze.limit);

    const an = await call("analyze", "u1");
    assertEq(an.res.status, 429, "analyze is limited");

    resetCalls();
    const copy = await call("ai-copy", "u1");
    assertEq(copy.res.status, 200, "ai-copy is unaffected");
    assertEq(calls.generateCopyFromAnalysis, 1, "the copy seam ran");
  });

  // ── 4. Concurrency: N simultaneous requests, limit M < N → exactly M succeed ──
  // This is the test the whole durable design exists for. A read-then-write limiter
  // (or a non-atomic fake) would over-admit here.

  await test("concurrency: 8 simultaneous requests against 3 remaining slots → exactly 3 succeed", async () => {
    resetStore();
    const rule = RATE_LIMITS.quality_judge;
    const remaining = 3;
    preconsume("u1", "quality-judge", rule.limit - remaining);
    resetCalls();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => call("quality-judge", "u1")),
    );
    const ok = results.filter(r => r.res.status === 200).length;
    const denied = results.filter(r => r.res.status === 429).length;
    assertEq(ok, remaining, "successes exactly equal the remaining slots");
    assertEq(denied, 8 - remaining, "everyone else is denied");
    // Spend is bounded by admissions, not by request count: 1 image fetch + 1 judge
    // call per admitted request, and nothing at all for the denied ones.
    assertEq(calls.judgeImageQuality, remaining, "provider calls == admitted requests");
    assertEq(calls.fetchImageAsDataUrl, remaining, "image fetches == admitted requests");
  });

  await test("concurrency: the LAST remaining slot is taken by exactly one of 12 racers", async () => {
    resetStore();
    const rule = RATE_LIMITS.ai_copy_analyze;
    preconsume("u1", "analyze", rule.limit - 1); // exactly one slot left
    resetCalls();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => call("analyze", "u1")),
    );
    assertEq(results.filter(r => r.res.status === 200).length, 1, "exactly one winner");
    assertEq(results.filter(r => r.res.status === 429).length, 11, "eleven denied");
    assertEq(calls.analyzeImageStructured, 1, "exactly one vision call was paid for");
  });

  await test("concurrency: the fake store really did contend (lost CAS races observed)", async () => {
    // Guards against a false-green: if the harness serialised everything, the
    // concurrency tests above would pass trivially without exercising the CAS at all.
    resetStore();
    const rule = RATE_LIMITS.quality_judge;
    preconsume("u1", "quality-judge", rule.limit - 6);
    await Promise.all(Array.from({ length: 10 }, () => call("quality-judge", "u1")));
    assert(store.bumpLosses > 0, `at least one CAS race was lost (got ${store.bumpLosses})`);
  });

  await test("concurrency: simultaneous FIRST requests → one creates the row, the rest CAS onto it", async () => {
    // Exercises the 23505 creation-race path specifically: an empty window plus many
    // simultaneous callers. All are under the limit, so all must be admitted exactly
    // once each — the counter must end at exactly N, never less (double-admit) .
    resetStore();
    const n = 10;
    await Promise.all(Array.from({ length: n }, () => call("quality-judge", "u1")));
    const rule = RATE_LIMITS.quality_judge;
    const ws = new Date(windowStartMs(Date.now(), rule.windowSeconds)).toISOString();
    const row = store.rows.get(`u1|quality_judge|${ws}`);
    assert(row !== undefined, "the window row exists");
    assertEq(row!.hits, n, "every admitted request incremented the counter exactly once");
    assert(store.createAttempts >= 1, "at least one create was attempted");
  });

  // ── 5. Window reset restores capacity ────────────────────────────────────────

  await test("window reset: a new window restores the full allowance", async () => {
    resetStore();
    const rule = RATE_LIMITS.ai_copy;
    const now = Date.now();
    preconsume("u1", "ai-copy", rule.limit, now);

    // Same window → denied.
    const before = await consumeRateLimit("u1", "ai_copy", now);
    assertEq(before.allowed, false, "denied inside the exhausted window");

    // One whole window later → a fresh bucket, so allowed again.
    const after = await consumeRateLimit("u1", "ai_copy", now + rule.windowSeconds * 1000);
    assertEq(after.allowed, true, "allowed in the next window");
    assertEq(after.reason, "under_limit", "allowed because it is genuinely under the limit");
  });

  await test("window reset: Retry-After actually points at the window boundary", async () => {
    const rule = RATE_LIMITS.ai_copy;
    const w = rule.windowSeconds * 1000;
    const start = windowStartMs(Date.now(), rule.windowSeconds);
    // 1s into the window → almost a whole window left.
    assertEq(secondsUntilWindowEnd(start + 1000, rule.windowSeconds), rule.windowSeconds - 1, "early in window");
    // 1ms before the boundary → still >= 1s (never 0, which clients treat as "retry now").
    assertEq(secondsUntilWindowEnd(start + w - 1, rule.windowSeconds), 1, "at the boundary");
  });

  await test("window reset: old window rows are pruned (self-cleaning store)", async () => {
    resetStore();
    // A first request in a window triggers the opportunistic sweep for that
    // (user, route) — this is the documented cleanup strategy.
    await call("quality-judge", "prune-user");
    // The prune is fire-and-forget; let the microtask queue drain.
    await new Promise(r => setTimeout(r, 0));
    assert(store.pruneCalls.length >= 1, "a prune was issued when the window row was created");
    assert(
      store.pruneCalls.every(p => new Date(p.olderThan).getTime() < Date.now()),
      "prune horizon is in the past (never deletes a live window)",
    );
  });

  // ── 6. Limiter store failure → FAIL OPEN ─────────────────────────────────────
  // Deliberately the OPPOSITE of the moderation gate. A cost ceiling must not take
  // the product down when Supabase is unreachable.

  await test("fail-open: limiter store failure lets the request through", async () => {
    resetStore();
    store.failing = true;
    resetCalls();
    const { res, json } = await call("ai-copy", "u1");
    assertEq(res.status, 200, "request proceeds despite the limiter being down");
    assertEq(json.ok, true, "ok flag");
    assertEq(calls.generateCopyFromAnalysis, 1, "the provider was reached");
  });

  await test("fail-open: the decision is reported as limiter_unavailable, not under_limit", async () => {
    resetStore();
    store.failing = true;
    const d = await consumeRateLimit("u1", "ai_copy");
    assertEq(d.allowed, true, "allowed");
    assertEq(d.reason, "limiter_unavailable", "reason distinguishes an outage from a genuine pass");
  });

  await test("fail-open: a structured warning is logged", async () => {
    resetStore();
    store.failing = true;
    const seen: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); };
    try {
      await consumeRateLimit("u1", "quality_judge");
    } finally {
      console.warn = originalWarn;
    }
    assert(seen.length > 0, "something was logged");
    assert(seen.some(l => l.includes("ai_rate_limit_unavailable")), "structured event name present");
    assert(seen.some(l => l.includes("quality_judge")), "the affected route is identified");
  });

  await test("fail-open: every route stays available while the limiter is down", async () => {
    for (const name of ALL) {
      resetStore();
      store.failing = true;
      const { res } = await call(name, "u1");
      assertEq(res.status, 200, `${name} still serves`);
    }
  });

  // ── 7. Legitimate bursts are NOT throttled ───────────────────────────────────
  // These are the real measured burst sizes. If any of these goes red, the chosen
  // limit breaks a real user flow and the LIMIT is wrong, not the test.

  await test("legit burst: a 20-image upload (20 analyze calls) is not throttled", async () => {
    resetStore();
    // StudioBoard.handleFiles fires startImageAnalysis per uploaded file, unawaited,
    // so several overlap — model that with Promise.all rather than a serial loop.
    const results = await Promise.all(Array.from({ length: 20 }, () => call("analyze", "u1")));
    assertEq(results.filter(r => r.res.status === 429).length, 0, "no request was throttled");
    assertEq(results.filter(r => r.res.status === 200).length, 20, "all 20 succeeded");
  });

  await test("legit burst: FIVE consecutive 20-image uploads (100 analyze calls) still fit", async () => {
    resetStore();
    let throttled = 0;
    for (let batch = 0; batch < 5; batch++) {
      const results = await Promise.all(Array.from({ length: 20 }, () => call("analyze", "u1")));
      throttled += results.filter(r => r.res.status === 429).length;
    }
    assertEq(throttled, 0, "100 analyze calls in one window are all admitted");
  });

  await test("legit burst: a 50-Pin Batch Edit run (50 sequential ai-copy calls) is not throttled", async () => {
    resetStore();
    // BatchEditDrawer.handleGenerateCopyBatch loops one call per checked Pin,
    // sequentially, capped at 50.
    let throttled = 0;
    for (let i = 0; i < 50; i++) {
      const { res } = await call("ai-copy", "u1");
      if (res.status === 429) throttled++;
    }
    assertEq(throttled, 0, "no Pin in a full 50-Pin batch was throttled");
  });

  await test("legit burst: a user retrying a 50-Pin batch twice more (150 calls) still fits", async () => {
    resetStore();
    let throttled = 0;
    for (let i = 0; i < 150; i++) {
      const { res } = await call("ai-copy", "u1");
      if (res.status === 429) throttled++;
    }
    assertEq(throttled, 0, "three back-to-back 50-Pin batches fit inside one window");
  });

  await test("legit burst: 30 back-to-back 4-image generations (120 judge calls) fit", async () => {
    resetStore();
    let throttled = 0;
    for (let gen = 0; gen < 30; gen++) {
      // MAX_IMAGES_PER_REQUEST hard cap is 4; the judge runs once per generated image.
      const results = await Promise.all(Array.from({ length: 4 }, () => call("quality-judge", "u1")));
      throttled += results.filter(r => r.res.status === 429).length;
    }
    assertEq(throttled, 0, "the judge ceiling is above what the image pipeline can produce");
  });

  // ── 8. The configured limits themselves clear the documented floors ──────────

  await test("limits: every configured limit clears the documented legitimate-burst floor", async () => {
    const perMinute = (k: keyof typeof RATE_LIMITS) =>
      (RATE_LIMITS[k].limit / RATE_LIMITS[k].windowSeconds) * 60;
    // From the burst analysis: below ~40/min on analyze or ~60/min on ai-copy breaks
    // a legitimate flow, so those are hard floors, not preferences.
    assert(perMinute("ai_copy_analyze") >= 40, `analyze >= 40/min (got ${perMinute("ai_copy_analyze")})`);
    // ai-copy's floor is expressed as a burst, not a rate: a full 50-Pin batch plus
    // headroom must fit inside ONE window.
    assert(RATE_LIMITS.ai_copy.limit >= 150, `ai_copy window holds >= 3 full 50-Pin batches (got ${RATE_LIMITS.ai_copy.limit})`);
    assert(RATE_LIMITS.ai_copy_analyze.limit >= 200, `analyze window holds >= 10 twenty-image uploads (got ${RATE_LIMITS.ai_copy_analyze.limit})`);
    assert(RATE_LIMITS.quality_judge.limit >= 120, `judge window holds >= 30 four-image generations (got ${RATE_LIMITS.quality_judge.limit})`);
    // Every window is a real fixed window, not accidentally zero/negative.
    for (const k of Object.keys(RATE_LIMITS) as (keyof typeof RATE_LIMITS)[]) {
      assert(RATE_LIMITS[k].windowSeconds > 0, `${k} windowSeconds > 0`);
      assert(RATE_LIMITS[k].limit > 0, `${k} limit > 0`);
    }
  });

  // ── 9. The check sits before body parsing and any outbound call ──────────────

  await test("the limit check precedes body parsing (malformed body over the limit → 429)", async () => {
    resetStore();
    preconsume("u1", "ai-copy", RATE_LIMITS.ai_copy.limit);
    resetCalls();
    const h = await handler("ai-copy");
    const res = await h.POST(new Request(URLS["ai-copy"], {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer u1" },
      body: "{not json at all",
    }));
    assertEq(res.status, 429, "rate limit decided it, not a parse error");
    assertEq(providerCalls(), 0, "no provider spend");
  });

  await test("source check: each route calls consumeRateLimit before req.json()", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const spec of Object.values(ROUTES)) {
      const file = path.resolve(__dirname, `${spec}.ts`);
      const src = fs.readFileSync(file, "utf8");
      const limitAt = src.indexOf("consumeRateLimit(");
      const parseAt = src.indexOf("await req.json()");
      const authAt = src.indexOf("getUserIdFromBearerOrCookies(");
      assert(limitAt > 0, `${spec} calls consumeRateLimit`);
      assert(parseAt > 0, `${spec} parses a body`);
      assert(authAt > 0 && authAt < limitAt, `${spec}: auth runs BEFORE the rate limit`);
      assert(limitAt < parseAt, `${spec}: the rate limit runs BEFORE req.json()`);
      // And before anything that could spend money.
      for (const seam of ["providerConfig(", "fetchImageAsDataUrl("]) {
        const at = src.indexOf(seam);
        if (at > 0) assert(limitAt < at, `${spec}: the rate limit runs BEFORE ${seam}`);
      }
    }
  });

  // ── 10. Unauthenticated callers never even reach the limiter ─────────────────

  await test("anonymous requests are still rejected at auth, before the limiter", async () => {
    resetStore();
    resetCalls();
    for (const name of ALL) {
      const h = await handler(name);
      const res = await h.POST(new Request(URLS[name], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(happyBody(name)),
      }));
      assertEq(res.status, 401, `${name} anonymous → 401`);
    }
    assertEq(store.rows.size, 0, "no rate-limit row was created for an anonymous caller");
    assertEq(providerCalls(), 0, "no provider spend");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  __setRateLimitStoreForTests(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
