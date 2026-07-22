/**
 * test-db-config.ts — target resolution for the real-Postgres integration channel.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THIS FILE'S ONLY JOB IS TO MAKE IT IMPOSSIBLE TO WRITE TO PRODUCTION.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every other test in this repo talks to in-memory fakes, so "which database" was
 * never a question anyone had to get right. This channel writes real rows, and the
 * default Supabase client (`@/lib/supabase`) reads NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY — which in any developer's `.env.local` point at
 * PRODUCTION. A harness that merely "forgot" to override them would silently
 * hammer the live database with test rows and still print green.
 *
 * So target resolution here obeys four rules, in this order:
 *
 *   1. TEST-ONLY VARIABLE NAMES. The target comes from TEST_SUPABASE_* and nothing
 *      else. There is deliberately NO fallback to NEXT_PUBLIC_SUPABASE_URL or
 *      SUPABASE_SERVICE_ROLE_KEY — not even "if the test one is missing". A
 *      fallback is exactly the bug this file exists to prevent.
 *   2. ABSENT CREDENTIALS ARE A LOUD FAILURE. Missing config throws. It never
 *      skips, never warns-and-continues, never returns a stub. A green run that
 *      did nothing is the failure mode this whole phase exists to eliminate.
 *   3. HARD PROD-REF DENYLIST. The production ref is hardcoded below and asserted
 *      against the resolved URL, the resolved ref, AND the ref embedded in the
 *      service-role JWT. Pointing TEST_SUPABASE_URL at production is a fatal error
 *      even if someone does it deliberately.
 *   4. REF AGREEMENT. The URL host, the declared ref and the JWT's own `ref` claim
 *      must all name the SAME project. A service key from project A aimed at
 *      project B's URL is a misconfiguration that would otherwise fail in confusing
 *      ways deep inside a test.
 *
 * Credentials live in `web/.env.test.local` (git-ignored by the root `.env.*`
 * rule). See `web/.env.example` for the variable names.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The PRODUCTION project ref. Hardcoded on purpose: a denylist that reads its own
 * forbidden value out of the environment can be disarmed by the same
 * misconfiguration it is supposed to catch.
 *
 * If production is ever migrated to a new project, ADD the new ref here — never
 * replace, because the old ref may still hold real data.
 */
export const FORBIDDEN_PROJECT_REFS: readonly string[] = ["jaxteelkecvlozdrdoog"];

/** Where test credentials are read from, relative to `web/`. */
const TEST_ENV_FILE = ".env.test.local";

export type TestDbConfig = {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
  projectRef: string;
};

/** Thrown for every configuration problem. Never swallowed by the harness. */
export class TestDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDbConfigError";
  }
}

/**
 * Minimal .env parser — no dependency, and deliberately does NOT mutate
 * process.env, so loading test credentials cannot leak into anything that reads
 * the ambient environment (notably `@/lib/supabase`, which would then be pointed
 * somewhere its callers do not expect).
 */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

/** Project ref from a Supabase URL host (`https://<ref>.supabase.co`). */
export function refFromUrl(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * The `ref` claim from a Supabase API key JWT. This is the authoritative answer to
 * "which project does this key actually unlock" — independent of whatever URL the
 * config claims. Returns "" for a key that is not a decodable JWT.
 */
export function refFromServiceKey(key: string): string {
  const parts = key.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { ref?: unknown };
    return typeof payload.ref === "string" ? payload.ref : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the integration-test target, or THROW.
 *
 * Precedence: process.env wins over `.env.test.local`, so CI can inject secrets
 * without a file. Neither source may fall back to the production variables.
 */
export function loadTestDbConfig(cwd: string = process.cwd()): TestDbConfig {
  const fileEnv = parseEnvFile(join(cwd, TEST_ENV_FILE));
  const pick = (name: string): string =>
    (process.env[name] ?? fileEnv[name] ?? "").trim();

  const url = pick("TEST_SUPABASE_URL");
  const serviceRoleKey = pick("TEST_SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = pick("TEST_SUPABASE_ANON_KEY");
  const declaredRef = pick("TEST_SUPABASE_PROJECT_REF");

  // ── Rule 2: absent credentials are a loud failure, never a skip ──────────────
  const missing = [
    !url && "TEST_SUPABASE_URL",
    !serviceRoleKey && "TEST_SUPABASE_SERVICE_ROLE_KEY",
    !anonKey && "TEST_SUPABASE_ANON_KEY",
    !declaredRef && "TEST_SUPABASE_PROJECT_REF",
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    throw new TestDbConfigError(
      `Missing test-database credentials: ${missing.join(", ")}.\n` +
        `\n` +
        `This harness talks to a REAL Postgres database and deliberately has NO\n` +
        `fallback to NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — those\n` +
        `point at PRODUCTION. It fails instead of skipping, because a green run\n` +
        `that silently tested nothing is worse than a red one.\n` +
        `\n` +
        `Fix: create web/${TEST_ENV_FILE} (git-ignored) with the TEST_SUPABASE_*\n` +
        `variables documented in web/.env.example, pointing at the ISOLATED test\n` +
        `project — never at production.`,
    );
  }

  const urlRef = refFromUrl(url);
  const keyRef = refFromServiceKey(serviceRoleKey);

  if (!urlRef) {
    throw new TestDbConfigError(`TEST_SUPABASE_URL is not a valid Supabase URL: ${url}`);
  }

  // ── Rule 3: hard prod denylist, checked against all three identity sources ───
  for (const [label, ref] of [
    ["TEST_SUPABASE_URL host", urlRef],
    ["TEST_SUPABASE_PROJECT_REF", declaredRef],
    ["the service-role key's own JWT `ref` claim", keyRef],
  ] as const) {
    if (ref && FORBIDDEN_PROJECT_REFS.includes(ref)) {
      throw new TestDbConfigError(
        `REFUSING TO RUN: ${label} resolves to "${ref}", which is a PRODUCTION\n` +
          `project. The integration harness writes and deletes real rows and must\n` +
          `never be aimed at production. Point TEST_SUPABASE_* at the isolated test\n` +
          `project instead.`,
      );
    }
  }

  // ── Rule 4: URL, declared ref and key must name the same project ─────────────
  if (declaredRef !== urlRef) {
    throw new TestDbConfigError(
      `Test config disagrees with itself: TEST_SUPABASE_PROJECT_REF="${declaredRef}" ` +
        `but TEST_SUPABASE_URL points at "${urlRef}". Refusing to guess which one is ` +
        `intended.`,
    );
  }
  if (keyRef && keyRef !== urlRef) {
    throw new TestDbConfigError(
      `TEST_SUPABASE_SERVICE_ROLE_KEY belongs to project "${keyRef}" but ` +
        `TEST_SUPABASE_URL points at "${urlRef}". A key from one project aimed at ` +
        `another is a misconfiguration — refusing to run.`,
    );
  }

  return { url, serviceRoleKey, anonKey, projectRef: urlRef };
}

/**
 * Belt-and-braces re-assertion, called again at the moment of first write. The
 * check in loadTestDbConfig runs at startup; this one runs against whatever config
 * object actually reached the writer, so a mutated/overridden config still cannot
 * land on production.
 */
export function assertNotProduction(config: TestDbConfig): void {
  const refs = [config.projectRef, refFromUrl(config.url), refFromServiceKey(config.serviceRoleKey)];
  for (const ref of refs) {
    if (ref && FORBIDDEN_PROJECT_REFS.includes(ref)) {
      throw new TestDbConfigError(
        `ABORTING BEFORE WRITE: resolved target "${ref}" is a PRODUCTION project.`,
      );
    }
  }
}
