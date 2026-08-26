/**
 * Admin authorization SECURITY tests (admin trust-boundary P0).
 * Run: npx tsx scripts/test-admin-auth-security.ts
 *
 * THE BUG THESE TESTS EXIST TO CATCH
 * ----------------------------------
 * `user_metadata` is USER-WRITABLE: any signed-in user can run
 *   supabase.auth.updateUser({ data: { role: "super_admin" } })
 * from the browser console. `app_metadata` is NOT — only the service role /
 * Supabase admin API can write it.
 *
 * The admin gate used to trust BOTH. Browser-reproduced on an isolated test DB
 * with a no-bypass server: a user with EMPTY app_metadata who set only
 * user_metadata.role="super_admin" fully entered /admin/today (saw the customer
 * list with real emails) and GET /api/admin/me returned {"isSuperAdmin":true}.
 * A forged user_metadata.role="support" reached /admin/generation-logs and read
 * 9 other users' generation logs. The same fallback in generationDebugAccess.ts
 * exposed the full internal prompt.
 *
 * These tests pin the trust boundary itself:
 *   • forged user_metadata roles are INERT (super_admin, support, and the
 *     generation-debug internal roles),
 *   • genuine app_metadata roles and the email allowlists still work,
 *   • neither no-auth bypass (ENABLE_LOCAL_ADMIN_BYPASS, E2E_TEST_MODE) can
 *     activate when NODE_ENV === "production",
 *   • the predeploy guard refuses to ship either bypass flag.
 *
 * Pure functions + fake env only — no DB, no network, no Next request scope.
 */

// Env must be set BEFORE the server module loads (superAdmin.ts constructs a
// Supabase client from env at import time).
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

export {};

import { Module } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// process.env.NODE_ENV is typed read-only; these helpers let the security tests
// simulate a production build without weakening the type elsewhere.
const envBag = process.env as Record<string, string | undefined>;
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete envBag[key];
  else envBag[key] = value;
}


