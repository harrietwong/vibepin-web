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
  const { resolvePlan, highestPlanFromGrants } = await import(
    "../src/lib/server/entitlements"
  );

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

  // ── Fix 4: recompute the highest plan from ALL subscriptions ──────────────────
  // refreshUserPlanCache and resolvePlan share highestPlanFromGrants, so the cache
  // can never disagree with resolvePlan. Test the shared ranking directly, then
  // prove resolvePlan uses it, so both are provably the same answer.
  const rank = (subs: Array<{ plan: unknown; lastEventAt: string | null }>) =>
    highestPlanFromGrants(subs);

  await test("highestPlanFromGrants: two active subs (pro + business) → business", () => {
    assertEq(
      rank([
        { plan: "pro", lastEventAt: "2026-07-16T00:00:00.000Z" },
        { plan: "business", lastEventAt: "2026-07-10T00:00:00.000Z" },
      ]),
      "business",
      "highest wins regardless of which is newer",
    );
  });

  await test("highestPlanFromGrants: canceling pro leaves business → business (not free)", () => {
    // After pro's canceled event, only business remains in the granting set.
    assertEq(rank([{ plan: "business", lastEventAt: "2026-07-16T00:00:00.000Z" }]), "business", "keeps business");
  });

  await test("highestPlanFromGrants: canceling the only sub → free", () => {
    assertEq(rank([]), "free", "no grants → free");
  });

  await test("highestPlanFromGrants: unknown plan strings are ignored", () => {
    assertEq(rank([{ plan: "enterprise", lastEventAt: null }]), "free", "unknown → free");
    assertEq(
      rank([
        { plan: "enterprise", lastEventAt: null },
        { plan: "starter", lastEventAt: null },
      ]),
      "starter",
      "valid plan still counts",
    );
  });

  await test("resolvePlan reuses the SAME ranking (two active subs → highest)", async () => {
    // Proves cache (refreshUserPlanCache → highestPlanFromGrants) equals resolvePlan.
    const plan = await resolvePlan("user_1", {
      getUserById: async () => ({ email: null, appPlan: undefined }),
      getActiveSubscriptions: async () => [
        { plan: "pro", lastEventAt: "2026-07-16T00:00:00.000Z" },
        { plan: "business", lastEventAt: "2026-07-01T00:00:00.000Z" },
      ],
    });
    assertEq(plan, "business", "resolvePlan also returns the highest (business)");
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

  // == ANNUAL SUBSCRIPTION -> MONTHLY USAGE PERIOD (裁决 #2 / PRD v3.2 §9.1) ======
  // The webhook hands ensureUsageAccount the subscription current_period_start/end
  // verbatim. For an ANNUAL plan those are TWELVE months apart, but the product rule is
  // that annual subscribers get the same MONTHLY allowances, reset MONTHLY, anchored on
  // the subscription start - billing stays annual. So the account the webhook builds
  // must carry a ONE-MONTH usage period, with the anchor at the subscription start so
  // the v56 RPC rolls it monthly from there (including across the year-2 renewal, whose
  // start lands on the same monthly lattice).
  //
  // ensureUsageAccount is driven with an injected `rpc` that CAPTURES the arguments,
  // so this asserts the exact payload usage_ensure_account would receive - no DB, and
  // no resolvePlan network call (plan is injected too).

  await test("ANNUAL subscription event builds an account whose period is ONE MONTH, not one year", async () => {
    const { ensureUsageAccount } = await import("../src/lib/server/usage/ensureAccount");

    const periodStart = "2026-08-28T09:40:00.000Z"; // subscription start
    const periodEnd = "2027-08-28T09:40:00.000Z"; // +12 months - annual billing

    let captured: Record<string, unknown> | null = null;
    const outcome = await ensureUsageAccount("user_1", {
      plan: "pro",
      hint: { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      now: new Date("2026-09-05T00:00:00.000Z"), // 8 days into the subscription
      rpc: async (fn, args) => {
        assertEq(fn, "usage_ensure_account", "calls the v56 lifecycle RPC");
        captured = args;
        return {
          data: {
            ok: true,
            action: "created",
            account_id: "acc_1",
            plan_key: "pro",
            period_start: args.p_period_start,
            period_end: args.p_period_end,
            version: 0,
            rolled_periods: 0,
          },
          error: null,
        };
      },
    });

    if (!captured) throw new Error("rpc was never called");
    const args = captured as Record<string, unknown>;

    assertEq(args.p_period_start, "2026-08-28T09:40:00.000Z", "period_start = subscription start");
    assertEq(args.p_period_end, "2026-09-28T09:40:00.000Z", "period_end = start + 1 MONTH");
    assertEq(args.p_period_anchor, periodStart, "anchor = subscription start (RPC rolls monthly from it)");

    // The load-bearing assertion, stated as the design does: one month, not one year.
    const widthDays =
      (new Date(String(args.p_period_end)).getTime() -
        new Date(String(args.p_period_start)).getTime()) /
      86_400_000;
    if (widthDays < 28 || widthDays > 31) {
      throw new Error(`usage period is ${widthDays} days wide - expected a month, not a year`);
    }
    if (String(args.p_period_end) === periodEnd) {
      throw new Error("usage period_end equals the ANNUAL subscription end - allowances would reset yearly");
    }

    assertEq(outcome.periodEnd, "2026-09-28T09:40:00.000Z", "the returned period is the monthly one");
  });

  await test("MONTHLY subscription event is unchanged: the hint window is passed through as-is", async () => {
    // Regression guard for the same code path: a monthly hint window already IS
    // anchor + 1 month, so the sub-window derivation must reproduce it exactly.
    const { ensureUsageAccount } = await import("../src/lib/server/usage/ensureAccount");

    const periodStart = "2026-08-28T09:40:00.000Z";
    const periodEnd = "2026-09-28T09:40:00.000Z";

    let captured: Record<string, unknown> | null = null;
    await ensureUsageAccount("user_1", {
      plan: "pro",
      hint: { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      now: new Date("2026-09-05T00:00:00.000Z"),
      rpc: async (_fn, args) => {
        captured = args;
        return { data: { ok: true, action: "created", account_id: "acc_1", plan_key: "pro", version: 0, rolled_periods: 0 }, error: null };
      },
    });

    if (!captured) throw new Error("rpc was never called");
    const args = captured as Record<string, unknown>;
    assertEq(args.p_period_start, periodStart, "monthly period_start verbatim");
    assertEq(args.p_period_end, periodEnd, "monthly period_end verbatim");
    assertEq(args.p_period_anchor, periodStart, "monthly anchor verbatim");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
