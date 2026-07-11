/**
 * Shopify syncEngine.ts state-machine tests (WP3).
 * Run: npx tsx scripts/test-shopify-sync-engine.ts
 *
 * Mocks Supabase (in-memory PostgREST subset injected into connectionStore AND
 * productStore) and the Admin GraphQL transport (global fetch → scripted page
 * responses). Plan resolution and timing are injected via the engine's test
 * hooks so the full state machine runs deterministically and fast.
 *
 * Covers: idle→running→completed (+ tombstone sweep), multi-page within budget,
 * fresh run vs expired-lock takeover/resume, 409 when a live lock is held, a
 * superseded run abandoned by updateSyncProgress, the entitlement boundary
 * (99+50 → 100 with a correct totalCount, no tombstone), THROTTLED backoff (retry
 * success + persistent → hasMore), AuthError → reauth_required, and the page-cap
 * pause → hasMore with the lock released.
 */

import { randomUUID } from "node:crypto";

import { randomBytes } from "node:crypto";

process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.SHOPIFY_API_VERSION = "2026-07";

export {};

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
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
async function expectReject(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (e) {
    assertEq((e as { code?: string }).code, code, `expected rejection code ${code}`);
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

// ── In-memory mock Supabase (subset used by connectionStore + productStore) ────

type Row = Record<string, unknown>;
type DbResult = { data: unknown; error: { code: string; message: string } | null; count?: number | null };

const CONN_DEFAULT = (): Row => ({
  id: randomUUID(),
  provider: "shopify",
  shop_name: null,
  primary_domain: null,
  access_token_encrypted: null,
  scopes: [],
  status: "connected",
  sync_status: "idle",
  sync_cursor: null,
  sync_run_id: null,
  sync_lock_expires_at: null,
  sync_started_at: null,
  sync_error: null,
  synced_count: 0,
  total_count: null,
  last_full_sync_at: null,
  last_incremental_sync_at: null,
  uninstalled_at: null,
  disconnected_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const TABLE_DEFAULTS: Record<string, () => Row> = {
  store_connections: CONN_DEFAULT,
};

type OrCondition = { field: string; op: string; value: string };

class MockDb {
  tables = new Map<string, Row[]>();
  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
  from(table: string): MockQuery {
    return new MockQuery(this, table);
  }
}

class MockQuery implements PromiseLike<DbResult> {
  private op: "select" | "update" | "upsert" | "delete" = "select";
  private patch: Row | null = null;
  private upsertRows: Row[] | null = null;
  private onConflict: string[] = [];
  private predicates: Array<(row: Row) => boolean> = [];
  private orGroups: OrCondition[][] = [];
  private returning: string | null = null;
  private orderBy: Array<{ col: string; ascending: boolean }> = [];
  private limitN: number | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(private dbRef: MockDb, private table: string) {}

  select(cols = "*"): this { this.returning = cols; return this; }
  update(patch: Row): this { this.op = "update"; this.patch = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    this.onConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    return this;
  }
  delete(): this { this.op = "delete"; return this; }
  eq(field: string, value: unknown): this { this.predicates.push((r) => r[field] != null && r[field] === value); return this; }
  is(field: string, value: null): this { this.predicates.push((r) => r[field] == null && value === null); return this; }
  lt(field: string, value: unknown): this { this.predicates.push((r) => r[field] != null && String(r[field]) < String(value)); return this; }
  gt(field: string, value: unknown): this { this.predicates.push((r) => r[field] != null && String(r[field]) > String(value)); return this; }
  in(field: string, values: unknown[]): this { this.predicates.push((r) => values.includes(r[field])); return this; }
  or(expr: string): this {
    const conds: OrCondition[] = expr.split(",").map((part) => {
      const first = part.indexOf(".");
      const second = part.indexOf(".", first + 1);
      let value = part.slice(second + 1);
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      return { field: part.slice(0, first), op: part.slice(first + 1, second), value };
    });
    this.orGroups.push(conds);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderBy.push({ col, ascending: opts?.ascending !== false }); return this; }
  limit(n: number): this { this.limitN = n; return this; }
  single(): this { this.mode = "single"; return this; }
  maybeSingle(): this { this.mode = "maybeSingle"; return this; }

  private matchesOr(row: Row, group: OrCondition[]): boolean {
    return group.some(({ field, op, value }) => {
      const v = row[field];
      if (op === "is" && value === "null") return v == null;
      if (v == null) return false;
      if (op === "eq") return String(v) === value;
      if (op === "neq") return String(v) !== value;
      if (op === "lt") return String(v) < value;
      if (op === "gt") return String(v) > value;
      throw new Error(`mock or(): unsupported op ${op}`);
    });
  }
  private matches(row: Row): boolean {
    return this.predicates.every((p) => p(row)) && this.orGroups.every((g) => this.matchesOr(row, g));
  }
  private project(row: Row): Row {
    if (!this.returning || this.returning === "*") return { ...row };
    const out: Row = {};
    for (const col of this.returning.split(",").map((s) => s.trim())) out[col] = row[col];
    return out;
  }
  private execute(): DbResult {
    const rows = this.dbRef.rows(this.table);
    let affected: Row[] = [];
    if (this.op === "select") {
      affected = rows.filter((r) => this.matches(r));
      for (const { col, ascending } of [...this.orderBy].reverse()) {
        affected = [...affected].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.limitN !== null) affected = affected.slice(0, this.limitN);
    } else if (this.op === "update") {
      affected = rows.filter((r) => this.matches(r));
      for (const row of affected) Object.assign(row, this.patch);
    } else if (this.op === "delete") {
      affected = rows.filter((r) => this.matches(r));
      this.dbRef.tables.set(this.table, rows.filter((r) => !affected.includes(r)));
    } else {
      const defaults = TABLE_DEFAULTS[this.table] ?? (() => ({ id: randomUUID() }));
      for (const incoming of this.upsertRows ?? []) {
        const existing = rows.find((r) => this.onConflict.every((k) => r[k] === incoming[k]));
        if (existing) { Object.assign(existing, incoming); affected.push(existing); }
        else { const fresh = { ...defaults(), ...incoming }; rows.push(fresh); affected.push(fresh); }
      }
    }
    const projected = affected.map((r) => this.project(r));
    if (this.mode === "single") {
      if (projected.length !== 1) return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${projected.length}` } };
      return { data: projected[0], error: null };
    }
    if (this.mode === "maybeSingle") {
      if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: `expected ≤1 row, got ${projected.length}` } };
      return { data: projected[0] ?? null, error: null };
    }
    return { data: projected, error: null, count: projected.length };
  }
  then<T1 = DbResult, T2 = never>(
    onfulfilled?: ((value: DbResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}

// ── Scripted Admin GraphQL transport ──────────────────────────────────────────

type PageScript =
  | { kind: "page"; nodes: unknown[]; hasNextPage: boolean; endCursor: string | null; cost?: { currentlyAvailable: number; restoreRate: number } }
  | { kind: "throttle-http" }
  | { kind: "throttle-gql" }
  | { kind: "auth" }
  | { kind: "hook"; run: () => void; then: PageScript };

let pageScripts: PageScript[] = [];
let countValue = 0;
let productFetches = 0;

function makeNode(i: number, status = "ACTIVE"): unknown {
  return {
    id: `gid://shopify/Product/${1000 + i}`,
    handle: `p-${i}`,
    title: `Product ${i}`,
    descriptionHtml: `<p>Item ${i}</p>`,
    status,
    vendor: "Acme",
    productType: "Widget",
    tags: ["t"],
    onlineStoreUrl: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: `2026-02-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    priceRangeV2: { minVariantPrice: { amount: "10.00", currencyCode: "USD" }, maxVariantPrice: { amount: "10.00", currencyCode: "USD" } },
    featuredImage: { id: `gid://shopify/ProductImage/${9000 + i}`, url: `https://cdn/${i}.jpg`, width: 100, height: 100, altText: null },
    images: { edges: [{ node: { id: `gid://shopify/ProductImage/${9000 + i}`, url: `https://cdn/${i}.jpg`, width: 100, height: 100, altText: null } }] },
    variants: { edges: [{ node: { id: `gid://shopify/ProductVariant/${5000 + i}`, title: "Default", price: "10.00", sku: `SKU-${i}`, availableForSale: true, compareAtPrice: null, image: null } }] },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function installFetch() {
  productFetches = 0;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? "{}") as { query?: string };
    if (parsed.query?.includes("productsCount")) {
      return jsonResponse(200, { data: { productsCount: { count: countValue } } });
    }
    productFetches++;
    let script = pageScripts.shift();
    while (script?.kind === "hook") { script.run(); script = script.then; }
    if (!script) throw new Error("mock fetch: no scripted page response left");
    if (script.kind === "auth") return jsonResponse(401, { errors: [{ message: "Unauthorized" }] });
    if (script.kind === "throttle-http") return jsonResponse(429, { errors: [{ message: "Throttled" }], extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } });
    if (script.kind === "throttle-gql") return jsonResponse(200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: { throttleStatus: { currentlyAvailable: 5, restoreRate: 50 } } } });
    return jsonResponse(200, {
      data: { products: { edges: script.nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: script.hasNextPage, endCursor: script.endCursor } } },
      extensions: { cost: { throttleStatus: { currentlyAvailable: script.cost?.currentlyAvailable ?? 900, restoreRate: script.cost?.restoreRate ?? 50 } } },
    });
  }) as unknown as typeof fetch;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";

async function main() {
  const connStore = await import("../src/lib/server/shopify/connectionStore");
  const productStore = await import("../src/lib/server/shopify/productStore");
  const engine = await import("../src/lib/server/shopify/syncEngine");

  installFetch();

  let mock: MockDb;
  function reset(planLimit = 1000) {
    mock = new MockDb();
    connStore.__setDbClientForTests(mock);
    productStore.__setDbClientForTests(mock);
    engine.__setPlanResolverForTests(async () => planLimit);
    engine.__setTuningForTests({ throttleBackoffMs: 1, pageBudgetMs: 20_000, maxPages: 3, pageSize: 50 });
    pageScripts = [];
    countValue = 0;
    productFetches = 0;
  }
  async function seedConnection(overrides: Partial<Row> = {}): Promise<string> {
    const row = await connStore.upsertConnection(USER, {
      shopDomain: "demo-store.myshopify.com",
      accessToken: "shpat_secret_token",
      scopes: ["read_products"],
      shopName: "Demo",
      primaryDomain: "shop.demo.com",
    });
    Object.assign(mock.rows("store_connections")[0], overrides);
    return row.id;
  }
  function connRow(id: string): Row {
    return mock.rows("store_connections").find((r) => r.id === id)!;
  }
  function liveProducts(connId: string): Row[] {
    return mock.rows("store_products").filter((r) => r.store_connection_id === connId && r.deleted_at == null);
  }

  console.log("\nShopify syncEngine tests\n");

  // ── idle → running → completed (+ tombstone sweep) ──────────────────────────
  await test("idle → completed in one chunk: upserts products, sweeps stale tombstones", async () => {
    reset();
    const connId = await seedConnection();
    // Pre-seed a product from a PRIOR run that this run will not see → must be tombstoned.
    mock.rows("store_products").push({
      id: randomUUID(), vibepin_user_id: USER, store_connection_id: connId, source: "shopify",
      external_product_id: "old-1", title: "Old", status: "active", availability: "unknown",
      deleted_at: null, last_synced_at: "2020-01-01T00:00:00Z", tags: [], image_count: 0,
    });
    pageScripts = [{ kind: "page", nodes: [makeNode(1), makeNode(2)], hasNextPage: false, endCursor: "c1" }];

    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.state, "completed", "completed state");
    assertEq(res.hasMore, false, "no more");
    assertEq(res.syncedCount, 2, "synced 2");
    const row = connRow(connId);
    assertEq(row.sync_status, "completed", "row completed");
    assertEq(row.sync_cursor, null, "cursor cleared");
    assert(row.last_full_sync_at, "last_full_sync_at stamped");
    assertEq(liveProducts(connId).length, 2, "2 live products (old one tombstoned)");
    const old = mock.rows("store_products").find((r) => r.external_product_id === "old-1")!;
    assertEq(old.status, "deleted", "stale product tombstoned");
    assert(old.deleted_at, "deleted_at stamped on stale product");
  });

  // ── multi-page within budget ────────────────────────────────────────────────
  await test("multi-page run completes across pages within budget", async () => {
    reset();
    const connId = await seedConnection();
    pageScripts = [
      { kind: "page", nodes: [makeNode(1)], hasNextPage: true, endCursor: "cA" },
      { kind: "page", nodes: [makeNode(2), makeNode(3)], hasNextPage: false, endCursor: "cB" },
    ];
    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.state, "completed", "completed");
    assertEq(res.syncedCount, 3, "3 across two pages");
    assertEq(productFetches, 2, "two product fetches");
  });

  // ── page-cap pause → running hasMore, lock released, then resume ────────────
  await test("page cap → running/hasMore, lock released; next chunk resumes via takeover", async () => {
    reset();
    engine.__setTuningForTests({ maxPages: 1, throttleBackoffMs: 1 });
    const connId = await seedConnection();
    pageScripts = [{ kind: "page", nodes: [makeNode(1)], hasNextPage: true, endCursor: "cursor-1" }];

    const first = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(first.state, "running", "paused running");
    assertEq(first.hasMore, true, "hasMore true");
    assertEq(first.cursor, "cursor-1", "cursor returned");
    const row = connRow(connId);
    assertEq(row.sync_status, "running", "row still running");
    assertEq(row.sync_cursor, "cursor-1", "cursor persisted");
    assert(String(row.sync_lock_expires_at) < new Date().toISOString(), "lock released (expired) for takeover");

    // Next chunk (non-fresh) takes over the expired lock and finishes.
    pageScripts = [{ kind: "page", nodes: [makeNode(2)], hasNextPage: false, endCursor: "cursor-2" }];
    const second = await engine.runSyncChunk(USER, connId, { freshRun: false });
    assertEq(second.state, "completed", "resume completes");
    assertEq(second.syncedCount, 2, "cumulative count preserved across chunks");
  });

  // ── fresh run resets, live lock 409 ──────────────────────────────────────────
  await test("freshRun resets a stale cursor/count before the first page", async () => {
    reset();
    const connId = await seedConnection({ sync_status: "completed", sync_cursor: "stale", synced_count: 77 });
    pageScripts = [{ kind: "page", nodes: [makeNode(1)], hasNextPage: false, endCursor: "c" }];
    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.syncedCount, 1, "count restarted from 0 (not 77)");
  });

  await test("live lock held by another run → SyncInProgressError (409)", async () => {
    reset();
    const connId = await seedConnection({
      sync_status: "running",
      sync_run_id: "other-run",
      sync_lock_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await expectReject(() => engine.runSyncChunk(USER, connId, { freshRun: false }), "sync_in_progress");
  });

  await test("missing / disconnected connection → SyncNotConnectedError (409)", async () => {
    reset();
    await expectReject(() => engine.runSyncChunk(USER, randomUUID(), { freshRun: true }), "not_connected");
    const connId = await seedConnection({ status: "disconnected", disconnected_at: new Date().toISOString() });
    await expectReject(() => engine.runSyncChunk(USER, connId, { freshRun: true }), "not_connected");
  });

  // ── superseded run abandoned ─────────────────────────────────────────────────
  await test("run superseded mid-chunk (updateSyncProgress rejects) → SyncSupersededError", async () => {
    reset();
    engine.__setTuningForTests({ maxPages: 3, throttleBackoffMs: 1 });
    const connId = await seedConnection();
    // Page 1 fetch succeeds; a hook flips sync_run_id BEFORE page 2's progress write,
    // simulating a concurrent takeover so our updateSyncProgress writes nothing.
    pageScripts = [
      { kind: "page", nodes: [makeNode(1)], hasNextPage: true, endCursor: "cA" },
      { kind: "hook", run: () => { connRow(connId).sync_run_id = "usurper"; }, then: { kind: "page", nodes: [makeNode(2)], hasNextPage: true, endCursor: "cB" } },
    ];
    await expectReject(() => engine.runSyncChunk(USER, connId, { freshRun: true }), "sync_superseded");
    // finishSync must NOT have moved the (usurped) row to error.
    assertEq(connRow(connId).sync_status, "running", "usurped row left running for the new owner");
  });

  // ── entitlement boundary 99 + 50 → 100, correct total, no tombstone ─────────
  await test("entitlement cap: 99 synced + 50-page → capped at 100 with totalCount, no tombstone", async () => {
    reset(100);
    const connId = await seedConnection({
      sync_status: "error", sync_cursor: "c99", synced_count: 99, sync_started_at: "2026-03-01T00:00:00Z",
    });
    // A pre-existing product from before this run — a limit_reached must NOT tombstone it.
    mock.rows("store_products").push({
      id: randomUUID(), vibepin_user_id: USER, store_connection_id: connId, source: "shopify",
      external_product_id: "keep-1", title: "Keep", status: "active", availability: "unknown",
      deleted_at: null, last_synced_at: "2020-01-01T00:00:00Z", tags: [], image_count: 0,
    });
    countValue = 342;
    pageScripts = [{ kind: "page", nodes: Array.from({ length: 50 }, (_, i) => makeNode(i)), hasNextPage: true, endCursor: "c-more" }];

    const res = await engine.runSyncChunk(USER, connId, { freshRun: false });
    assertEq(res.state, "limit_reached", "limit_reached");
    assertEq(res.syncedCount, 100, "capped exactly at 100 (99 + 1)");
    assertEq(res.totalCount, 342, "totalCount from productsCount");
    assertEq(connRow(connId).sync_status, "limit_reached", "row limit_reached");
    assertEq(connRow(connId).total_count, 342, "total persisted for banner");
    const keep = mock.rows("store_products").find((r) => r.external_product_id === "keep-1")!;
    assertEq(keep.deleted_at, null, "limit_reached does NOT tombstone");
    assertEq(liveProducts(connId).length, 2, "only 1 new product persisted (99→100) + the kept one");
  });

  // ── THROTTLED backoff ────────────────────────────────────────────────────────
  await test("THROTTLED then success: backoff + retry, page processed", async () => {
    reset();
    const connId = await seedConnection();
    pageScripts = [
      { kind: "throttle-gql" },
      { kind: "page", nodes: [makeNode(1)], hasNextPage: false, endCursor: "c" },
    ];
    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.state, "completed", "recovered after one throttle");
    assertEq(res.syncedCount, 1, "page processed after retry");
  });

  await test("persistent THROTTLED → running/hasMore (yield chunk), lock released", async () => {
    reset();
    const connId = await seedConnection();
    pageScripts = [{ kind: "throttle-http" }, { kind: "throttle-http" }];
    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.state, "running", "still running");
    assertEq(res.hasMore, true, "hasMore so client retries");
    assert(String(connRow(connId).sync_lock_expires_at) < new Date().toISOString(), "lock released after throttle yield");
  });

  // ── AuthError → reauth_required ──────────────────────────────────────────────
  await test("401 from Admin API → error state + connection flagged reauth_required", async () => {
    reset();
    const connId = await seedConnection();
    pageScripts = [{ kind: "auth" }];
    const res = await engine.runSyncChunk(USER, connId, { freshRun: true });
    assertEq(res.state, "error", "error state");
    assertEq(res.error, "reauth_required", "reauth error reason");
    assertEq(connRow(connId).status, "reauth_required", "connection flagged reauth_required");
    assertEq(connRow(connId).sync_status, "error", "sync error state");
  });

  // ── reauth_required connection cannot start a sync ───────────────────────────
  await test("connection already reauth_required → SyncNotConnectedError", async () => {
    reset();
    const connId = await seedConnection({ status: "reauth_required" });
    await expectReject(() => engine.runSyncChunk(USER, connId, { freshRun: true }), "not_connected");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
