/**
 * Shopify connectionStore unit tests (WP1).
 * Run: npx tsx scripts/test-shopify-connection-store.ts
 *
 * Injects an in-memory mock Supabase client via __setDbClientForTests — no
 * network, no real tables. The mock implements just the PostgREST surface the
 * store uses (select/update/upsert + eq/is/or filters + single/maybeSingle),
 * including the `.or()` CAS clause semantics (SQL-style: null comparisons are
 * false) so lock takeover behaviour is exercised realistically.
 */

import { randomBytes, randomUUID } from "node:crypto";

// Env must be set BEFORE the server modules load.
process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

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
async function expectThrow(fn: () => Promise<unknown> | unknown, msg: string) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

// ── In-memory mock Supabase client ───────────────────────────────────────────

type Row = Record<string, unknown>;
type DbResult = { data: unknown; error: { code: string; message: string } | null; count?: number | null };

const TABLE_DEFAULTS: Record<string, () => Row> = {
  store_connections: () => ({
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
  }),
};

class MockDb {
  tables = new Map<string, Row[]>();
  missingTables = new Set<string>();

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  from(table: string): MockQuery {
    return new MockQuery(this, table);
  }
}

type OrCondition = { field: string; op: string; value: string };

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

  select(cols = "*"): this {
    if (this.op === "select") this.returning = cols;
    else this.returning = cols;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    this.onConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] != null && row[field] === value);
    return this;
  }
  is(field: string, value: null): this {
    this.predicates.push((row) => row[field] == null && value === null);
    return this;
  }
  lt(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] != null && String(row[field]) < String(value));
    return this;
  }
  gt(field: string, value: unknown): this {
    this.predicates.push((row) => row[field] != null && String(row[field]) > String(value));
    return this;
  }
  in(field: string, values: unknown[]): this {
    this.predicates.push((row) => values.includes(row[field]));
    return this;
  }
  or(expr: string): this {
    // Parse "field.op.value,field.op.value" (no nested and() needed here).
    const conditions: OrCondition[] = expr.split(",").map((part) => {
      const first = part.indexOf(".");
      const second = part.indexOf(".", first + 1);
      const field = part.slice(0, first);
      const op = part.slice(first + 1, second);
      let value = part.slice(second + 1);
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      return { field, op, value };
    });
    this.orGroups.push(conditions);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orderBy.push({ col, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  private matchesOr(row: Row, group: OrCondition[]): boolean {
    return group.some(({ field, op, value }) => {
      const v = row[field];
      if (op === "is" && value === "null") return v == null;
      if (v == null) return false; // SQL three-valued logic: null comparisons are not true
      if (op === "eq") return String(v) === value;
      if (op === "neq") return String(v) !== value;
      if (op === "lt") return String(v) < value;
      if (op === "gt") return String(v) > value;
      throw new Error(`mock or(): unsupported op ${op}`);
    });
  }

  private matches(row: Row): boolean {
    return (
      this.predicates.every((p) => p(row))
      && this.orGroups.every((g) => this.matchesOr(row, g))
    );
  }

  private project(row: Row): Row {
    if (!this.returning || this.returning === "*") return { ...row };
    const out: Row = {};
    for (const col of this.returning.split(",").map((s) => s.trim())) out[col] = row[col];
    return out;
  }

  private execute(): DbResult {
    if (this.dbRef.missingTables.has(this.table)) {
      return {
        data: null,
        error: {
          code: "PGRST205",
          message: `Could not find the table 'public.${this.table}' in the schema cache`,
        },
      };
    }

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
      // upsert
      const defaults = TABLE_DEFAULTS[this.table] ?? (() => ({ id: randomUUID() }));
      for (const incoming of this.upsertRows ?? []) {
        const existing = rows.find((r) => this.onConflict.every((k) => r[k] === incoming[k]));
        if (existing) {
          Object.assign(existing, incoming);
          affected.push(existing);
        } else {
          const fresh = { ...defaults(), ...incoming };
          rows.push(fresh);
          affected.push(fresh);
        }
      }
    }

    const projected = affected.map((r) => this.project(r));
    if (this.mode === "single") {
      if (projected.length !== 1) {
        return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${projected.length}` } };
      }
      return { data: projected[0], error: null };
    }
    if (this.mode === "maybeSingle") {
      if (projected.length > 1) {
        return { data: null, error: { code: "PGRST116", message: `expected at most 1 row, got ${projected.length}` } };
      }
      return { data: projected[0] ?? null, error: null };
    }
    return { data: projected, error: null, count: projected.length };
  }

  then<TResult1 = DbResult, TResult2 = never>(
    onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PLAINTEXT_TOKEN = "shpat_super_secret_admin_token";

async function main() {
  const store = await import("../src/lib/server/shopify/connectionStore");
  const mock = new MockDb();
  store.__setDbClientForTests(mock);

  console.log("\nShopify connectionStore tests\n");

  let connId = "";

  // ── upsert / read ───────────────────────────────────────────────────────────
  await test("upsertConnection encrypts the token and normalizes the shop domain", async () => {
    const row = await store.upsertConnection(USER, {
      shopDomain: "Demo-Store.MyShopify.com",
      accessToken: PLAINTEXT_TOKEN,
      scopes: ["read_products"],
      shopName: "Demo Store",
      primaryDomain: "demo.example.com",
    });
    connId = row.id;
    assertEq(row.shop_domain, "demo-store.myshopify.com", "domain lowercased");
    assertEq(row.provider, "shopify", "provider");
    assertEq(row.status, "connected", "status connected");
    assert(row.access_token_encrypted?.startsWith("v1:"), "token is v1: ciphertext");
    assert(!String(row.access_token_encrypted).includes(PLAINTEXT_TOKEN), "no plaintext token at rest");
    assertEq(store.decryptAccessToken(row), PLAINTEXT_TOKEN, "decrypt roundtrip");
  });

  await test("upsertConnection is keyed on (user, shop_domain) — reconnect overwrites, no duplicate row", async () => {
    const row = await store.upsertConnection(USER, {
      shopDomain: "demo-store.myshopify.com",
      accessToken: "shpat_rotated_token",
      scopes: ["read_products"],
      shopName: "Demo Store 2",
    });
    assertEq(mock.rows("store_connections").length, 1, "still one row");
    assertEq(row.id, connId, "same row id");
    assertEq(store.decryptAccessToken(row), "shpat_rotated_token", "token rotated");
    assertEq(row.shop_name, "Demo Store 2", "shop name updated");
  });

  await test("getConnection / getByShopDomain are user-scoped", async () => {
    assert(await store.getConnection(USER, connId), "owner reads row");
    assertEq(await store.getConnection(OTHER_USER, connId), null, "other user sees nothing");
    const byDomain = await store.getByShopDomain(USER, "DEMO-STORE.myshopify.com");
    assertEq(byDomain?.id, connId, "domain lookup normalized");
    assertEq(await store.getByShopDomain(OTHER_USER, "demo-store.myshopify.com"), null, "domain lookup user-scoped");
  });

  // ── CAS sync lock ───────────────────────────────────────────────────────────
  await test("acquireSyncLock wins on idle (freshRun resets progress + stamps sync_started_at)", async () => {
    // Seed stale progress to prove freshRun clears it.
    const raw = mock.rows("store_connections")[0];
    raw.sync_cursor = "old-cursor";
    raw.synced_count = 42;
    raw.total_count = 99;
    raw.sync_error = "old error";

    const row = await store.acquireSyncLock(connId, USER, "run-1", { freshRun: true });
    assert(row, "lock acquired");
    assertEq(row!.sync_status, "running", "running");
    assertEq(row!.sync_run_id, "run-1", "run id");
    assertEq(row!.sync_cursor, null, "cursor reset");
    assertEq(row!.synced_count, 0, "count reset");
    assertEq(row!.total_count, null, "total reset");
    assertEq(row!.sync_error, null, "error reset");
    assert(row!.sync_started_at, "sync_started_at stamped");
    assert(
      row!.sync_lock_expires_at && row!.sync_lock_expires_at > new Date().toISOString(),
      "lock expiry in the future",
    );
  });

  await test("acquireSyncLock CAS miss: live lock held by another run → null, row untouched", async () => {
    const res = await store.acquireSyncLock(connId, USER, "run-2");
    assertEq(res, null, "second acquire rejected");
    const row = await store.getConnection(USER, connId);
    assertEq(row!.sync_run_id, "run-1", "original run keeps the lock");
    assertEq(row!.sync_status, "running", "still running");
  });

  await test("acquireSyncLock is user-scoped (someone else's id cannot lock)", async () => {
    assertEq(await store.acquireSyncLock(connId, OTHER_USER, "run-x"), null, "foreign user rejected");
  });

  await test("updateSyncProgress persists cursor/count and renews the lock for the owning run", async () => {
    const before = (await store.getConnection(USER, connId))!.sync_lock_expires_at!;
    await new Promise((r) => setTimeout(r, 5));
    const row = await store.updateSyncProgress(connId, "run-1", { cursor: "cursor-p1", syncedCount: 50 });
    assert(row, "progress applied");
    assertEq(row!.sync_cursor, "cursor-p1", "cursor stored");
    assertEq(row!.synced_count, 50, "count stored");
    assert(row!.sync_lock_expires_at! >= before, "lock renewed (heartbeat)");
  });

  await test("updateSyncProgress rejects a stale run_id (superseded chunk writes nothing)", async () => {
    const res = await store.updateSyncProgress(connId, "run-STALE", { cursor: "evil", syncedCount: 9999 });
    assertEq(res, null, "stale chunk rejected");
    const row = await store.getConnection(USER, connId);
    assertEq(row!.sync_cursor, "cursor-p1", "cursor unchanged");
    assertEq(row!.synced_count, 50, "count unchanged");
  });

  await test("renewSyncLock: true for the owning run, false for a stale run", async () => {
    assertEq(await store.renewSyncLock(connId, "run-1"), true, "owner renews");
    assertEq(await store.renewSyncLock(connId, "run-STALE"), false, "stale run cannot renew");
  });

  await test("expired lock takeover: new run acquires WITHOUT freshRun and inherits the cursor", async () => {
    const raw = mock.rows("store_connections")[0];
    raw.sync_lock_expires_at = new Date(Date.now() - 1000).toISOString(); // simulate crashed run
    const row = await store.acquireSyncLock(connId, USER, "run-3");
    assert(row, "takeover succeeds on expired lock");
    assertEq(row!.sync_run_id, "run-3", "new run id");
    assertEq(row!.sync_cursor, "cursor-p1", "cursor preserved for resume");
    assertEq(row!.synced_count, 50, "progress preserved");
  });

  await test("finishSync rejects a stale run_id", async () => {
    const res = await store.finishSync(connId, "run-1", "completed");
    assertEq(res, null, "superseded run cannot finish");
    const row = await store.getConnection(USER, connId);
    assertEq(row!.sync_status, "running", "row still running under run-3");
  });

  await test("finishSync(error) clears the lock but KEEPS the cursor (resumable)", async () => {
    const row = await store.finishSync(connId, "run-3", "error", { error: "THROTTLED" });
    assert(row, "finish applied");
    assertEq(row!.sync_status, "error", "error state");
    assertEq(row!.sync_error, "THROTTLED", "error message");
    assertEq(row!.sync_lock_expires_at, null, "lock cleared");
    assertEq(row!.sync_cursor, "cursor-p1", "cursor kept for resume");
    assertEq(store.toSafeStatus(row!).sync.resumable, true, "safe status reports resumable");
  });

  await test("error state resume: next acquire without freshRun continues from the cursor", async () => {
    const row = await store.acquireSyncLock(connId, USER, "run-4");
    assert(row, "resume acquire succeeds from error state");
    assertEq(row!.sync_cursor, "cursor-p1", "resumes from kept cursor");
    assertEq(row!.sync_status, "running", "running again");
  });

  await test("finishSync(completed) clears cursor + stamps last_full_sync_at", async () => {
    const row = await store.finishSync(connId, "run-4", "completed", { syncedCount: 120, totalCount: 120 });
    assert(row, "completed");
    assertEq(row!.sync_status, "completed", "completed state");
    assertEq(row!.sync_cursor, null, "cursor cleared");
    assertEq(row!.sync_error, null, "error cleared");
    assertEq(row!.synced_count, 120, "final count");
    assertEq(row!.total_count, 120, "total recorded");
    assert(row!.last_full_sync_at, "last_full_sync_at stamped");
    assertEq(store.toSafeStatus(row!).sync.resumable, false, "completed not resumable");
  });

  await test("finishSync(limit_reached) records total_count for the 'X of Y' banner", async () => {
    const locked = await store.acquireSyncLock(connId, USER, "run-5", { freshRun: true });
    assert(locked, "fresh run acquired from terminal state");
    assertEq(locked!.synced_count, 0, "fresh run reset count");
    const row = await store.finishSync(connId, "run-5", "limit_reached", { syncedCount: 100, totalCount: 342 });
    assertEq(row!.sync_status, "limit_reached", "limit_reached state");
    assertEq(row!.synced_count, 100, "capped count");
    assertEq(row!.total_count, 342, "total for banner");
    assertEq(row!.sync_cursor, null, "cursor cleared");
    assertEq(store.toSafeStatus(row!).sync.resumable, false, "limit_reached not resumable");
  });

  // ── toSafeStatus ────────────────────────────────────────────────────────────
  await test("toSafeStatus never leaks token material (no field, no ciphertext, no plaintext)", async () => {
    const row = (await store.getConnection(USER, connId))!;
    assert(row.access_token_encrypted, "precondition: row has a stored token");
    const safe = store.toSafeStatus(row);
    const json = JSON.stringify(safe);
    assert(!("access_token_encrypted" in (safe as unknown as Record<string, unknown>)), "no token key");
    assert(!json.includes("v1:"), "no ciphertext in safe status");
    assert(!json.toLowerCase().includes("token"), "no token-named field at all");
    assert(!json.includes("shpat_"), "no plaintext token");
    assertEq(safe.shopDomain, "demo-store.myshopify.com", "domain surfaced");
    assertEq(safe.status, "connected", "status surfaced");
    assertEq(safe.sync.syncedCount, 100, "sync count surfaced");
    assertEq(safe.sync.totalCount, 342, "total surfaced");
  });

  await test("toSafeStatus derives disconnected/reauth_required from row state", async () => {
    const base = (await store.getConnection(USER, connId))!;
    const noToken = { ...base, access_token_encrypted: null };
    assertEq(store.toSafeStatus(noToken).status, "reauth_required", "token gone → reauth_required");
    const gone = { ...base, disconnected_at: new Date().toISOString() };
    assertEq(store.toSafeStatus(gone).status, "disconnected", "disconnected_at → disconnected");
  });

  // ── status transitions ─────────────────────────────────────────────────────
  await test("markReauthRequired flips status", async () => {
    assertEq(await store.markReauthRequired(connId), true, "marked");
    assertEq((await store.getConnection(USER, connId))!.status, "reauth_required", "status flipped");
    assertEq(await store.markReauthRequired(randomUUID()), false, "unknown id → false");
  });

  await test("disconnect drops the token and marks the row disconnected", async () => {
    assertEq(await store.disconnect(connId, OTHER_USER), false, "foreign user cannot disconnect");
    assertEq(await store.disconnect(connId, USER), true, "owner disconnects");
    const row = (await store.getConnection(USER, connId))!;
    assertEq(row.access_token_encrypted, null, "token dropped");
    assertEq(row.status, "disconnected", "status disconnected");
    assert(row.disconnected_at, "disconnected_at stamped");
    assertEq(row.sync_status, "idle", "sync state reset");
  });

  await test("markUninstalled targets active rows by shop domain and returns (id, user) pairs", async () => {
    await store.upsertConnection(USER, {
      shopDomain: "demo-store.myshopify.com",
      accessToken: PLAINTEXT_TOKEN,
      scopes: ["read_products"],
    });
    const affected = await store.markUninstalled("Demo-Store.MyShopify.com");
    assertEq(affected.length, 1, "one active row affected");
    assertEq(affected[0].id, connId, "row id returned");
    assertEq(affected[0].vibepin_user_id, USER, "user id returned for tombstoning");
    const row = (await store.getConnection(USER, connId))!;
    assertEq(row.access_token_encrypted, null, "token dropped");
    assert(row.uninstalled_at, "uninstalled_at stamped");
    assertEq(row.status, "disconnected", "status disconnected");
    const again = await store.markUninstalled("demo-store.myshopify.com");
    assertEq(again.length, 0, "idempotent: already-disconnected rows not re-affected");
  });

  await test("listConnections returns the user's rows and is user-scoped", async () => {
    const mine = await store.listConnections(USER);
    assertEq(mine.length, 1, "one row for owner (history kept after disconnect)");
    assertEq((await store.listConnections(OTHER_USER)).length, 0, "other user sees none");
  });

  // ── missing-table degradation (v39 not applied, 裁决 i) ─────────────────────
  await test("missing table: reads degrade gracefully (list → [], get → null, uninstall → [])", async () => {
    mock.missingTables.add("store_connections");
    try {
      assertEq((await store.listConnections(USER)).length, 0, "listConnections → []");
      assertEq(await store.getConnection(USER, connId), null, "getConnection → null");
      assertEq(await store.getByShopDomain(USER, "demo-store.myshopify.com"), null, "getByShopDomain → null");
      assertEq((await store.markUninstalled("demo-store.myshopify.com")).length, 0, "webhook path → []");
    } finally {
      mock.missingTables.delete("store_connections");
    }
  });

  await test("missing table: write paths throw a typed StoreDatabaseError", async () => {
    mock.missingTables.add("store_connections");
    try {
      await expectThrow(
        () => store.upsertConnection(USER, { shopDomain: "x.myshopify.com", accessToken: "t", scopes: [] }),
        "upsert should throw when the table is missing",
      );
      try {
        await store.upsertConnection(USER, { shopDomain: "x.myshopify.com", accessToken: "t", scopes: [] });
      } catch (e) {
        assertEq((e as { code?: string }).code, "database_error", "typed error code");
        assert(e instanceof store.StoreDatabaseError, "StoreDatabaseError instance");
      }
    } finally {
      mock.missingTables.delete("store_connections");
    }
  });

  await test("isMissingTableError recognizes PGRST205 / 42P01 / message forms only", () => {
    assert(store.isMissingTableError("PGRST205", "whatever"), "PGRST205");
    assert(store.isMissingTableError("42P01", "whatever"), "42P01");
    assert(
      store.isMissingTableError(undefined, "Could not find the table 'public.store_connections' in the schema cache"),
      "message form",
    );
    assert(store.isMissingTableError(undefined, 'relation "store_products" does not exist'), "relation form");
    assert(!store.isMissingTableError("23505", "duplicate key value"), "unique violation is not missing-table");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
