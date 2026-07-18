/**
 * Entitlements SECURITY tests (WP-Billing P0, Commit 1).
 * Run: npx tsx scripts/test-entitlements-security.ts
 *
 * Proves resolvePlan NEVER trusts user_metadata (a user can edit their own
 * user_metadata → self-grant a paid plan), and follows the hardened truth order:
 *   (a) a live active/trialing creem_subscriptions row (newest wins),
 *   (b) else app_metadata.plan (service-role cache),
 *   (c) else "free",
 *   then the PRO_EMAIL_WHITELIST floor.
 *
 * All lookups are injected via ResolvePlanDeps — no DB, no network.
 */

// Env must be set BEFORE the server modules load (supabase.ts reads env at import).
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

async function main() {
  const ent = await import("../src/lib/server/entitlements");
  type Grant = { plan: unknown; lastEventAt: string | null };

  // Build deps injecting both lookups. `appPlan` models app_metadata.plan; the
  // caller decides which subscription grants exist. A user-forged plan is
  // modeled by the ABSENCE of any equivalent app_metadata / subscription value.
  function deps(opts: {
    email?: string | null;
    appPlan?: unknown;
    subs?: Grant[];
    userMissing?: boolean;
  }) {
    return {
      getUserById: async (_userId: string) =>
        opts.userMissing
          ? null
          : { email: opts.email ?? null, appPlan: opts.appPlan },
      getActiveSubscriptions: async (_userId: string) => opts.subs ?? [],
    };
  }

  console.log("\nEntitlements security tests\n");

  // (a) The core exploit: user_metadata.plan=business is UNREACHABLE. resolvePlan
  // has no user_metadata input at all; with no app_metadata plan and no
  // subscription the answer is "free" regardless of what a user forged.
  await test("forged user_metadata.plan=business + no subs + no app_metadata → free", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "attacker@example.com", appPlan: undefined, subs: [] })),
      "free",
      "no trusted grant → free (user_metadata never consulted)",
    );
  });

  // (b) app_metadata.plan honored as the trusted cache fallback.
  await test("app_metadata.plan=pro honored as fallback when no live subscription", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "a@example.com", appPlan: "pro", subs: [] })),
      "pro",
      "app_metadata cache → pro",
    );
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "a@example.com", appPlan: "business", subs: [] })),
      "business",
      "app_metadata cache → business",
    );
  });

  // (c) A live subscription beats a stale app_metadata cache.
  await test("live active subscription beats a stale app_metadata cache", async () => {
    assertEq(
      await ent.resolvePlan(
        "u1",
        deps({
          email: "a@example.com",
          appPlan: "starter", // stale cache
          subs: [{ plan: "business", lastEventAt: "2026-07-16T00:00:00.000Z" }],
        }),
      ),
      "business",
      "live sub (business) wins over cache (starter)",
    );
  });

  // Newest grant wins when multiple active rows exist.
  await test("newest active subscription (by last_event_at) wins over an older one", async () => {
    assertEq(
      await ent.resolvePlan(
        "u1",
        deps({
          email: "a@example.com",
          subs: [
            { plan: "starter", lastEventAt: "2026-07-01T00:00:00.000Z" },
            { plan: "pro", lastEventAt: "2026-07-10T00:00:00.000Z" },
          ],
        }),
      ),
      "pro",
      "newer pro row beats older starter row",
    );
  });

  // (d) Whitelist floor at pro; a higher real plan wins; never downgrades.
  await test("whitelist floors at pro, a higher real plan still wins", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "zhihuihuang321@gmail.com", appPlan: undefined, subs: [] })),
      "pro",
      "whitelisted email with nothing else → pro",
    );
    assertEq(
      await ent.resolvePlan(
        "u1",
        deps({
          email: "zhihuihuang321@gmail.com",
          subs: [{ plan: "business", lastEventAt: "2026-07-16T00:00:00.000Z" }],
        }),
      ),
      "business",
      "whitelisted + real business sub → business (floor does not cap)",
    );
  });

  await test("whitelist does NOT affect a normal (non-whitelisted) user", async () => {
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "normal-user@example.com", appPlan: undefined, subs: [] })),
      "free",
      "normal user with no grant stays free",
    );
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "normal-user@example.com", appPlan: "starter", subs: [] })),
      "starter",
      "normal user with starter cache stays starter (not floored to pro)",
    );
  });

  // (e) Unknown plan strings → free (from both the subscription and the cache).
  await test("unknown plan strings resolve to free (subscription + cache)", async () => {
    assertEq(
      await ent.resolvePlan(
        "u1",
        deps({ email: "a@example.com", subs: [{ plan: "enterprise", lastEventAt: "2026-07-16T00:00:00.000Z" }] }),
      ),
      "free",
      "unknown sub plan → free",
    );
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "a@example.com", appPlan: "gold", subs: [] })),
      "free",
      "unknown app_metadata plan → free",
    );
    assertEq(
      await ent.resolvePlan("u1", deps({ email: "a@example.com", appPlan: { plan: "business" }, subs: [] })),
      "free",
      "non-string app_metadata plan (object) → free",
    );
  });

  // Robustness: missing user + a valid subscription still grants (billing is the
  // source of truth; the user lookup is only needed for the whitelist floor).
  await test("missing user record + valid active sub still grants the plan", async () => {
    assertEq(
      await ent.resolvePlan(
        "u1",
        deps({
          userMissing: true,
          subs: [{ plan: "pro", lastEventAt: "2026-07-16T00:00:00.000Z" }],
        }),
      ),
      "pro",
      "sub grants even when the auth user lookup returns null",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
