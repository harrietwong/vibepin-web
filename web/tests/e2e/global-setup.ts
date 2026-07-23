/**
 * Global, import-independent isolation guard for the E2E suite.
 *
 * Playwright runs this once before ANY project or spec, and it CANNOT be bypassed by a
 * spec that hardcodes its own Supabase URL. The rule (.claude/CLAUDE.md "测试环境隔离"):
 * the production project (jaxteelkecvlozdrdoog) must never be the target of a browser
 * suite that can issue writes.
 *
 * The subtle failure this closes (review #8, finding #1): Playwright does NOT launch
 * the app — it targets an already-running server whose Supabase config comes from that
 * server's OWN environment (.env.local / its startup env), which can DIFFER from
 * Playwright's process env. So checking only process.env is not enough: an unset (or
 * mismatched) Playwright env could pass while the app itself talks to production, and
 * the mock route patterns — keyed to Playwright's env — would simply not match, letting
 * real requests through. We therefore probe the RUNNING APP and assert on what it is
 * actually configured with.
 */
import type { FullConfig } from "@playwright/test";

const PRODUCTION_SUPABASE_REF = "jaxteelkecvlozdrdoog";
const SUPABASE_URL_RE = /https:\/\/([a-z0-9]{16,})\.supabase\.co/g;

function fail(msg: string): never {
  throw new Error(`E2E global-setup: ${msg} Refusing to start.`);
}

function assertNotProduction(where: string, url: string): void {
  if (url.includes(PRODUCTION_SUPABASE_REF)) {
    fail(
      `${where} points at the PRODUCTION Supabase project (${PRODUCTION_SUPABASE_REF}). ` +
        `The browser suite can issue writes; use the isolated TEST project (web/.env.test.local).`,
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // 1) Whatever Playwright's env says, it must not be production.
  const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (envUrl) assertNotProduction("NEXT_PUBLIC_SUPABASE_URL", envUrl);

  // 2) Probe the RUNNING APP and check the Supabase project it actually uses. This is
  //    the authoritative source — the app's bundle embeds NEXT_PUBLIC_SUPABASE_URL, so
  //    a production build reveals itself here even if Playwright's env is unset or points
  //    elsewhere.
  const baseURL =
    process.env.PLAYWRIGHT_TEST_BASE_URL ||
    config.projects.find(p => p.use?.baseURL)?.use?.baseURL ||
    "http://localhost:3000";

  let html = "";
  try {
    const res = await fetch(baseURL, { redirect: "follow" });
    html = await res.text();
  } catch {
    // Server not reachable at setup time. Don't fail closed on a connection error — a
    // spec that truly needs the server will fail on its own — but we also cannot verify
    // isolation, so require an explicit, non-production env instead as the fallback
    // guarantee.
    if (!envUrl) {
      fail(
        "cannot reach the app under test to verify its Supabase target, and " +
          "NEXT_PUBLIC_SUPABASE_URL is not set. Set it to the TEST project so isolation can be asserted.",
      );
    }
    return;
  }

  const refs = new Set<string>();
  for (const m of html.matchAll(SUPABASE_URL_RE)) refs.add(m[1]);
  for (const ref of refs) assertNotProduction(`the running app (${baseURL})`, `https://${ref}.supabase.co`);

  // 3) If we could read the app's ref AND Playwright has an env, they must agree — a
  //    mismatch means the mock route patterns won't match the app's real requests.
  if (envUrl && refs.size > 0) {
    const envRef = envUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
    if (envRef && !refs.has(envRef)) {
      fail(
        `NEXT_PUBLIC_SUPABASE_URL (${envRef}) does not match the running app's Supabase ` +
          `project (${[...refs].join(", ")}). Route mocks keyed to the env would not match the ` +
          `app's real requests, so mocked specs could reach a real database.`,
      );
    }
  }
}
