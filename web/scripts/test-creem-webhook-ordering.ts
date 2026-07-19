/**
 * Creem webhook ordering / atomicity tests (WP-Billing P0, Commit 3).
 * Run: npx tsx scripts/test-creem-webhook-ordering.ts
 *
 * Drives upsertCreemSubscription against an in-memory fake Supabase client (the
 * injectable `db` param) — no live DB. Proves the atomic out-of-order guard:
 *   - new-active then old-canceled keeps the plan (stale revoke skipped),
 *   - new-canceled then old-active stays free (stale grant skipped),
 *   - duplicate/equal-timestamp events (lte → applied) documented,
 *   - user_id backfill is monotonic (never null-ed by a later event),
 *   - and the route-level "unknown product → never grant" + "missing userId
 *     defers without throwing" behaviors.
 *
 * The fake reproduces the PostgREST builder surface upsertCreemSubscription uses:
 *   from(t).select(c).eq(k,v).maybeSingle()
 *   from(t).upsert(row,{onConflict,ignoreDuplicates}).select(c)
 *   from(t).update(patch).eq(k,v)[.or(expr)|.is(k,null)].select(c)?
 */

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
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── In-memory fake of the PostgREST builder for creem_subscriptions ─────────────

type Row = Record<string, unknown> & { creem_subscription_id: string; last_event_at: string | null };

function makeFakeDb(store: Map<string, Row>) {
  // Parse the `.or("last_event_at.is.null,last_event_at.lte.<iso>")` staleness
  // filter into a predicate over an existing row.
  function parseStaleness(expr: string, occurredAt: string): (r: Row) => boolean {
    // We only ever emit exactly this shape from the store.
    if (expr.includes("last_event_at.is.null") && expr.includes("last_event_at.lte.")) {
      return (r: Row) =>
        r.last_event_at == null ||
        new Date(r.last_event_at).getTime() <= new Date(occurredAt).getTime();
    }
    throw new Error(`fake db: unsupported .or() expr: ${expr}`);
  }

  function from(table: string) {
    if (table !== "creem_subscriptions") {
      throw new Error(`fake db: unexpected table ${table}`);
    }
    return {
      select(_cols: string) {
        return {
          eq(_k: string, id: string) {
            return {
              async maybeSingle() {
                const r = store.get(id) ?? null;
                return { data: r, error: null };
              },
            };
          },
        };
      },
      upsert(row: Row, opts: { onConflict: string; ignoreDuplicates?: boolean }) {
        const id = row.creem_subscription_id;
        const conflicted = store.has(id);
        if (!conflicted) store.set(id, { ...row });
        // ignoreDuplicates: DO NOTHING on conflict → return [] when it existed.
        const inserted = conflicted && opts.ignoreDuplicates ? [] : conflicted ? [] : [{ creem_subscription_id: id }];
        return {
          select(_cols: string) {
            return Promise.resolve({ data: inserted, error: null });
          },
        };
      },
      update(patch: Partial<Row>) {
        return {
          eq(_k: string, id: string) {
            // Two terminal shapes: `.or(expr).select()` (conditional CAS) and
            // `.is("user_id", null)` (backfill, no select).
            const applyIf = (pred: (r: Row) => boolean, withSelect: boolean) => {
              const existing = store.get(id);
              const affected: Array<{ creem_subscription_id: string }> = [];
              if (existing && pred(existing)) {
                store.set(id, { ...existing, ...patch });
                affected.push({ creem_subscription_id: id });
              }
              return withSelect
                ? { data: affected, error: null }
                : { data: null, error: null };
            };
            return {
              or(expr: string) {
                const occurredAt = String((patch as Row).last_event_at ?? "");
                const pred = parseStaleness(expr, occurredAt);
                return {
                  select(_cols: string) {
                    return Promise.resolve(applyIf(pred, true));
                  },
                };
              },
              is(_col: string, _val: null) {
                // Backfill only when user_id currently null.
                return Promise.resolve(
                  applyIf((r) => r.user_id == null, false),
                );
              },
            };
          },
        };
      },
    };
  }

  return { from } as unknown as import("../src/lib/server/creem/creemStore").CreemDbClient;
}

function baseInput(over: Partial<Record<string, unknown>>) {
  return {
    subscriptionId: "sub_1",
    customerId: "cus_1",
    userId: "user_1",
    status: "active",
    productId: "prod_pro_m",
    plan: "pro" as const,
    billingInterval: "month" as const,
    currentPeriodEnd: null,
    scheduledCancel: false,
    occurredAt: "2026-07-10T00:00:00.000Z",
    ...over,
  };
}

