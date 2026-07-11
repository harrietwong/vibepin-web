/**
 * shopifyClient.ts unit tests (WP4, §9 of the Phase 1 implementation plan).
 * Run: npx tsx scripts/test-shopify-client.ts
 *
 * Runs against the real module with a stubbed global fetch — no server, no
 * Supabase network calls (freshAccessToken() resolves to a null session against
 * the dummy env below, so requests simply carry no Authorization header, which
 * the mock doesn't care about).
 *
 * Covers: status 60s cache (concurrent coalescing + TTL expiry + explicit
 * invalidate + fresh:true bypass), runSyncToCompletion multi-chunk loop to
 * completed / limit_reached / error, the 409 sync_in_progress poll-then-resume
 * path (and giving up as sync_in_progress after maxConflictPolls), and the
 * onProgress callback sequence.
 */

// Dummy env so importing the Supabase browser client chain never throws.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

export {};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── Mock fetch ────────────────────────────────────────────────────────────────

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Queued scripted responses for POST /sync, consumed FIFO (one per call). */
type SyncScriptEntry = { status: number; body?: Record<string, unknown> };
let syncScript: SyncScriptEntry[] = [];

/** Mutable status payload returned by GET /status. Tests mutate this directly. */
function defaultConnection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "conn_1",
    shopDomain: "demo-store.myshopify.com",
    shopName: "Demo Store",
    primaryDomain: null,
    status: "connected",
    scopes: ["read_products"],
    lastFullSyncAt: null,
    uninstalledAt: null,
    disconnectedAt: null,
    updatedAt: new Date().toISOString(),
    sync: {
      status: "idle",
      syncedCount: 0,
      totalCount: null,
      cursor: null,
      error: null,
      startedAt: null,
      resumable: false,
      ...overrides,
    },
  };
}
let statusState: { configured: boolean; connections: unknown[]; plan: Record<string, unknown> } = {
  configured: true,
  connections: [defaultConnection()],
  plan: { key: "starter", maxStores: 1, maxSyncedProducts: 100 },
};

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> | null = null;
  if (init?.body) {
    try { body = JSON.parse(String(init.body)); } catch { body = null; }
  }
  calls.push({ url, method, body });

  if (url.endsWith("/api/integrations/shopify/status")) {
    return jsonResponse(200, statusState);
  }
  if (url.endsWith("/api/integrations/shopify/sync")) {
    const next = syncScript.shift();
    if (!next) return jsonResponse(500, { error: "sync script exhausted", code: "server_error" });
    return jsonResponse(next.status, next.body ?? {});
  }
  if (url.endsWith("/api/integrations/shopify/connect")) {
    return jsonResponse(200, { url: "https://demo-store.myshopify.com/admin/oauth/authorize?state=abc" });
  }
  if (url.endsWith("/api/integrations/shopify/disconnect")) {
    return jsonResponse(200, { ok: true });
  }
  return jsonResponse(404, { error: "unhandled mock route", code: "not_found" });
};

function countCalls(match: string, method?: string): number {
  return calls.filter(c => c.url.includes(match) && (!method || c.method === method)).length;
}

