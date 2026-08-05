/**
 * Start the Next dev server against the TEST Supabase project instead of prod,
 * WITHOUT editing .env.local.
 *
 * Why this works: @next/env does NOT override values already present in
 * process.env when it loads .env.local. So we pre-seed the three Supabase vars
 * (and force the auth guard on) from .env.test.local; everything else still
 * comes from .env.local. Verified: `node -e "@next/env loadEnvConfig ..."`
 * leaves a pre-set process.env var untouched.
 *
 * Use this for any E2E run that must NOT touch the production database — see
 * tests/e2e/TESTING.md. The prod .env.local is never modified.
 *
 *   node scripts/dev-testdb.mjs           # starts dev server on :3000
 *
 * Hard safety: refuses to start unless .env.test.local points at the known test
 * project ref (snulmwprsahzqvdbyenc), so a mis-edited file can't silently boot
 * the "test" server against production.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const TEST_REF = "snulmwprsahzqvdbyenc";
const PROD_MARKERS = ["jaxteelkecvlozdrdoog", "auth.vibepin.co"];

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

let testEnv;
try {
  testEnv = readEnvFile(".env.test.local");
} catch {
  console.error("[dev-testdb] Missing web/.env.test.local (test DB credentials). Aborting.");
  process.exit(1);
}

const url = testEnv.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = testEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const service = testEnv.SUPABASE_SERVICE_ROLE_KEY ?? "";

// ── Safety assertions: the "test" server must point at the test project ──
if (!url.includes(TEST_REF)) {
  console.error(`[dev-testdb] .env.test.local URL is not the test project (${TEST_REF}). Got: ${url}. Aborting.`);
  process.exit(1);
}
if (PROD_MARKERS.some(m => url.includes(m))) {
  console.error(`[dev-testdb] .env.test.local URL looks like PRODUCTION. Aborting.`);
  process.exit(1);
}
if (!anon || !service) {
  console.error("[dev-testdb] .env.test.local missing anon or service_role key. Aborting.");
  process.exit(1);
}

console.log(`[dev-testdb] Starting dev server against TEST project ${TEST_REF}`);
console.log(`[dev-testdb] Supabase URL: ${url}`);
console.log(`[dev-testdb] Auth guard forced ON (E2E_TEST_MODE=false)`);

const child = spawn("npx", ["next", "dev", "--webpack"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    // These take precedence over .env.local because @next/env won't override
    // an already-set process.env value.
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    // The auth-guard redirect assertions are meaningless if the proxy bypass is on.
    E2E_TEST_MODE: "false",
  },
});

child.on("exit", code => process.exit(code ?? 0));
