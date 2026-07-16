/**
 * Shared in-memory mock of the narrow SupabaseLikeDb used by the admin derivation
 * helpers (adminQueryUtils.ts). It supports the chained query surface the helpers
 * use — select/eq/in/gte/lt/is/not/order/range/limit — running the filters against
 * an in-memory table and honoring .range() so pagination-loop tests can prove a
 * >1000-row source is NOT truncated at supabase-js's silent 1000 cap.
 *
 * Not a real Postgres: filters are simple JS predicates, which is exactly what the
 * derivation logic needs to be exercised deterministically.
 */

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string } | null;

export interface TableSpec {
  rows?: Row[];
  /** Force an error for this table (e.g. missing column / relation). */
  error?: PgError;
}

interface PendingFilter {
  kind: "eq" | "in" | "gte" | "lt" | "is" | "not_is";
  column: string;
  value: unknown;
}

function applyFilters(rows: Row[], filters: PendingFilter[]): Row[] {
  return rows.filter(r => filters.every(f => {
    const v = r[f.column];
    switch (f.kind) {
      case "eq": return v === f.value;
      case "in": return (f.value as unknown[]).includes(v);
      case "gte": return v != null && (v as string | number) >= (f.value as string | number);
      case "lt": return v != null && (v as string | number) < (f.value as string | number);
      case "is": return v === null || v === undefined; // .is(col, null)
      case "not_is": return v !== null && v !== undefined; // .not(col,'is',null)
      default: return true;
    }
  }));
}

export function makeMockDb(
  tables: Record<string, TableSpec>,
  authUsers: Row[] = [],
  opts: { authError?: boolean } = {},
): {
  db: import("../src/lib/server/adminQueryUtils").SupabaseLikeDb;
  roundTrips: () => number;
} {
  let roundTrips = 0;

  function tableRef(table: string) {
    const spec = tables[table];
    const filters: PendingFilter[] = [];
    let orderCol: string | null = null;
    let asc = false;
    let rangeFrom = 0;
    let rangeTo = Infinity;
    let countMode = false;

    const builder: Record<string, unknown> = {
      select(_columns: string, o?: { count?: string; head?: boolean }) {
        if (o?.count === "exact") countMode = true;
        return builder;
      },
      eq(column: string, value: unknown) { filters.push({ kind: "eq", column, value }); return builder; },
      in(column: string, value: readonly unknown[]) { filters.push({ kind: "in", column, value }); return builder; },
      gte(column: string, value: unknown) { filters.push({ kind: "gte", column, value }); return builder; },
      lt(column: string, value: unknown) { filters.push({ kind: "lt", column, value }); return builder; },
      is(column: string, _value: null) { filters.push({ kind: "is", column, value: null }); return builder; },
      not(column: string, _op: "is", _value: null) { filters.push({ kind: "not_is", column, value: null }); return builder; },
      order(column: string, o: { ascending: boolean }) { orderCol = column; asc = o.ascending; return builder; },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return builder; },
      limit(_n: number) { return builder; },
      then(resolve: (v: { data: Row[] | null; error: PgError; count?: number | null }) => unknown) {
        roundTrips += 1;
        if (!spec) {
          // Missing relation.
          return Promise.resolve({ data: null, error: { code: "42P01", message: `relation "${table}" does not exist` }, count: null }).then(resolve);
        }
        if (spec.error) {
          return Promise.resolve({ data: null, error: spec.error, count: null }).then(resolve);
        }
        let out = applyFilters(spec.rows ?? [], filters);
        if (orderCol) {
          const col = orderCol;
          out = [...out].sort((a, b) => {
            const av = (a[col] ?? "") as string;
            const bv = (b[col] ?? "") as string;
            return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
          });
        }
        if (countMode) {
          return Promise.resolve({ data: null, error: null, count: out.length }).then(resolve);
        }
        const sliced = out.slice(rangeFrom, rangeTo === Infinity ? undefined : rangeTo + 1);
        return Promise.resolve({ data: sliced, error: null, count: out.length }).then(resolve);
      },
    };
    return builder;
  }

  const db = {
    from(table: string) { return tableRef(table) as never; },
    auth: {
      admin: {
        async listUsers({ page, perPage }: { page: number; perPage: number }) {
          if (opts.authError) return { data: null, error: { message: "no service role" } };
          const start = (page - 1) * perPage;
          const slice = authUsers.slice(start, start + perPage);
          return { data: { users: slice }, error: null };
        },
        async getUserById(id: string) {
          if (opts.authError) return { data: null, error: { message: "no service role" } };
          const u = authUsers.find(x => x.id === id);
          return u ? { data: { user: u }, error: null } : { data: null, error: { message: "not found" } };
        },
      },
    },
  } as unknown as import("../src/lib/server/adminQueryUtils").SupabaseLikeDb;

  return { db, roundTrips: () => roundTrips };
}

// ── tiny test harness shared by the three admin test scripts ──────────────────

export function makeHarness() {
  let passed = 0, failed = 0;
  const pending: Promise<void>[] = [];
  function test(name: string, fn: () => void | Promise<void>): void {
    const run = (async () => {
      try { await fn(); passed++; console.log(`  OK ${name}`); }
      catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).stack ?? (e as Error).message}`); }
    })();
    pending.push(run);
  }
  async function done(): Promise<void> {
    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
  return { test, done };
}