// `next/headers` throws outside a Next request scope. Stub it with an EMPTY
// cookie/header store so the request-level gates below can be driven directly:
// with no credentials the only way a caller becomes an admin is a bypass, which
// is exactly what we want to observe. (Same Module._load idiom as
// test-ai-provider-auth-boundary.ts.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
      headers: async () => new Headers(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

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

/** Run `fn` with env vars temporarily overridden, then restore exactly. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Minimal auth-user shapes. `as never` keeps the fixtures readable without
// dragging in the full Supabase User type (only these fields are ever read).
type Meta = Record<string, unknown>;
function user(opts: { email?: string | null; app?: Meta; usr?: Meta }) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: opts.email ?? null,
    app_metadata: opts.app ?? {},
    user_metadata: opts.usr ?? {},
  } as never;
}

async function main() {
  const sa = await import("../src/lib/server/superAdmin");
  const gda = await import("../src/lib/generationDebugAccess");

  console.log("\nAdmin authorization security tests\n");

  // ── 1. Forged user_metadata roles are inert ────────────────────────────────
  // The exploit exactly as reproduced in the browser: empty app_metadata, a
  // self-written user_metadata.role, and an email on no allowlist.
  await test("forged user_metadata.role=super_admin → isSuperAdminUser false", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const attacker = user({ email: "attacker@example.com", app: {}, usr: { role: "super_admin" } });
      assertEq(sa.isSuperAdminUser(attacker), false, "user_metadata must never grant super_admin");
    });
  });

  await test("forged user_metadata.role=super_admin → adminRoleOf null", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const attacker = user({ email: "attacker@example.com", app: {}, usr: { role: "super_admin" } });
      assertEq(sa.adminRoleOf(attacker), null, "no admin role from user_metadata");
    });
  });

  await test("forged user_metadata.role=support → adminRoleOf null", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const attacker = user({ email: "attacker@example.com", app: {}, usr: { role: "support" } });
      assertEq(sa.adminRoleOf(attacker), null, "user_metadata must never grant support either");
    });
  });

  await test("forged user_metadata.role wins nothing even alongside a non-admin app_metadata.role", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const attacker = user({
        email: "attacker@example.com",
        app: { role: "user" },
        usr: { role: "super_admin" },
      });
      assertEq(sa.isSuperAdminUser(attacker), false, "app_metadata.role=user is the truth");
      assertEq(sa.adminRoleOf(attacker), null, "no escalation via user_metadata");
    });
  });

  await test("null / empty users are denied", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      assertEq(sa.isSuperAdminUser(null), false, "null user denied");
      assertEq(sa.adminRoleOf(null), null, "null user has no role");
      assertEq(sa.isSuperAdminUser(user({ email: "nobody@example.com" })), false, "plain user denied");
      assertEq(sa.adminRoleOf(user({ email: "nobody@example.com" })), null, "plain user has no role");
    });
  });

  // ── 2. Genuine app_metadata roles still work ───────────────────────────────
  await test("genuine app_metadata.role=super_admin → true / \"super_admin\"", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const admin = user({ email: "staff@example.com", app: { role: "super_admin" } });
      assertEq(sa.isSuperAdminUser(admin), true, "app_metadata grants super_admin");
      assertEq(sa.adminRoleOf(admin), "super_admin", "role resolves to super_admin");
    });
  });

  await test("genuine app_metadata.role=support → \"support\" (not super_admin)", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const support = user({ email: "support@example.com", app: { role: "support" } });
      assertEq(sa.isSuperAdminUser(support), false, "support is not a super admin");
      assertEq(sa.adminRoleOf(support), "support", "role resolves to support");
    });
  });

  await test("non-string app_metadata.role (object) grants nothing", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const weird = user({ email: "weird@example.com", app: { role: { role: "super_admin" } } });
      assertEq(sa.isSuperAdminUser(weird), false, "object role is not a string role");
      assertEq(sa.adminRoleOf(weird), null, "object role grants nothing");
    });
  });

  // ── 3. Email allowlists still work ─────────────────────────────────────────
  await test("SUPER_ADMIN_EMAILS allowlist still grants super_admin", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "boss@example.com, other@example.com", SUPPORT_ADMIN_EMAILS: "" }, () => {
      const boss = user({ email: "boss@example.com" });
      assertEq(sa.isSuperAdminUser(boss), true, "allowlisted email is super admin");
      assertEq(sa.adminRoleOf(boss), "super_admin", "allowlist → super_admin role");
      // Case-insensitive, and a non-listed email stays out.
      assertEq(sa.isSuperAdminUser(user({ email: "BOSS@Example.com" })), true, "case-insensitive match");
      assertEq(sa.isSuperAdminUser(user({ email: "notboss@example.com" })), false, "unlisted email denied");
    });
  });

  await test("SUPPORT_ADMIN_EMAILS allowlist still grants support", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "helpdesk@example.com" }, () => {
      const helper = user({ email: "helpdesk@example.com" });
      assertEq(sa.isSuperAdminUser(helper), false, "support allowlist is not super admin");
      assertEq(sa.adminRoleOf(helper), "support", "support allowlist → support role");
      assertEq(sa.adminRoleOf(user({ email: "stranger@example.com" })), null, "unlisted email denied");
    });
  });

  await test("a forged user_metadata role cannot upgrade a support allowlist user", () => {
    withEnv({ SUPER_ADMIN_EMAILS: "", SUPPORT_ADMIN_EMAILS: "helpdesk@example.com" }, () => {
      const helper = user({ email: "helpdesk@example.com", usr: { role: "super_admin" } });
      assertEq(sa.isSuperAdminUser(helper), false, "no self-upgrade to super_admin");
      assertEq(sa.adminRoleOf(helper), "support", "stays support");
    });
  });

  // ── 4. generationDebugAccess (full internal prompt exposure) ───────────────
  await test("generationDebug: forged user_metadata internal role denied", () => {
    for (const role of ["admin", "internal_tester", "developer"]) {
      assertEq(
        gda.canViewGenerationDebug({ app_metadata: {}, user_metadata: { role } }, true),
        false,
        `forged user_metadata.role=${role} must not unlock the internal prompt`,
      );
    }
  });

  await test("generationDebug: genuine app_metadata internal role allowed", () => {
    for (const role of ["admin", "internal_tester", "developer"]) {
      assertEq(
        gda.canViewGenerationDebug({ app_metadata: { role }, user_metadata: {} }, true),
        true,
        `app_metadata.role=${role} is a genuine internal role`,
      );
    }
  });

  await test("generationDebug: env flag off denies even a genuine internal role", () => {
    assertEq(
      gda.canViewGenerationDebug({ app_metadata: { role: "admin" } }, false),
      false,
      "the env flag is still an independent gate",
    );
    assertEq(gda.canViewGenerationDebug(null, true), false, "anonymous denied");
    assertEq(
      gda.canViewGenerationDebug({ app_metadata: { role: "user" } }, true),
      false,
      "a normal app_metadata role is not internal",
    );
  });

  // ── 5. Both no-auth bypasses are INERT in production ───────────────────────
  // Runtime half. localAdminBypassEnabled is module-private, so it is exercised
  // through its only observable effect: the exported e2eTestModeEnabled mirrors
  // the same double gate, and the predeploy guard (below) covers the deploy half.
  await test("E2E_TEST_MODE is inert when NODE_ENV=production", () => {
    withEnv({ NODE_ENV: "production", E2E_TEST_MODE: "true" }, () => {
      assertEq(sa.e2eTestModeEnabled(), false, "E2E bypass must never activate in production");
    });
  });

  await test("E2E_TEST_MODE is active only outside production and only when \"true\"", () => {
    withEnv({ NODE_ENV: "development", E2E_TEST_MODE: "true" }, () => {
      assertEq(sa.e2eTestModeEnabled(), true, "active in development");
    });
    withEnv({ NODE_ENV: "test", E2E_TEST_MODE: "true" }, () => {
      assertEq(sa.e2eTestModeEnabled(), true, "active in test");
    });
    withEnv({ NODE_ENV: "development", E2E_TEST_MODE: "false" }, () => {
      assertEq(sa.e2eTestModeEnabled(), false, "explicit false is off");
    });
    withEnv({ NODE_ENV: "development", E2E_TEST_MODE: undefined }, () => {
      assertEq(sa.e2eTestModeEnabled(), false, "unset is off");
    });
  });

  await test("the E2E header bypass cannot mint a super admin in production", async () => {
    // Drive the real request-level gate. In production the bypass must fall
    // through to the cookie/bearer path, which has no credentials here → null.
    const request = new Request("https://vibepin.co/api/admin/me", {
      headers: { "x-e2e-super-admin": "true" },
    });
    const previous = { NODE_ENV: process.env.NODE_ENV, E2E: process.env.E2E_TEST_MODE };
    try {
      setEnv("NODE_ENV", "production");
      setEnv("E2E_TEST_MODE", "true");
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", "true"); // the other bypass must also stay inert
      assertEq(
        await sa.requireSuperAdminFromRequest(request),
        null,
        "no super-admin session from a forged header in production",
      );
      assertEq(
        await sa.requireAdminRoleFromRequest(request),
        null,
        "no admin role from a forged header in production",
      );
    } finally {
      if (previous.NODE_ENV === undefined) setEnv("NODE_ENV", undefined);
      else setEnv("NODE_ENV", previous.NODE_ENV);
      if (previous.E2E === undefined) setEnv("E2E_TEST_MODE", undefined);
      else setEnv("E2E_TEST_MODE", previous.E2E);
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", undefined);
    }
  });

  await test("ENABLE_LOCAL_ADMIN_BYPASS alone cannot mint a super admin in production", async () => {
    const request = new Request("https://vibepin.co/api/admin/me");
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      setEnv("NODE_ENV", "production");
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", "true");
      assertEq(
        await sa.requireSuperAdminFromRequest(request),
        null,
        "local admin bypass must never activate in production",
      );
      assertEq(
        await sa.requireAdminRoleFromRequest(request),
        null,
        "local admin bypass grants no admin role in production",
      );
    } finally {
      if (previousNodeEnv === undefined) setEnv("NODE_ENV", undefined);
      else setEnv("NODE_ENV", previousNodeEnv);
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", undefined);
    }
  });

  await test("the server-component gates are also inert in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      setEnv("NODE_ENV", "production");
      setEnv("E2E_TEST_MODE", "true");
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", "true");
      assertEq(await sa.getCurrentSuperAdmin(), null, "getCurrentSuperAdmin denies in production");
      assertEq(await sa.getCurrentAdminRole(), null, "getCurrentAdminRole denies in production");
    } finally {
      if (previousNodeEnv === undefined) setEnv("NODE_ENV", undefined);
      else setEnv("NODE_ENV", previousNodeEnv);
      setEnv("E2E_TEST_MODE", undefined);
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", undefined);
    }
  });

  await test("control: outside production the bypasses DO still work (gate, not breakage)", async () => {
    // Without this the production assertions above would also pass if the
    // bypasses were simply broken everywhere.
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      setEnv("NODE_ENV", "development");
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", "true");
      const local = await sa.requireSuperAdminFromRequest(new Request("https://localhost/api/admin/me"));
      assert(local, "local admin bypass still works in development");
      assertEq(local?.email, "local-dev-admin@localhost", "it is the local dev admin");

      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", undefined);
      setEnv("E2E_TEST_MODE", "true");
      const e2e = await sa.requireAdminRoleFromRequest(
        new Request("https://localhost/api/admin/me", { headers: { "x-e2e-support-admin": "true" } }),
      );
      assertEq(e2e?.role, "support", "E2E support header still works in development");
    } finally {
      if (previousNodeEnv === undefined) setEnv("NODE_ENV", undefined);
      else setEnv("NODE_ENV", previousNodeEnv);
      setEnv("E2E_TEST_MODE", undefined);
      setEnv("ENABLE_LOCAL_ADMIN_BYPASS", undefined);
    }
  });

  // ── 6. Deploy half: the predeploy guard refuses to ship either bypass ──────
  const guard = (await import("./predeploy-guard.mjs")) as unknown as {
    checkAuthBypassesForProd: (env: Record<string, string | undefined>) => string[];
  };

  await test("predeploy guard exports the pure auth-bypass check", () => {
    assert(typeof guard.checkAuthBypassesForProd === "function", "checkAuthBypassesForProd exported");
  });

  await test("predeploy guard: E2E_TEST_MODE set → deploy refused", () => {
    const problems = guard.checkAuthBypassesForProd({ E2E_TEST_MODE: "true" });
    assertEq(problems.length, 1, "one problem");
    assert(/E2E_TEST_MODE/.test(problems[0]), "message names E2E_TEST_MODE");
  });

  await test("predeploy guard: ENABLE_LOCAL_ADMIN_BYPASS set → deploy refused", () => {
    const problems = guard.checkAuthBypassesForProd({ ENABLE_LOCAL_ADMIN_BYPASS: "true" });
    assertEq(problems.length, 1, "one problem");
    assert(/ENABLE_LOCAL_ADMIN_BYPASS/.test(problems[0]), "message names ENABLE_LOCAL_ADMIN_BYPASS");
    assert(/no-auth/.test(problems[0]), "message explains it is a no-auth bypass");
  });

  await test("predeploy guard: both bypasses set → both reported", () => {
    assertEq(
      guard.checkAuthBypassesForProd({ E2E_TEST_MODE: "1", ENABLE_LOCAL_ADMIN_BYPASS: "yes" }).length,
      2,
      "both flagged",
    );
  });

  await test("predeploy guard: falsey / unset bypass values are clean", () => {
    assertEq(guard.checkAuthBypassesForProd({}).length, 0, "empty env clean");
    assertEq(
      guard.checkAuthBypassesForProd({ E2E_TEST_MODE: "false", ENABLE_LOCAL_ADMIN_BYPASS: "false" }).length,
      0,
      '"false" is not truthy',
    );
    assertEq(
      guard.checkAuthBypassesForProd({ E2E_TEST_MODE: "0", ENABLE_LOCAL_ADMIN_BYPASS: "" }).length,
      0,
      '"0" and "" are not truthy',
    );
  });

  await test("/app?admin=forbidden is a terminal, visible denial state", () => {
    const appRoot = readFileSync(join(process.cwd(), "src/app/app/page.tsx"), "utf8");
    const notice = readFileSync(join(process.cwd(), "src/components/app/AdminForbiddenNotice.tsx"), "utf8");
    assert(/admin\s*===\s*["']forbidden["']/.test(appRoot), "app root must recognize the admin denial flag");
    assert(/<AdminForbiddenNotice\s*\/>/.test(appRoot), "denied users must see a terminal notice, not a second redirect");
    assert(/role=["']alert["']/.test(notice), "denial feedback must be exposed as an accessible alert");
    assert(/href=["']\/app\/studio["']/.test(notice), "notice must offer a safe return to the app");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Module as any)._load = originalLoad;
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
