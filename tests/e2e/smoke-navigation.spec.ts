import { test, expect } from "@playwright/test";

/**
 * Smoke navigation tests.
 *
 * Requires the app to be running at http://localhost:3000 and
 * a valid Supabase session stored in .auth/user.json (see README).
 *
 * To generate the session file run:
 *   npx playwright test --headed tests/e2e/auth.setup.ts
 *
 * Until auth is wired up these tests navigate directly to authenticated
 * routes — if the server redirects to /login the assertions will fail
 * with a clear message.
 */

const ROUTES = [
  { name: "Workspace",       path: "/app/workspace/home-decor", textCheck: /workspace|opportunity/i },
  { name: "Weekly Plan",     path: "/app/plan",                  textCheck: /weekly plan/i           },
  { name: "Create Pins",     path: "/app/studio",                textCheck: /create pin/i            },
  { name: "Generated Pins",  path: "/app/history",               textCheck: /generated pins/i        },
  { name: "Keyword Trends",  path: "/app/trends",                textCheck: /keyword tool/i          },
  { name: "Pin Opportunities", path: "/app/discover",            textCheck: /discover|opportunities/i},
  { name: "Product Signals", path: "/app/products",              textCheck: /product/i               },
];

test.describe("Smoke Navigation", () => {

  // Visit the first app page before each test so the sidebar is rendered.
  test.beforeEach(async ({ page }) => {
    await page.goto("/app/workspace/home-decor", { waitUntil: "domcontentloaded" });
  });

  test("sidebar is always visible", async ({ page }) => {
    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar).toBeVisible();
  });

  test("sidebar has no duplicate nav labels", async ({ page }) => {
    const sidebar = page.getByTestId("app-sidebar");
    const labels = await sidebar.locator("nav a span").allTextContents();
    const unique = new Set(labels.map(l => l.trim()));
    expect(labels.length, "Duplicate nav items detected").toBe(unique.size);
    expect(labels.filter(l => l.trim() === "Keyword Trends").length, "Keyword Trends appears more than once").toBe(1);
  });

  for (const { name, path, textCheck } of ROUTES) {
    test(`navigates to ${name}`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });

      // Should not be on login page (E2E_TEST_MODE bypasses auth in proxy.ts).
      const url = page.url();
      expect(url, `${name}: still on login — is E2E_TEST_MODE=true in .env.local and did you restart the dev server?`).not.toContain("/login");

      // Check page rendered some expected content.
      const body = await page.textContent("body");
      expect(body, `${name}: page body is empty`).toBeTruthy();
      // Use a flexible check — the text pattern must appear somewhere.
      await expect(page.locator("body")).toContainText(textCheck, { timeout: 8000 });

      // Sidebar must remain visible after navigation.
      const sidebar = page.getByTestId("app-sidebar");
      await expect(sidebar).toBeVisible();
    });
  }

  test("no page-level crash (no error boundary text)", async ({ page }) => {
    const errorPhrases = ["Something went wrong", "Unexpected error", "Application error", "ChunkLoadError"];
    for (const { name, path } of ROUTES) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      for (const phrase of errorPhrases) {
        const count = await page.locator(`text=${phrase}`).count();
        expect(count, `${name}: "${phrase}" found on page`).toBe(0);
      }
    }
  });

  test("no duplicate app-sidebar elements", async ({ page }) => {
    const count = await page.getByTestId("app-sidebar").count();
    expect(count, "Multiple sidebars rendered").toBe(1);
  });

});
