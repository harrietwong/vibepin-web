import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/** Where auth.setup.ts stores the signed-in browser state that specs reuse. */
export const STORAGE_STATE = path.join(process.cwd(), "tests", ".auth", "user.json");

export default defineConfig({
  testDir: "./tests/e2e",
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
    // auth.setup.ts signs in once and writes tests/.auth/user.json. It was previously
    // in testIgnore and no project referenced storageState, so the file was produced
    // and then never consumed: `npm run test:e2e` opened an anonymous context and the
    // authenticated specs only passed under a hand-configured local invocation. Wiring
    // it as a dependency makes an authenticated run reproducible from this ref alone.
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
});
