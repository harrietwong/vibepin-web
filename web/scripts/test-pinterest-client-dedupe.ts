/**
 * Behavioral tests for pinterestClient's request coalescing — the pieces that fix
 * the post-OAuth "Not connected" / slow-boards chain:
 *
 *   1. fetchPinterestStatusCached: N concurrent callers → exactly 1 network GET.
 *   2. seedPinterestStatusConnected: consumers see "connected" IMMEDIATELY
 *      (no await on the network) while exactly one background revalidation runs.
 *   3. fetchPinterestBoards single-flight: concurrent signal-less first-page
 *      calls share one GET; bookmarked / signal-carrying calls never coalesce.
 *
 * Runs against the real module with a stubbed global fetch — no server needed.
 */

// Dummy env so importing the supabase browser client chain never throws.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

type FetchCall = { url: string };
const calls: FetchCall[] = [];
let respondDelayMs = 30;
let statusBody: Record<string, unknown> = {
  connected: true, account: { id: "1", username: "real_user", accountType: "BUSINESS" },
  scopes: [], needsReconnect: false, connectionSource: "db",
};

//

(globalThis as Record<string, unknown>).fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  calls.push({ url });
  await new Promise(r => setTimeout(r, respondDelayMs));
  const body = url.includes("/boards")
    ? { items: [{ id: "b1", name: "Home Decor" }], bookmark: null }
    : statusBody;
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

function countCalls(match: string): number {
  return calls.filter(c => c.url.includes(match)).length;
}

async function main() {
  const client = await import("../src/lib/pinterestClient");

  console.log("pinterestClient request coalescing");

  await test("3 concurrent status consumers share exactly 1 network GET", async () => {
    calls.length = 0;
    const [a, b, c] = await Promise.all([
      client.fetchPinterestStatusCached(),
      client.fetchPinterestStatusCached(),
      client.fetchPinterestStatusCached(),
    ]);
    assert(countCalls("/api/pinterest/status") === 1, `expected 1 status GET, got ${countCalls("/api/pinterest/status")}`);
    assert(a.connected && b.connected && c.connected, "all consumers must receive the shared result");
  });

  await test("fresh cache serves follow-up consumers with 0 additional GETs", async () => {
    calls.length = 0;
    const s = await client.fetchPinterestStatusCached();
    assert(s.connected, "cached result lost");
    assert(countCalls("/api/pinterest/status") === 0, "must serve from cache within TTL");
  });

  await test("seedPinterestStatusConnected: connected is visible immediately, 1 background revalidation", async () => {
    client.invalidatePinterestStatusCache();
    calls.length = 0;
    respondDelayMs = 120; // slow network — the seed must not wait for it
    client.seedPinterestStatusConnected();
    const t0 = Date.now();
    const s = await client.fetchPinterestStatusCached();
    const elapsed = Date.now() - t0;
    assert(s.connected && s.connectionSource === "db", "seed must read as a real connection");
    assert(elapsed < 60, `seed consumer must not wait on the network (took ${elapsed}ms)`);
    await new Promise(r => setTimeout(r, 250)); // let revalidation land
    assert(countCalls("/api/pinterest/status") === 1, `expected exactly 1 revalidation GET, got ${countCalls("/api/pinterest/status")}`);
    respondDelayMs = 30;
  });

  await test("revalidation replaces the seed with the real account", async () => {
    const s = await client.fetchPinterestStatusCached();
    assert(s.account?.username === "real_user", "real status must replace the optimistic seed");
  });

  await test("concurrent signal-less first-page boards calls share 1 GET (warm-up + drawer)", async () => {
    calls.length = 0;
    const [a, b] = await Promise.all([client.fetchPinterestBoards(), client.fetchPinterestBoards()]);
    assert(countCalls("/api/pinterest/boards") === 1, `expected 1 boards GET, got ${countCalls("/api/pinterest/boards")}`);
    assert(a.items.length === 1 && b.items.length === 1, "both callers must receive the shared boards page");
  });

  await test("bookmarked pages and signal-carrying calls never coalesce", async () => {
    calls.length = 0;
    const controller = new AbortController();
    await Promise.all([
      client.fetchPinterestBoards("page2"),
      client.fetchPinterestBoards(undefined, controller.signal),
    ]);
    assert(countCalls("/api/pinterest/boards") === 2, `expected 2 independent GETs, got ${countCalls("/api/pinterest/boards")}`);
  });

  await test("a failed status fetch is not cached — next consumer retries", async () => {
    client.invalidatePinterestStatusCache();
    calls.length = 0;
    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = async () => { throw new TypeError("Failed to fetch"); };
    let threw = false;
    try { await client.fetchPinterestStatusCached(); } catch { threw = true; }
    assert(threw, "failure must propagate to the caller");
    (globalThis as Record<string, unknown>).fetch = realFetch;
    const s = await client.fetchPinterestStatusCached();
    assert(s.connected, "recovery fetch after a failure must succeed");
  });

  console.log(`\npinterestClient dedupe: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
