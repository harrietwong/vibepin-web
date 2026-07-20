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
  const route = await import("../src/app/api/generate/route");
  const res = await route.POST(makeReq(body) as never);
  const json = (await res.json()) as Record<string, unknown>;
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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
