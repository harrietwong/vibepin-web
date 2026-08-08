import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/** Where auth.setup.ts stores the signed-in browser state that specs reuse. */
export const STORAGE_STATE = path.join(process.cwd(), "tests", ".auth", "user.json");

export default defineConfig({
  testDir: "./tests/e2e",
  // Import-independent isolation guard: refuses to start if the app is pointed at the
  // production Supabase project, no matter which spec runs or what it imports.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  timeout: 60_000,
  use: {
    // Overridable so a test run can target a dedicated dev server instance
    // (e.g. PLAYWRIGHT_TEST_BASE_URL=http://localhost:3001) instead of the
    // shared one on :3000. Default behaviour is unchanged.
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000",
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    // The DEFAULT project is ANONYMOUS — it must stay that way. Almost every spec
    // either performs its own login, mocks the session via E2E_TEST_MODE, or is
    // deliberately anonymous (e.g. pricing-purchase-intent's "routes to signup"
    // cases). A previous round applied storageState to every Chromium spec, which
    // silently pre-authenticated the anonymous ones and inverted their meaning.
    {
      name: "chromium",
      testIgnore: [/auth\.setup\.ts/, /\.auth\.spec\.ts$/],
      use: { ...devices["Desktop Chrome"] },
    },
    // Opt-in authenticated lane. auth.setup.ts signs in once and writes
    // tests/.auth/user.json; only specs named *.auth.spec.ts consume it. This keeps
    // a real authenticated run reproducible from this ref (via the setup dependency)
    // without touching the anonymous coverage above.
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "authenticated",
      testMatch: /\.auth\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
});
