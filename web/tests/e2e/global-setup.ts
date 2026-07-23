/**
 * Global, import-independent isolation guard for the E2E suite.
 *
 * Playwright runs this once before ANY project or spec. Unlike a guard inside a
 * helper module (which only fires for specs that import it), this cannot be bypassed
 * by a spec that hardcodes its own Supabase URL — every run passes through here.
 *
 * The rule (.claude/CLAUDE.md "测试环境隔离"): the production project
 * (jaxteelkecvlozdrdoog) must never be the target of a browser suite that can issue
 * writes. If the app under test is pointed at production, fail the whole run closed.
 */
import type { FullConfig } from "@playwright/test";

const PRODUCTION_SUPABASE_REF = "jaxteelkecvlozdrdoog";

export default function globalSetup(_config: FullConfig): void {
  const appUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();

  // If the env is set, it MUST NOT be production. An unset env is allowed here only
  // because many specs fully mock the Supabase layer and never reach a real origin;
  // specs that DO talk to Supabase enforce the presence of a test URL themselves
  // (helpers/studio.ts throws on a missing env). What must never happen silently is
  // a run whose app is configured for production.
  if (appUrl && appUrl.includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      `E2E global-setup: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION Supabase ` +
        `project (${PRODUCTION_SUPABASE_REF}). The browser suite can issue writes; run it ` +
        `against the isolated TEST project (web/.env.test.local) instead. Refusing to start.`,
    );
  }
}
