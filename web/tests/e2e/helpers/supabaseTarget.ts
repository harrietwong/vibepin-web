/**
 * The one place E2E specs learn which Supabase origin to intercept.
 *
 * Two failure modes this centralises away from every spec:
 *
 *  1. A hardcoded PRODUCTION url as the route pattern. Eight specs did this. It is
 *     both a safety problem (a non-GET that the mock does not catch would escape to
 *     production) and a correctness problem (if the app is built against the test DB,
 *     the production-keyed pattern never matches and the "mock" silently no-ops while
 *     real requests hit the test DB).
 *
 *  2. Silently defaulting to production when the env is unset.
 *
 * Rule (.claude/CLAUDE.md "测试环境隔离"): production (jaxteelkecvlozdrdoog) is never a
 * write target for the browser suite. globalSetup enforces this for the whole run;
 * this module enforces it per-import and gives specs a single guarded value.
 */
const PRODUCTION_SUPABASE_REF = "jaxteelkecvlozdrdoog";

/**
 * A syntactically-valid, obviously-not-real origin used ONLY as a route-interception
 * pattern by fully-mocked specs that set no env. It must never be a real project ref.
 */
export const MOCK_SUPABASE_URL = "https://e2e-mock.supabase.co";

/**
 * Resolve the origin to intercept.
 *  - env set & not production → use it (real target, e.g. the isolated test project);
 *  - env set & production     → throw (isolation violation);
 *  - env unset & allowMock    → the mock placeholder (pure-interception specs);
 *  - env unset & !allowMock    → throw (a spec that truly needs a real target).
 */
export function resolveSupabaseTarget(opts: { allowMock?: boolean } = {}): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (raw) {
    const url = raw.replace(/\/$/, "");
    if (url.includes(PRODUCTION_SUPABASE_REF)) {
      throw new Error(
        `E2E: refusing to target the PRODUCTION Supabase project (${PRODUCTION_SUPABASE_REF}). ` +
          "This suite can issue writes; use the isolated TEST project (web/.env.test.local).",
      );
    }
    return url;
  }
  if (opts.allowMock) return MOCK_SUPABASE_URL;
  throw new Error(
    "E2E: NEXT_PUBLIC_SUPABASE_URL is not set. Point it at the TEST Supabase project " +
      "(web/.env.test.local) before running this spec — there is no production default.",
  );
}

/**
 * Route handler helper: a catch-all for Supabase REST that answers GETs with a body
 * and ABORTS every mutation. Aborting (not continue()) guarantees an unmocked write
 * can never escape to any real origin — the escape hatch Codex flagged.
 */
export async function fulfillGetAbortWrite(
  route: import("@playwright/test").Route,
  getBody: string,
): Promise<void> {
  if (route.request().method() === "GET") {
    await route.fulfill({ status: 200, contentType: "application/json", body: getBody });
  } else {
    await route.abort();
  }
}
