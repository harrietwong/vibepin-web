import { test as setup, expect } from "@playwright/test";
import path from "path";

/**
 * Authentication setup.
 *
 * Reads credentials from environment variables:
 *   E2E_USER_EMAIL    — Supabase user email (required)
 *   E2E_USER_PASSWORD — Supabase user password (required)
 *
 * Saves the authenticated browser storage state to .auth/user.json
 * so all other tests can reuse the session without logging in again.
 *
 * Run once before running the full test suite:
 *   E2E_USER_EMAIL=you@example.com E2E_USER_PASSWORD=yourpassword npx playwright test tests/e2e/auth.setup.ts
 */

export const STORAGE_STATE = path.join(process.cwd(), "tests", ".auth", "user.json");

setup("authenticate", async ({ page }) => {
  const email    = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "E2E authentication requires E2E_USER_EMAIL and E2E_USER_PASSWORD environment variables.\n" +
      "Run: $env:E2E_USER_EMAIL='you@example.com'; $env:E2E_USER_PASSWORD='yourpassword'; npx playwright test tests/e2e/auth.setup.ts"
    );
  }

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // React 19 controlled inputs need pressSequentially to fire onChange correctly.
  const emailInput = page.locator('input[type="email"]');
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 50 });

  const passInput = page.locator('input[type="password"]');
  await passInput.click();
  await passInput.pressSequentially(password, { delay: 50 });

  // Submit.
  await page.locator('button[type="submit"]').click();

  // Wait for redirect to app — up to 15 s for Supabase to respond.
  await page.waitForURL("**/app/**", { timeout: 15000 });
  expect(page.url()).toContain("/app/");

  // Save the storage state (cookies + localStorage) so tests can reuse it.
  await page.context().storageState({ path: STORAGE_STATE });
});
