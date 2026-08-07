/**
 * Route-level integration check for the settle wiring.
 *
 * The unit suite drives settleGenerationJob directly with a fake RpcRunner. This
 * exercises the REAL route module end to end — auth, ownership, the settle call, the
 * counter read, the response shape — with only the Supabase client and the RPC faked.
 * It is the layer between "my function calls the contract correctly" and "production
 * actually records", which was untested.
 *
 * Touches no database: every client is a fake constructed here.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";

import assert from "node:assert";
import Module from "node:module";

const OWNER = "user-owner";
let passed = 0, failed = 0;

type RpcCall = { fn: string; args: Record<string, unknown> };
const rpcCalls: RpcCall[] = [];

// Mutable fixture the fake db serves.
let jobRow: Record<string, unknown> | null = null;
let reservationRow: Record<string, unknown> | null = null;
let rpcBehaviour: (args: Record<string, unknown>) => unknown = () => ({ ok: true, replayed: false });

function fakeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === "generation_jobs") return { data: jobRow, error: null };
          if (table === "usage_reservations") return { data: reservationRow, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      // Settling moves the counters, exactly as the real RPC would.
      if (fn === "usage_settle_reservation_item" && reservationRow) {
        const r = reservationRow as Record<string, number>;
        const res = rpcBehaviour(args) as { ok?: boolean; replayed?: boolean };
        // Mirror the REAL rpc: its UPDATE is guarded on state='pending', so a replay
        // moves no counter. A fake that bumps on replay would report a fake bug.
        if (res?.ok !== false && res?.replayed !== true) {
          if (args.p_outcome === "succeeded") r.consumed_quantity = (r.consumed_quantity ?? 0) + 1;
          else r.released_quantity = (r.released_quantity ?? 0) + 1;
        }
        return { data: res, error: null };
      }
      return { data: rpcBehaviour(args), error: null };
    },
  };
}

// Intercept the modules the route imports, before it is loaded.
const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (
  this: unknown, request: string, parent: unknown, isMain: boolean
) {
  if (request.endsWith("/lib/supabase") || request.endsWith("@/lib/supabase")) {
    return { createServerClient: fakeClient, createClient: fakeClient };
  }
  if (request.endsWith("/lib/server/authUser") || request.endsWith("@/lib/server/authUser")) {
    return {
      getUserIdFromBearer: async () => OWNER,
      getUserIdFromCookies: async () => null,
    };
  }
  return origLoad.call(this, request, parent, isMain);
} as never;

async function test(name: string, fn: () => Promise<void>) {
  rpcCalls.length = 0;
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); failed++; }
}

function req() {
  return { headers: { get: () => "Bearer t" } } as never;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

(async () => {
  console.log("=== route-level settle integration (no database) ===\n");
  const mod = await import("../src/app/api/generation-jobs/[id]/route");
  const GET = (mod as { GET: (r: unknown, c: unknown) => Promise<Response> }).GET;

  await test("a DONE 2-slot job settles both slots and reports the count in the SAME response", async () => {
    jobRow = {
      id: "job-1", status: "done", vibepin_user_id: OWNER, usage_reservation_id: "res-1",
      results: [
        { slot: 0, status: "done", imageUrl: "https://i/0.png", error: null },
        { slot: 1, status: "done", imageUrl: "https://i/1.png", error: null },
      ],
    };
    reservationRow = { requested_quantity: 2, consumed_quantity: 0, released_quantity: 0 };
    rpcBehaviour = () => ({ ok: true, replayed: false });

    const res = await GET(req(), ctx("job-1"));
    const body = await res.json() as { usage?: { settledSuccess: number; reserved: number } };

    const settles = rpcCalls.filter((c) => c.fn === "usage_settle_reservation_item");
    assert.equal(settles.length, 2, "both slots settled");
    assert.deepEqual(settles.map((c) => c.args.p_slot_key), ["s0", "s1"]);
    assert.ok(body.usage, "response carries a usage block");
    assert.equal(body.usage!.settledSuccess, 2, "THE ACCEPTANCE CRITERION: count visible immediately");
    assert.equal(body.usage!.reserved, 2);
  });

  await test("a RUNNING job settles nothing and still returns results", async () => {
    jobRow = {
      id: "job-2", status: "running", vibepin_user_id: OWNER, usage_reservation_id: "res-1",
      results: [{ slot: 0, status: "pending", imageUrl: null, error: null }],
    };
    reservationRow = { requested_quantity: 2, consumed_quantity: 0, released_quantity: 0 };
    const res = await GET(req(), ctx("job-2"));
    const body = await res.json() as { status: string };
    assert.equal(rpcCalls.filter((c) => c.fn === "usage_settle_reservation_item").length, 0);
    assert.equal(body.status, "running");
  });

  await test("a mixed done/failed job books one used and one returned", async () => {
    jobRow = {
      id: "job-3", status: "done", vibepin_user_id: OWNER, usage_reservation_id: "res-1",
      results: [
        { slot: 0, status: "done", imageUrl: "https://i/0.png", error: null },
        { slot: 1, status: "failed", imageUrl: null, error: "render failed" },
      ],
    };
    reservationRow = { requested_quantity: 2, consumed_quantity: 0, released_quantity: 0 };
    const res = await GET(req(), ctx("job-3"));
    const body = await res.json() as { usage: { settledSuccess: number; settledFailed: number } };
    assert.equal(body.usage.settledSuccess, 1);
    assert.equal(body.usage.settledFailed, 1);
  });

  await test("an unmetered job (no reservation) never calls the ledger", async () => {
    jobRow = {
      id: "job-4", status: "done", vibepin_user_id: OWNER, usage_reservation_id: null,
      results: [{ slot: 0, status: "done", imageUrl: "https://i/0.png", error: null }],
    };
    reservationRow = null;
    const res = await GET(req(), ctx("job-4"));
    const body = await res.json() as { usage?: unknown; results: unknown[] };
    assert.equal(rpcCalls.length, 0);
    assert.equal(body.usage, undefined, "no usage block when unmetered");
    assert.equal(body.results.length, 1, "images still returned");
  });

  await test("a ledger REFUSAL never breaks the poll — images still come back", async () => {
    jobRow = {
      id: "job-5", status: "done", vibepin_user_id: OWNER, usage_reservation_id: "res-1",
      results: [{ slot: 0, status: "done", imageUrl: "https://i/0.png", error: null }],
    };
    reservationRow = { requested_quantity: 1, consumed_quantity: 0, released_quantity: 0 };
    rpcBehaviour = () => ({ ok: false, reason: "reservation_expired" });
    const res = await GET(req(), ctx("job-5"));
    const body = await res.json() as { results: unknown[]; usage: { settledSuccess: number } };
    assert.equal(res.status, 200, "poll still succeeds");
    assert.equal(body.results.length, 1, "user still gets their image");
    assert.equal(body.usage.settledSuccess, 0, "and nothing was falsely banked");
  });

  await test("another user's job 404s and never settles", async () => {
    jobRow = {
      id: "job-6", status: "done", vibepin_user_id: "someone-else", usage_reservation_id: "res-1",
      results: [{ slot: 0, status: "done", imageUrl: "https://i/0.png", error: null }],
    };
    rpcBehaviour = () => ({ ok: true });
    const res = await GET(req(), ctx("job-6"));
    assert.equal(res.status, 404);
    assert.equal(rpcCalls.length, 0, "must not touch another user's ledger");
  });

  await test("repeated polls of the same finished job do not inflate the count", async () => {
    jobRow = {
      id: "job-7", status: "done", vibepin_user_id: OWNER, usage_reservation_id: "res-1",
      results: [{ slot: 0, status: "done", imageUrl: "https://i/0.png", error: null }],
    };
    reservationRow = { requested_quantity: 1, consumed_quantity: 0, released_quantity: 0 };
    let first = true;
    rpcBehaviour = () => { const r = first ? { ok: true, replayed: false } : { ok: true, replayed: true }; first = false; return r; };
    await GET(req(), ctx("job-7"));
    const res2 = await GET(req(), ctx("job-7"));
    const body = await res2.json() as { usage: { settledSuccess: number } };
    assert.equal(body.usage.settledSuccess, 1, "still 1 after a second poll, not 2");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