async function main() {
  const { upsertCreemSubscription, creemStatusGrantsAccess } = await import(
    "../src/lib/server/creem/creemStore"
  );
  const { resolvePlan } = await import("../src/lib/server/entitlements");

  console.log("\nCreem webhook ordering tests\n");

  // ── Fix 2: subscription.trialing grants access ────────────────────────────────
  await test("trialing status grants access (creemStatusGrantsAccess)", () => {
    assertEq(creemStatusGrantsAccess("trialing"), true, "trialing grants");
  });

  await test("a trialing event mirrors with status=trialing and is applied", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    const outcome = await upsertCreemSubscription(
      baseInput({ status: "trialing", plan: "pro" }),
      db,
    );
    assertEq(outcome, "applied", "trialing mirror applied");
    assertEq(store.get("sub_1")?.status, "trialing", "row stored trialing");
  });

  await test("resolvePlan grants the plan for a trialing subscription", async () => {
    const plan = await resolvePlan("user_1", {
      getUserById: async () => ({ email: null, appPlan: undefined }),
      // A trialing sub is in the access-granting set, so resolvePlan reads its plan.
      getActiveSubscriptions: async () => [
        { plan: "pro", lastEventAt: "2026-07-16T00:00:00.000Z" },
      ],
    });
    assertEq(plan, "pro", "trialing sub → pro");
  });

  await test("first event inserts and is applied", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    const outcome = await upsertCreemSubscription(baseInput({}), db);
    assertEq(outcome, "applied", "first insert applied");
    assertEq(store.get("sub_1")?.status, "active", "row stored active");
  });

  await test("new-active THEN old-canceled: stale revoke is skipped, plan kept", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    // Newer active event lands first.
    const a = await upsertCreemSubscription(
      baseInput({ status: "active", occurredAt: "2026-07-16T00:00:00.000Z" }),
      db,
    );
    assertEq(a, "applied", "active applied");
    // Older canceled event replays afterwards.
    const b = await upsertCreemSubscription(
      baseInput({ status: "canceled", plan: "pro", occurredAt: "2026-07-10T00:00:00.000Z" }),
      db,
    );
    assertEq(b, "stale", "old canceled is stale");
    assertEq(store.get("sub_1")?.status, "active", "row still active (not demoted)");
  });

  await test("new-canceled THEN old-active: stale grant is skipped, stays canceled", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    const a = await upsertCreemSubscription(
      baseInput({ status: "canceled", occurredAt: "2026-07-16T00:00:00.000Z" }),
      db,
    );
    assertEq(a, "applied", "canceled applied");
    const b = await upsertCreemSubscription(
      baseInput({ status: "active", occurredAt: "2026-07-10T00:00:00.000Z" }),
      db,
    );
    assertEq(b, "stale", "old active is stale");
    assertEq(store.get("sub_1")?.status, "canceled", "row stays canceled");
  });

  await test("duplicate event id (same timestamp) is applied (lte → applied), idempotent", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    const a = await upsertCreemSubscription(baseInput({ occurredAt: "2026-07-10T00:00:00.000Z" }), db);
    assertEq(a, "applied", "first applied");
    // Same event delivered again (identical occurredAt). lte is inclusive so the
    // CAS matches and re-applies the identical snapshot — a harmless no-op write.
    const b = await upsertCreemSubscription(baseInput({ occurredAt: "2026-07-10T00:00:00.000Z" }), db);
    assertEq(b, "applied", "equal-timestamp replay applied (lte inclusive)");
    assertEq(store.get("sub_1")?.status, "active", "row unchanged");
  });

  await test("equal-timestamp update wins (lte), strictly-older loses", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    await upsertCreemSubscription(baseInput({ status: "active", occurredAt: "2026-07-10T00:00:00.000Z" }), db);
    // Equal timestamp, different status → applied (documented lte behavior).
    const eq = await upsertCreemSubscription(
      baseInput({ status: "scheduled_cancel", occurredAt: "2026-07-10T00:00:00.000Z" }),
      db,
    );
    assertEq(eq, "applied", "equal timestamp → applied");
    assertEq(store.get("sub_1")?.status, "scheduled_cancel", "equal-ts event overwrote");
    // Strictly older → stale.
    const older = await upsertCreemSubscription(
      baseInput({ status: "active", occurredAt: "2026-07-09T00:00:00.000Z" }),
      db,
    );
    assertEq(older, "stale", "strictly older → stale");
  });

  await test("user_id backfill is monotonic: a later event without userId does not null it", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    // First event knows the user.
    await upsertCreemSubscription(baseInput({ userId: "user_1", occurredAt: "2026-07-10T00:00:00.000Z" }), db);
    assertEq(store.get("sub_1")?.user_id, "user_1", "user linked");
    // Newer event lacks userId — must NOT null the linkage.
    await upsertCreemSubscription(
      baseInput({ userId: null, occurredAt: "2026-07-16T00:00:00.000Z" }),
      db,
    );
    assertEq(store.get("sub_1")?.user_id, "user_1", "user_id preserved through newer event");
  });

  await test("stale event still backfills a missing user_id", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    // Newer event without a user.
    await upsertCreemSubscription(baseInput({ userId: null, occurredAt: "2026-07-16T00:00:00.000Z" }), db);
    assertEq(store.get("sub_1")?.user_id ?? null, null, "no user yet");
    // Older (stale) event that DOES know the user backfills the null linkage.
    const outcome = await upsertCreemSubscription(
      baseInput({ userId: "user_1", occurredAt: "2026-07-10T00:00:00.000Z" }),
      db,
    );
    assertEq(outcome, "stale", "older event is stale for entitlement");
    assertEq(store.get("sub_1")?.user_id, "user_1", "but user_id backfilled");
  });

  await test("unknown product (plan=null) is mirrored, never carries a grantable plan", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    const outcome = await upsertCreemSubscription(
      baseInput({ plan: null, productId: "prod_unknown", status: "active" }),
      db,
    );
    assertEq(outcome, "applied", "still applied (mirrored)");
    assertEq(store.get("sub_1")?.plan ?? null, null, "plan stored null → route never grants");
  });

  await test("missing userId defers without throwing (row stored, user_id null)", async () => {
    const store = new Map<string, Row>();
    const db = makeFakeDb(store);
    let threw = false;
    try {
      const outcome = await upsertCreemSubscription(baseInput({ userId: null }), db);
      assertEq(outcome, "applied", "applied despite no userId");
    } catch {
      threw = true;
    }
    assertEq(threw, false, "did not throw on missing userId");
    assertEq(store.get("sub_1")?.user_id ?? null, null, "user_id deferred (null)");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
