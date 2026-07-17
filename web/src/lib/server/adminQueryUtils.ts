// ── Shared query utilities for the admin operator-console derivation layer ────
//
// server-only. Provides:
//   * a narrow SupabaseLikeDb interface (so helpers can be unit-tested with a
//     mock — the tests inject this, production passes the real service client),
//   * schema-degradation helpers (missing table / column → warning, never crash),
//   * a paginated .range() row loader that NEVER silently truncates at supabase-js's
//     1000-row cap,
//   * a paginated auth.admin.listUsers loop.
//
// These deliberately mirror adminOverview.ts / customer360.ts conventions.

export type PgError = { code?: string; message?: string } | null;

/**
 * The minimal supabase query-builder surface the admin helpers use. Every method
 * that narrows a query returns `this` so calls chain; the builder is awaited to
 * run. Kept intentionally small so a test mock is easy to write and type-check.
 */
export interface SelectBuilder<Row> extends PromiseLike<{ data: Row[] | null; error: PgError; count?: number | null }> {
  eq(column: string, value: unknown): SelectBuilder<Row>;
  in(column: string, values: readonly unknown[]): SelectBuilder<Row>;
  gte(column: string, value: unknown): SelectBuilder<Row>;
  lt(column: string, value: unknown): SelectBuilder<Row>;
  is(column: string, value: null): SelectBuilder<Row>;
  not(column: string, op: "is", value: null): SelectBuilder<Row>;
  order(column: string, opts: { ascending: boolean }): SelectBuilder<Row>;
  range(from: number, to: number): SelectBuilder<Row>;
  limit(n: number): SelectBuilder<Row>;
}

export interface TableRef {
  select<Row = Record<string, unknown>>(
    columns: string,
    opts?: { count?: "exact"; head?: boolean },
  ): SelectBuilder<Row>;
}

export interface AuthAdmin {
  listUsers(params: { page: number; perPage: number }): Promise<{
    data: { users: unknown[] } | null;
    error: PgError;
  }>;
  getUserById(id: string): Promise<{ data: { user: unknown } | null; error: PgError }>;
}

export interface SupabaseLikeDb {
  from(table: string): TableRef;
  auth: { admin: AuthAdmin };
}

// ── schema-degradation classifiers (aligned with customer360.ts) ──────────────

export function isMissingRelation(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

/** undefined_table OR undefined_column — either means "this shape isn't here yet". */
export function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST205" ||
    error.code === "PGRST204"
  ) return true;
  return /(relation|column) .* does not exist|could not find the table/i.test(error.message ?? "");
}

// ── time helpers ──────────────────────────────────────────────────────────────

export function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── auth user shape (subset we read; never tokens) ────────────────────────────

export interface AuthUserLite {
  id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  banned_until?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * Loop auth.admin.listUsers across ALL pages (it is paginated — a single page
 * silently caps the cohort). Returns null (with a warning) if the admin API is
 * unavailable, matching adminOverview.ts's degradation.
 */
export async function listAllAuthUsers(
  db: SupabaseLikeDb,
  warnings: string[],
  perPage = 1000,
  maxPages = 100,
): Promise<AuthUserLite[] | null> {
  const users: AuthUserLite[] = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage });
      if (error || !data) {
        if (page === 1) {
          warnings.push("User list unavailable — auth.admin.listUsers failed (a SUPABASE_SERVICE_ROLE_KEY is required).");
          return null;
        }
        break; // partial page failure — return what we have
      }
      const batch = (data.users ?? []) as unknown as AuthUserLite[];
      users.push(...batch);
      if (batch.length < perPage) break; // last page
      if (page === maxPages) {
        warnings.push(`User pagination stopped at ${maxPages} pages (${users.length} users) — cohort may be incomplete.`);
      }
    }
  } catch {
    if (users.length === 0) {
      warnings.push("User list unavailable — auth admin API threw.");
      return null;
    }
  }
  return users;
}

// ── paginated row loader (never truncates at the 1000-row cap) ─────────────────

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // hard ceiling: 50k rows per scan (windows keep scans bounded)

export interface PaginateOpts<Row> {
  columns: string;
  /** Apply query narrowing (filters). Return the builder. */
  filters?: (qb: SelectBuilder<Row>) => SelectBuilder<Row>;
  /** Column to order by for stable .range() paging (required for correct paging). */
  orderColumn: string;
  ascending: boolean;
}

export interface PaginateResult<Row> {
  rows: Row[];
  error: PgError;
  /** true when the table/relation is entirely absent (vs a column error). */
  missing: boolean;
  /** true when MAX_PAGES was hit and more rows likely exist. */
  saturated: boolean;
}

/**
 * Fetch every row matching the query by looping .range() windows. supabase-js
 * silently caps a plain select at 1000 rows; this keeps paging until a short page
 * is returned (or the hard ceiling). A `.order()` on a stable column is applied so
 * successive windows do not overlap or skip.
 *
 * On error: if the relation is missing → `missing:true`; otherwise the error is
 * returned so the caller can decide (column-missing fallback vs warn).
 */
export async function paginateRows<Row>(
  db: SupabaseLikeDb,
  table: string,
  opts: PaginateOpts<Row>,
): Promise<PaginateResult<Row>> {
  const rows: Row[] = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let qb = db.from(table).select<Row>(opts.columns).order(opts.orderColumn, { ascending: opts.ascending });
      if (opts.filters) qb = opts.filters(qb);
      qb = qb.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error } = await qb;
      if (error) {
        return { rows, error, missing: isMissingRelation(error), saturated: false };
      }
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) {
        return { rows, error: null, missing: false, saturated: false };
      }
      if (page === MAX_PAGES - 1) {
        return { rows, error: null, missing: false, saturated: true };
      }
    }
    return { rows, error: null, missing: false, saturated: true };
  } catch (e) {
    const err: PgError = { message: e instanceof Error ? e.message : String(e) };
    return { rows, error: err, missing: false, saturated: false };
  }
}

/**
 * Build the real service-role client, typed to the narrow interface. Async +
 * dynamic import so this module stays server-only and a test file can import the
 * pure helpers above without ever loading the supabase client.
 */
export async function createAdminDb(): Promise<SupabaseLikeDb> {
  const { createServerClient } = await import("@/lib/supabase");
  return createServerClient() as unknown as SupabaseLikeDb;
}
