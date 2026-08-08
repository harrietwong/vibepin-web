/**
 * GET /api/billing/usage contract tests.
 * Run: npx tsx scripts/test-billing-usage-api.ts
 *
 * This route is the ONLY thing that turns the v55/v56 usage_accounts ledger into
 * numbers a paying customer reads in Settings → Billing. The tests below pin the
 * three behaviours that make those numbers trustworthy:
 *
 *  1. AUTH — an anonymous caller gets 401 and the DB is never touched. Usage is
 *     per-user billing data; it must not leak, and an unauthenticated request
 *     must not cost a query.
 *
 *  2. A USER WITH AN ACCOUNT ROW — real settled counters come back, mapped onto
 *     the response shape. Crucially the `*_reserved` columns are IGNORED: an
 *     in-flight reservation is unconfirmed work that may still be released, so
 *     counting it as "used" would make the customer's number jump up and back
 *     down mid-request.
 *
 *  3. A USER WITH NO ACCOUNT ROW — the honest unmetered shape. Metering is lazy
 *     and in shadow mode, so most users have no row at all. The route must
 *     report `metered:false` with `used:null` and the plan's included
 *     allowances. It must NOT fabricate `used: 0` (that asserts a measurement
 *     that never happened), and it must NOT create an account as a side effect
 *     of a GET — pinned here by asserting the RPC seam is never invoked.
 *
 * Fakes are injected through Module._load (same idiom as
 * test-ai-provider-auth-boundary.ts). No network, no DB, no keys needed.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

export {};

import { Module } from "node:module";

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

// ── Injected state ──────────────────────────────────────────────────────────────

const VALID_BEARER = "valid-access-token";

/** The usage_accounts row the fake DB returns, or null for "no account yet". */
let accountRow: Record<string, unknown> | null = null;
/** A query error to simulate an infra failure (drives the 500 path). */
let accountError: { message: string } | null = null;
/** The plan resolvePlan should report. */
let currentPlan = "free";

const calls = {
  select: 0,
  rpc: 0,
  resolvePlan: 0,
  /** Columns requested — used to prove `*_reserved` is never even selected. */
  selectedColumns: "" as string,
  /** The user_id filter the query applied. */
  filteredUserId: null as string | null,
};
function resetCalls() {
  calls.select = 0;
  calls.rpc = 0;
  calls.resolvePlan = 0;
  calls.selectedColumns = "";
  calls.filteredUserId = null;
}

function fakeGetUserIdFromBearerOrCookies(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (bearer === VALID_BEARER) return Promise.resolve("user-1");
  return Promise.resolve(null);
}

