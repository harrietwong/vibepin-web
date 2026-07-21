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
function fakeServerClient() {
  return {
    from(table: string) {
      return {
        insert(_row: unknown) {
          if (table === "generation_jobs") enqueueInsertCount++;
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
function fakeSpawn() {
  spawnCount++;
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: () => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdin = { write: () => {}, end: () => {} };
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
  return originalLoad.call(this, request, parent, isMain);
};
void originalResolve;

function makeReq(body: Record<string, unknown>): Request {
  return new Request("https://vibepin.co/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepin-test-user-id": `u_${Math.random().toString(36).slice(2)}` },
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
  // GENERATION_MODE is captured at module top-level, so re-import a fresh copy.
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
  const route = await import(`../src/app/api/generate/route?map=${mode}_${Math.random()}`);
  const res = await route.POST(makeReq(body) as never);
  const json = (await res.json()) as Record<string, unknown>;
  process.env.GENERATION_MODE = "inline";
  delete process.env.MODERATION_MOCK_MAP;
  return { status: res.status, json };
}

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