async function main() {
  const client = await import("../src/lib/shopifyClient");

  console.log("\nshopifyClient tests\n");

  // ── status: caching + invalidation ───────────────────────────────────────

  await test("3 concurrent status consumers share exactly 1 network GET", async () => {
    client.invalidateShopifyStatusCache();
    calls.length = 0;
    const [a, b, c] = await Promise.all([
      client.getShopifyStatus(),
      client.getShopifyStatus(),
      client.getShopifyStatus(),
    ]);
    assertEq(countCalls("/status"), 1, "expected exactly 1 status GET");
    assert(a.connections[0].shopDomain === "demo-store.myshopify.com", "all consumers must see the shared result");
    assert(b === a && c === a, "concurrent callers must resolve to the same cached object");
  });

  await test("a follow-up call within the TTL serves from cache (0 additional GETs)", async () => {
    calls.length = 0;
    await client.getShopifyStatus();
    assertEq(countCalls("/status"), 0, "must serve from cache within TTL");
  });

  await test("fresh:true bypasses the cache", async () => {
    calls.length = 0;
    await client.getShopifyStatus({ fresh: true });
    assertEq(countCalls("/status"), 1, "fresh:true must always hit the network");
  });

  await test("cache expires after the 60s TTL", async () => {
    const realNow = Date.now;
    let fakeNow = realNow();
    (Date as unknown as { now: () => number }).now = () => fakeNow;
    try {
      calls.length = 0;
      await client.getShopifyStatus(); // repopulate cache at fakeNow
      assertEq(countCalls("/status"), 0, "sanity: should be cached immediately after populate");
      fakeNow += 61_000;
      await client.getShopifyStatus();
      assertEq(countCalls("/status"), 1, "must refetch once the TTL has elapsed");
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
  });

  await test("invalidateShopifyStatusCache forces the next call to refetch", async () => {
    await client.getShopifyStatus(); // ensure cached
    calls.length = 0;
    client.invalidateShopifyStatusCache();
    await client.getShopifyStatus();
    assertEq(countCalls("/status"), 1, "invalidate must force a fresh network read");
  });

  // ── runSyncToCompletion: multi-chunk loop to a terminal state ────────────

  await test("runSyncToCompletion loops chunks to completed, forwarding progress in order", async () => {
    client.invalidateShopifyStatusCache();
    calls.length = 0;
    syncScript = [
      { status: 200, body: { state: "running", hasMore: true, syncedCount: 50 } },
      { status: 200, body: { state: "running", hasMore: true, syncedCount: 90 } },
      { status: 200, body: { state: "completed", hasMore: false, syncedCount: 120 } },
    ];
    const progress: Array<{ syncedCount: number; state: string }> = [];
    const result = await client.runSyncToCompletion("conn_1", {
      onProgress: p => progress.push({ syncedCount: p.syncedCount, state: p.state }),
    });
    assertEq(result.state, "completed", "terminal state must be completed");
    assertEq((result as { syncedCount: number }).syncedCount, 120, "final syncedCount must be the last chunk's value");
    assertEq(countCalls("/sync", "POST"), 3, "expected exactly 3 chunk POSTs");
    assertEq(progress.length, 3, "onProgress must fire once per chunk");
    assertEq(progress[0].syncedCount, 50, "progress[0] must reflect chunk 1");
    assertEq(progress[1].syncedCount, 90, "progress[1] must reflect chunk 2");
    assertEq(progress[2].syncedCount, 120, "progress[2] must reflect chunk 3");
    assertEq(progress[2].state, "completed", "final progress event must carry the terminal state");
  });

  await test("only the first chunk may carry fresh:true; subsequent chunks always fresh:false", async () => {
    calls.length = 0;
    syncScript = [
      { status: 200, body: { state: "running", hasMore: true, syncedCount: 10 } },
      { status: 200, body: { state: "completed", hasMore: false, syncedCount: 20 } },
    ];
    await client.runSyncToCompletion("conn_1", { fresh: true });
    const syncCalls = calls.filter(c => c.url.includes("/sync") && c.method === "POST");
    assertEq(syncCalls.length, 2, "expected 2 chunk POSTs");
    assertEq(syncCalls[0].body?.fresh, true, "first chunk must carry the caller's fresh flag");
    assertEq(syncCalls[1].body?.fresh, false, "second chunk must never re-force fresh");
  });

  await test("runSyncToCompletion resolves limit_reached with totalCount", async () => {
    calls.length = 0;
    syncScript = [
      { status: 200, body: { state: "limit_reached", hasMore: false, syncedCount: 100, totalCount: 342 } },
    ];
    const result = await client.runSyncToCompletion("conn_1");
    assertEq(result.state, "limit_reached", "terminal state must be limit_reached");
    assertEq((result as { totalCount?: number }).totalCount, 342, "totalCount must be forwarded");
  });

  await test("runSyncToCompletion resolves error with the server's message", async () => {
    calls.length = 0;
    syncScript = [
      { status: 200, body: { state: "error", hasMore: false, syncedCount: 7, error: "reauth_required" } },
    ];
    const result = await client.runSyncToCompletion("conn_1");
    assertEq(result.state, "error", "terminal state must be error");
    assertEq((result as { error: string }).error, "reauth_required", "error message must be forwarded");
  });

  await test("a non-2xx, non-409 response throws to the caller", async () => {
    calls.length = 0;
    syncScript = [{ status: 503, body: { error: "Shopify store storage is unavailable", code: "database_unavailable" } }];
    let threw: unknown = null;
    try {
      await client.runSyncToCompletion("conn_1");
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof Error, "must throw on a hard failure");
    assertEq((threw as { code?: string }).code, "database_unavailable", "thrown error must carry the server's code");
  });

  // ── 409 sync_in_progress: poll-then-resume ───────────────────────────────

  await test("409 sync_in_progress polls /status until the lock releases, then resumes", async () => {
    client.invalidateShopifyStatusCache();
    calls.length = 0;
    // Chunk 1 is taken by "another tab" (409). While polling, /status still
    // reports running; on the second poll the lock has released (completed),
    // so the loop resumes with one more chunk POST that finishes the run.
    let statusPolls = 0;
    const originalConnections = statusState.connections;
    statusState = {
      ...statusState,
      get connections() {
        statusPolls++;
        return statusPolls < 2
          ? [defaultConnection({ status: "running", syncedCount: 40 })]
          : [defaultConnection({ status: "completed", syncedCount: 40 })];
      },
    } as unknown as typeof statusState;
    syncScript = [
      { status: 409, body: { error: "Sync already in progress", code: "sync_in_progress" } },
      { status: 200, body: { state: "completed", hasMore: false, syncedCount: 80 } },
    ];
    const progress: Array<{ syncedCount: number; state: string }> = [];
    const result = await client.runSyncToCompletion("conn_1", {
      pollIntervalMs: 1,
      onProgress: p => progress.push({ syncedCount: p.syncedCount, state: p.state }),
    });
    assertEq(result.state, "completed", "must resume and finish once the lock releases");
    assertEq((result as { syncedCount: number }).syncedCount, 80, "must reflect the resumed chunk's count");
    assert(statusPolls >= 2, "must poll /status at least twice before resuming");
    statusState = { ...statusState, connections: originalConnections } as typeof statusState;
  });

  await test("409 that never releases gives up as sync_in_progress after maxConflictPolls", async () => {
    client.invalidateShopifyStatusCache();
    calls.length = 0;
    statusState = {
      configured: true,
      connections: [defaultConnection({ status: "running", syncedCount: 5 })],
      plan: { key: "starter", maxStores: 1, maxSyncedProducts: 100 },
    };
    syncScript = [
      { status: 409, body: {} },
      { status: 409, body: {} },
      { status: 409, body: {} },
    ];
    const result = await client.runSyncToCompletion("conn_1", { pollIntervalMs: 1, maxConflictPolls: 1 });
    assertEq(result.state, "sync_in_progress", "must give up as sync_in_progress, not hang or throw");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