/** Minimal Supabase surface this route uses: .from().select().eq().maybeSingle(). */
function fakeCreateServerClient() {
  return {
    from(_table: string) {
      return {
        select(columns: string) {
          calls.select++;
          calls.selectedColumns = columns;
          return {
            eq(_col: string, value: string) {
              calls.filteredUserId = value;
              return {
                async maybeSingle() {
                  return { data: accountRow, error: accountError };
                },
              };
            },
          };
        },
      };
    },
    // Present so that an accidental ensureUsageAccount call would be COUNTED
    // rather than crashing — the no-row test asserts this stays at zero.
    async rpc(_fn: string, _args: unknown) {
      calls.rpc++;
      return { data: null, error: null };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("server/authUser")) {
    return { getUserIdFromBearerOrCookies: fakeGetUserIdFromBearerOrCookies };
  }
  if (request.includes("server/entitlements")) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      resolvePlan: async () => {
        calls.resolvePlan++;
        return currentPlan;
      },
    };
  }
  // Match the supabase module without also catching @supabase/* packages.
  if (request.endsWith("/supabase") || request.endsWith("lib/supabase")) {
    return { createServerClient: fakeCreateServerClient };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function request(bearer?: string): Request {
  return new Request("https://vibepin.co/api/billing/usage", {
    method: "GET",
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

async function main() {
  console.log("\nGET /api/billing/usage contract tests\n");

  const { GET } = await import("../src/app/api/billing/usage/route");
  const { PLAN_ENTITLEMENTS } = await import("../src/lib/server/planEntitlements");

  // ── 1) Anonymous ──────────────────────────────────────────────────────────────

  await test("anonymous request → 401 and never queries the database", async () => {
    resetCalls();
    accountRow = null;
    const res = await GET(request());
    assertEq(res.status, 401, "status");
    const body = await res.json();
    assertEq(body.error, "unauthorized", "error code");
    assertEq(calls.select, 0, "must not query usage_accounts for an anonymous caller");
    assertEq(calls.resolvePlan, 0, "must not resolve a plan for an anonymous caller");
  });

  await test("a bearer token the auth server rejects is still 401", async () => {
    resetCalls();
    const res = await GET(request("not-a-real-token"));
    assertEq(res.status, 401, "status");
    assertEq(calls.select, 0, "no DB access on rejected credentials");
  });

  // ── 2) Authenticated WITH a usage_accounts row ────────────────────────────────

  await test("authed user WITH an account row → real settled numbers", async () => {
    resetCalls();
    currentPlan = "pro";
    accountError = null;
    accountRow = {
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-08-01T00:00:00.000Z",
      ai_images_used: 42,
      ai_images_limit: 800,
      ai_text_generations_used: 7,
      ai_text_generations_limit: 2000,
      scheduled_posts_used: 3,
      scheduled_posts_limit: 300,
      bonus_images_balance: 25,
    };

    const res = await GET(request(VALID_BEARER));
    assertEq(res.status, 200, "status");
    const body = await res.json();

    assertEq(body.plan, "pro", "plan");
    assertEq(body.metered, true, "metered");
    assertEq(body.periodStart, "2026-07-01T00:00:00.000Z", "periodStart");
    assertEq(body.periodEnd, "2026-08-01T00:00:00.000Z", "periodEnd");
    assertEq(body.bonusImages, 25, "bonusImages");

    assertEq(body.aiImages.used, 42, "aiImages.used");
    assertEq(body.aiImages.limit, 800, "aiImages.limit (account snapshot)");
    assertEq(body.aiTextGenerations.used, 7, "aiTextGenerations.used");
    assertEq(body.aiTextGenerations.limit, 2000, "aiTextGenerations.limit");
    assertEq(body.scheduledPosts.used, 3, "scheduledPosts.used");
    assertEq(body.scheduledPosts.limit, 300, "scheduledPosts.limit");

    assertEq(calls.filteredUserId, "user-1", "must scope the query to the authenticated user");
    assertEq(calls.rpc, 0, "a GET must never create/roll an account");
  });

  await test("reserved counters are never read (settled usage only)", async () => {
    resetCalls();
    currentPlan = "pro";
    accountError = null;
    accountRow = {
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-08-01T00:00:00.000Z",
      ai_images_used: 5,
      ai_images_limit: 800,
      ai_text_generations_used: 0,
      ai_text_generations_limit: 2000,
      scheduled_posts_used: 0,
      scheduled_posts_limit: 300,
      bonus_images_balance: 0,
      // Present in the real table; must not influence the response.
      ai_images_reserved: 99,
    };
    const res = await GET(request(VALID_BEARER));
    const body = await res.json();
    assertEq(body.aiImages.used, 5, "used must be the settled counter, not settled+reserved");
    assert(
      !calls.selectedColumns.includes("reserved"),
      `the query must not even select reserved columns (got: ${calls.selectedColumns})`,
    );
  });

  await test("an account snapshot limit WINS over the current plan config", async () => {
    // The user is on Free today, but their account row was snapshotted while on
    // Pro. The enforced cap is the snapshot — the API must report it, not the
    // plan's current 10.
    resetCalls();
    currentPlan = "free";
    accountError = null;
    accountRow = {
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-08-01T00:00:00.000Z",
      ai_images_used: 120,
      ai_images_limit: 800,
      ai_text_generations_used: 0,
      ai_text_generations_limit: null,
      scheduled_posts_used: 0,
      scheduled_posts_limit: null,
      bonus_images_balance: 0,
    };
    const res = await GET(request(VALID_BEARER));
    const body = await res.json();
    assertEq(body.aiImages.limit, 800, "limit must come from the account snapshot");
    assertEq(body.aiImages.included, PLAN_ENTITLEMENTS.free.monthlyAiImages, "included still reflects the plan");
    assertEq(body.scheduledPosts.limit, null, "a null snapshot limit means unlimited, passed through");
  });

  // ── 3) Authenticated with NO usage_accounts row ───────────────────────────────

  await test("authed user with NO row → honest unmetered shape + plan allowances", async () => {
    resetCalls();
    currentPlan = "starter";
    accountError = null;
    accountRow = null;

    const res = await GET(request(VALID_BEARER));
    assertEq(res.status, 200, "status");
    const body = await res.json();

    assertEq(body.plan, "starter", "plan");
    assertEq(body.metered, false, "metered must be false when no account exists");
    assertEq(body.periodStart, null, "no real period exists yet");
    assertEq(body.periodEnd, null, "no real period exists yet");
    assertEq(body.bonusImages, null, "no bonus balance is known");

    // The crux: usage is null (not measured), NOT 0 (measured as zero).
    assertEq(body.aiImages.used, null, "aiImages.used must be null, never a fabricated 0");
    assertEq(body.aiTextGenerations.used, null, "aiTextGenerations.used must be null");
    assertEq(body.scheduledPosts.used, null, "scheduledPosts.used must be null");
    assertEq(body.aiImages.limit, null, "no enforced limit exists without an account");

    // ...but the plan's included allowances ARE reported, from the canonical config.
    assertEq(body.aiImages.included, PLAN_ENTITLEMENTS.starter.monthlyAiImages, "included AI images");
    assertEq(body.aiTextGenerations.included, PLAN_ENTITLEMENTS.starter.monthlyAiTextGenerations, "included AI text");
    assertEq(body.scheduledPosts.included, PLAN_ENTITLEMENTS.starter.monthlyScheduledPosts, "included scheduled posts");
  });

  await test("a GET never creates a usage account (no ensureUsageAccount RPC)", async () => {
    resetCalls();
    currentPlan = "free";
    accountError = null;
    accountRow = null;
    await GET(request(VALID_BEARER));
    assertEq(calls.rpc, 0, "a read endpoint must not create billing state as a side effect");
  });

  await test("unlimited allowances pass through as null (Business scheduled posts)", async () => {
    resetCalls();
    currentPlan = "business";
    accountError = null;
    accountRow = null;
    const res = await GET(request(VALID_BEARER));
    const body = await res.json();
    assertEq(body.scheduledPosts.included, null, "Business scheduled posts are unlimited → null");
    assertEq(PLAN_ENTITLEMENTS.business.monthlyScheduledPosts, null, "config sanity check");
  });

  // ── 4) Failure posture ────────────────────────────────────────────────────────

  await test("a database error → 500, never a silent Free/zero downgrade", async () => {
    resetCalls();
    currentPlan = "pro";
    accountRow = null;
    accountError = { message: "connection reset" };
    const res = await GET(request(VALID_BEARER));
    assertEq(res.status, 500, "status");
    const body = await res.json();
    assertEq(body.error, "usage_unavailable", "error code drives the UI sync-error state");
    assert(body.plan === undefined, "a failed read must not report a plan at all");
    accountError = null;
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
