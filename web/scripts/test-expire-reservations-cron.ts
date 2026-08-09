/**
 * Route-level tests for GET /api/cron/expire-reservations (no database, no network).
 *
 * The sweep's correctness — locking, heartbeat proof-of-life, idempotent events — lives
 * in the SQL function and is covered by the real-Postgres suite. What can break HERE is
 * the trigger contract, and every case below is a way this endpoint could silently stop
 * releasing quota:
 *   - running unauthenticated, or refusing to run because the secret is unset;
 *   - calling the RPC with the wrong argument names, so the sweep never happens;
 *   - reporting success while the sweep actually failed — the exact failure this
 *     endpoint exists to prevent, and the one a crontab would never notice.
 *
 * Loads the REAL route module and fakes only the Supabase client.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import assert from "node:assert";
import Module from "node:module";

const SECRET = "test-cron-secret";
let passed = 0, failed = 0;

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = {
  data: { ok: true, expired_count: 0, skipped_count: 0, reservation_ids: [] },
  error: null,
};

function fakeClient() {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  };
}

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeClient, createClient: fakeClient };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

async function test(name: string, fn: () => Promise<void>) {
  rpcCalls.length = 0;
  rpcResult = { data: { ok: true, expired_count: 0, skipped_count: 0 }, error: null };
  process.env.CRON_SECRET = SECRET;
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); failed++; }
}

function req(authHeader?: string) {
  return { headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? authHeader ?? null : null) } } as never;
}

(async () => {
  console.log("=== /api/cron/expire-reservations (no database) ===\n");
  const mod = await import("../src/app/api/cron/expire-reservations/route");
  const GET = (mod as { GET: (r: unknown) => Promise<Response> }).GET;

  await test("no CRON_SECRET configured → 503 and NEVER touches the ledger", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req(`Bearer ${SECRET}`));
    assert.equal(res.status, 503);
    assert.equal(rpcCalls.length, 0, "must not sweep when unconfigured");
  });

  await test("wrong bearer → 401 and NEVER touches the ledger", async () => {
    const res = await GET(req("Bearer wrong-secret"));
    assert.equal(res.status, 401);
    assert.equal(rpcCalls.length, 0, "an unauthenticated caller cannot expire anyone's quota");
  });

  await test("missing Authorization header → 401", async () => {
    const res = await GET(req(undefined));
    assert.equal(res.status, 401);
    assert.equal(rpcCalls.length, 0);
  });

  await test("authorized run calls usage_expire_reservations with BOTH bounds", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    assert.equal(res.status, 200);
    assert.equal(rpcCalls.length, 1, "exactly one sweep per invocation");
    assert.equal(rpcCalls[0].fn, "usage_expire_reservations");
    // Argument NAMES are the contract with the SQL function: a rename here means the
    // sweep silently runs with defaults, or not at all.
    assert.ok(typeof rpcCalls[0].args.p_limit === "number", "p_limit passed");
    assert.ok(typeof rpcCalls[0].args.p_lease_seconds === "number", "p_lease_seconds passed");
    assert.ok((rpcCalls[0].args.p_lease_seconds as number) > 0, "lease must be a real window");
  });

  await test("a quiet sweep (nothing due) is a 200, not an error", async () => {
    rpcResult = { data: { ok: true, expired_count: 0, skipped_count: 0 }, error: null };
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = await res.json() as { expired: number; skipped: number };
    assert.equal(res.status, 200);
    assert.equal(body.expired, 0, "steady state is zero, and that is success");
  });

  await test("counts from the ledger are reported back verbatim", async () => {
    rpcResult = { data: { ok: true, expired_count: 3, skipped_count: 2 }, error: null };
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = await res.json() as { expired: number; skipped: number; available: boolean };
    assert.equal(body.expired, 3);
    assert.equal(body.skipped, 2, "skipped = alive workers spared, must stay visible");
    assert.equal(body.available, true);
  });

  await test("a REAL sweep failure is a 503 — never a green 200", async () => {
    rpcResult = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    const res = await GET(req(`Bearer ${SECRET}`));
    assert.equal(res.status, 503, "a failed sweep must be loud; a silent 200 leaks quota forever");
    const body = await res.json() as { code: string };
    assert.equal(body.code, "database_unavailable");
  });

  await test("function not deployed yet → 200 available:false, so cron does not alarm pre-migration", async () => {
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.usage_expire_reservations" } };
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = await res.json() as { expired: number; available: boolean };
    assert.equal(res.status, 200);
    assert.equal(body.available, false, "distinguishes 'not deployed' from 'swept nothing'");
    assert.equal(body.expired, 0);
  });

  await test("undefined_function (42883) is also treated as not-deployed", async () => {
    rpcResult = { data: null, error: { code: "42883", message: "function usage_expire_reservations does not exist" } };
    const res = await GET(req(`Bearer ${SECRET}`));
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { available: boolean }).available, false);
  });

  await test("repeat invocations each sweep exactly once (safe at any cron frequency)", async () => {
    await GET(req(`Bearer ${SECRET}`));
    await GET(req(`Bearer ${SECRET}`));
    assert.equal(rpcCalls.length, 2, "no batching, no skipping — one call per tick");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
