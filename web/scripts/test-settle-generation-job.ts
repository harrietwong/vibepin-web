/**
 * Worker-path image settlement — the half of the metering loop that never existed.
 *
 * /api/generate reserved capacity and enqueued the job; the VPS worker (a separate
 * codebase) rendered the images and never settled. So `ai_images_used` stayed 0 no
 * matter how many images were generated. settleGenerationJob closes that from the
 * poll route.
 *
 * What this pins:
 *   - one settle per TERMINAL slot, with the outcome the worker reported
 *   - slot N maps to slot_key "sN" (a mismatch throws "unknown slot" on every settle)
 *   - only done/failed JOBS settle; a running job banks nothing
 *   - a slot still pending on a terminal job is left to the sweeper, never guessed
 *   - no reservation_id → the RPC is never called (unmetered jobs cost nothing)
 *   - replays don't inflate counts (the client polls the same finished job forever)
 *   - it FAILS OPEN: RPC errors, refusals and throws all return counts, never raise
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.USAGE_METERING_MODE = "shadow";

import assert from "node:assert";
import { readFileSync } from "node:fs";

type SettleModule = typeof import("../src/lib/server/usage/settleGenerationJob");
let M: SettleModule;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${(err as Error)?.message ?? err}`); failed++; }
}

type Call = { fn: string; args: Record<string, unknown> };

/**
 * A fake honouring the real RpcRunner contract: it resolves to {data,error}, it does
 * NOT throw on a refusal. (Reading that envelope wrongly is exactly how a sibling
 * metering call once recorded nothing in production while looking healthy.)
 */
function fakeRpc(reply: (args: Record<string, unknown>) => unknown, calls: Call[]) {
  return (async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data: reply(args), error: null };
  }) as never;
}

const done = (slot: number) => ({ slot, status: "done" as const, imageUrl: `https://img/${slot}.png`, error: null });
const failedSlot = (slot: number) => ({ slot, status: "failed" as const, imageUrl: null, error: "render failed" });

(async () => {
  M = await import("../src/lib/server/usage/settleGenerationJob");
  const settle = M.settleGenerationJob;

  console.log("=== worker-path image settlement ===\n");

  await test("two done slots settle as succeeded, one call each", async () => {
    const calls: Call[] = [];
    const out = await settle({
      reservationId: "res-1", status: "done", results: [done(0), done(1)],
      deps: { rpc: fakeRpc(() => ({ ok: true, replayed: false }), calls) },
    });
    assert.equal(out.settledSuccess, 2);
    assert.equal(out.settledFailed, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.fn === "usage_settle_reservation_item"));
    assert.equal(calls[0].args.p_outcome, "succeeded");
  });

  await test("slot N maps to slot_key sN", async () => {
    const calls: Call[] = [];
    await settle({
      reservationId: "res-1", status: "done", results: [done(0), done(1), done(2)],
      deps: { rpc: fakeRpc(() => ({ ok: true }), calls) },
    });
    assert.deepEqual(calls.map((c) => c.args.p_slot_key), ["s0", "s1", "s2"]);
  });

  await test("a failed slot settles as terminal_failed, not succeeded", async () => {
    const calls: Call[] = [];
    const out = await settle({
      reservationId: "res-1", status: "done", results: [done(0), failedSlot(1)],
      deps: { rpc: fakeRpc(() => ({ ok: true }), calls) },
    });
    assert.equal(out.settledSuccess, 1);
    assert.equal(out.settledFailed, 1);
    assert.equal(calls[1].args.p_outcome, "terminal_failed");
  });

  await test("a RUNNING job settles nothing", async () => {
    const calls: Call[] = [];
    const out = await settle({
      reservationId: "res-1", status: "running", results: [done(0)],
      deps: { rpc: fakeRpc(() => ({ ok: true }), calls) },
    });
    assert.equal(calls.length, 0, "must not bank a slot while the job is still running");
    assert.equal(out.settledSuccess, 0);
  });

  await test("a slot still PENDING on a terminal job is left to the sweeper", async () => {
    // Neither outcome is honest: 'succeeded' bills an image that does not exist,
    // 'terminal_failed' asserts a failure we never observed.
    const calls: Call[] = [];
    await settle({
      reservationId: "res-1", status: "done",
      results: [done(0), { slot: 1, status: "pending", imageUrl: null, error: null }],
      deps: { rpc: fakeRpc(() => ({ ok: true }), calls) },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.p_slot_key, "s0");
  });

  await test("no reservation_id → the ledger is never called", async () => {
    const calls: Call[] = [];
    const out = await settle({
      reservationId: null, status: "done", results: [done(0)],
      deps: { rpc: fakeRpc(() => ({ ok: true }), calls) },
    });
    assert.equal(calls.length, 0);
    assert.equal(out.settledSuccess, 0);
  });

  await test("a replay does not inflate the count", async () => {
    // The client polls the same finished job every 4s; each poll re-settles.
    const calls: Call[] = [];
    const out = await settle({
      reservationId: "res-1", status: "done", results: [done(0), done(1)],
      deps: { rpc: fakeRpc(() => ({ ok: true, replayed: true }), calls) },
    });
    assert.equal(calls.length, 2, "the RPC is still called — it owns idempotency");
    assert.equal(out.settledSuccess, 0, "but a replay banks nothing new");
  });

  await test("an expired reservation is counted as refused, not as success", async () => {
    const out = await settle({
      reservationId: "res-1", status: "done", results: [done(0)],
      deps: { rpc: fakeRpc(() => ({ ok: false, reason: "reservation_expired" }), []) },
    });
    assert.equal(out.settledSuccess, 0, "the sweeper won — nothing was banked");
    assert.equal(out.refused, 1, "and the miss is counted so it can be measured");
  });

  await test("an RPC error FAILS OPEN — the poll still returns", async () => {
    const rpc = (async () => ({ data: null, error: { code: "P0002", message: "unknown slot" } })) as never;
    const out = await settle({ reservationId: "res-1", status: "done", results: [done(0)], deps: { rpc } });
    assert.equal(out.refused, 1);
    assert.equal(out.settledSuccess, 0);
  });

  await test("a THROWN rpc FAILS OPEN — metering never breaks a poll", async () => {
    const rpc = (async () => { throw new Error("network down"); }) as never;
    const out = await settle({ reservationId: "res-1", status: "done", results: [done(0)], deps: { rpc } });
    assert.equal(out.refused, 1, "must be swallowed: the user is owed their images");
  });

  await test("malformed results never throw", async () => {
    for (const results of [null, undefined, "nope", [null], [{ noSlot: true }]]) {
      const out = await settle({
        reservationId: "res-1", status: "done", results,
        deps: { rpc: fakeRpc(() => ({ ok: true }), []) },
      });
      assert.equal(out.settledSuccess, 0);
    }
  });

  await test("the poll route settles BEFORE reading the counters it returns", () => {
    // Otherwise the freshly-banked image shows up only on the NEXT poll, which is
    // exactly the "see the count as soon as the image lands" requirement.
    const src = readFileSync("src/app/api/generation-jobs/[id]/route.ts", "utf8");
    const atSettle = src.indexOf("await settleGenerationJob(");
    const atRead = src.indexOf('.from("usage_reservations")');
    assert.ok(atSettle > 0, "route does not settle");
    assert.ok(atRead > 0, "route does not read the reservation");
    assert.ok(atSettle < atRead, "settle must run before the counter read");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
