import { test, expect, type Page } from "@playwright/test";
import { PRICING_TIERS } from "../../src/lib/pricingPlans";

/**
 * Purchase-intent preservation across auth.
 *
 * The bug this guards against: an anonymous visitor could open Paddle Checkout
 * directly, so the webhook received no custom_data.userId and the resulting
 * subscription could not be linked back to a Supabase user.
 *
 * Rules enforced here:
 *   1. Anonymous plan CTA never opens checkout — it routes to signup carrying
 *      the plan + period as a `next` that returns to /pricing.
 *   2. Period (month|year) survives the whole pricing → signup → login round trip.
 *   3. A signed-in return to /pricing?checkout=<plan>&period=<p> auto-opens
 *      checkout with a real userId in customData, exactly once, and scrubs the URL.
 *   4. A plain "Log in" (no intent) returns to /pricing WITHOUT opening checkout.
 *   5. `next` cannot be used for an open redirect.
 *
 * Requires a dev server started WITHOUT E2E_TEST_MODE=true, otherwise the proxy
 * auth guard is bypassed and the redirect assertions are meaningless.
 *
 * The signed-in ("signed-in resume") cases need E2E_USER_EMAIL /
 * E2E_USER_PASSWORD env vars pointing at a real Supabase account — without
 * them those tests are skipped rather than faked.
 *
 * Load with `waitUntil: "networkidle"`, not "domcontentloaded": the CTA is
 * server-rendered and becomes *visible* long before React hydrates it, so an
 * early click lands on an unbound button and is silently lost. In dev that
 * window is seconds wide.
 *
 * LESSON LEARNED: do not try to fake a Supabase login with a seeded session
 * cookie + a page.route() intercept on /auth/v1/user. It looks plausible
 * (getUser() docs say it re-verifies the JWT against the server) but in
 * practice getUser() rejects a malformed/non-JWT access_token locally and
 * returns null WITHOUT ever issuing the network request — so the route
 * handler never fires and the page renders as anonymous. A test built on
 * this pattern can "pass" once by accident and then reliably fail; the only
 * trustworthy way to cover a signed-in flow here is a real account via
 * loginViaForm() + E2E_USER_EMAIL/PASSWORD.
 */

type CheckoutCall = {
  items: { priceId: string; quantity: number }[];
  customData?: { userId?: string };
  customer?: { email?: string };
};

declare global {
  interface Window {
    __checkoutCalls: CheckoutCall[];
  }
}

/**
 * Stub Paddle before any app code runs. Checkout.open() is recorded instead of
 * opening the real third-party overlay, so we can assert on exactly what the
 * app would have sent to Paddle — above all, customData.userId.
 *
 * `getPaddle()` calls `initializePaddle` from @paddle/paddle-js, which injects
 * Paddle.js from the CDN and then wraps `window.Paddle`. So stubbing the global
 * up-front is not enough (the real script would overwrite it) — we serve our own
 * script from the CDN URL instead, and install the global from there.
 */
async function stubPaddle(page: Page) {
  // Let the real Paddle.js load and initialize (a hand-rolled fake global gets
  // rejected by the SDK's own version check), then hot-swap only Checkout.open
  // so the overlay never actually opens and we capture the exact payload.
  await page.addInitScript(() => {
    window.__checkoutCalls = [];

    let real: unknown;
    Object.defineProperty(window, "Paddle", {
      configurable: true,
      get: () => real,
      set: (incoming: { Checkout?: { open?: unknown } }) => {
        if (incoming?.Checkout) {
          const checkout = incoming.Checkout as { open: (o: CheckoutCall) => void };
          checkout.open = (opts: CheckoutCall) => {
            window.__checkoutCalls.push(opts);
          };
        }
        real = incoming;
      },
    });
  });
}

async function checkoutCalls(page: Page): Promise<CheckoutCall[]> {
  return page.evaluate(() => window.__checkoutCalls ?? []);
}

/**
 * Click the Pro plan's CTA.
 *
 * The button's label flips to "Loading…" while a click is parked waiting for
 * auth/Paddle, so matching on the literal "Start Pro" text is racy. Wait for the
 * page to settle into its resolved state (button enabled, showing its real
 * label) before clicking.
 */
async function clickStartPro(page: Page) {
  const cta = page.getByRole("button", { name: /^(Start Pro|Loading…)$/ }).first();
  await cta.waitFor({ state: "visible" });
  await expect(cta).toBeEnabled({ timeout: 15_000 });
  await expect(cta).toHaveText("Start Pro", { timeout: 15_000 });
  await cta.click();
}

const CREDS = {
  email: process.env.E2E_USER_EMAIL,
  password: process.env.E2E_USER_PASSWORD,
};

async function loginViaForm(page: Page) {
  const emailInput = page.locator('input[type="email"]');
  await emailInput.click();
  await emailInput.pressSequentially(CREDS.email!, { delay: 30 });
  const passInput = page.locator('input[type="password"]');
  await passInput.click();
  await passInput.pressSequentially(CREDS.password!, { delay: 30 });
  await page.locator('button[type="submit"]').click();
}

// ── Scenario A + B: anonymous CTA carries plan + period to signup ──────────────

for (const [label, yearly, expectedPeriod] of [
  ["monthly", false, "month"],
  ["yearly", true, "year"],
] as const) {
  test(`anonymous "Start Pro" (${label}) routes to signup with intent, never opens checkout`, async ({ page }) => {
    await stubPaddle(page);
    await page.goto("/pricing", { waitUntil: "networkidle" });

    if (yearly) {
      // Billing toggle — switch to annual before clicking the plan CTA.
      await page.getByRole("button", { name: /year/i }).first().click();
    }

    await clickStartPro(page);
    // Client-side router.push fires no `load` event, so poll the URL instead of
    // waitForURL (which waits for a navigation that never happens).
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/signup");

    const url = new URL(page.url());
    expect(url.pathname).toBe("/signup");
    expect(url.searchParams.get("plan")).toBe("pro");

    // The intent must survive as a decodable relative path back to /pricing.
    const next = url.searchParams.get("next");
    expect(next).toBeTruthy();
    const nextUrl = new URL(next!, "http://localhost");
    expect(nextUrl.pathname).toBe("/pricing");
    expect(nextUrl.searchParams.get("checkout")).toBe("pro");
    expect(nextUrl.searchParams.get("period")).toBe(expectedPeriod);

    // The whole point: an anonymous visitor must never reach Paddle.
    expect(await checkoutCalls(page)).toHaveLength(0);
  });
}

// ── Race: a click that lands before auth resolves must be parked, not dropped ─

test("clicking Start Pro before auth resolves still reaches signup", async ({ page }) => {
  await stubPaddle(page);

  // Stall the session lookup so the click is guaranteed to land while
  // `authReady` is still false — the exact window where the CTA used to be
  // swallowed (or wrongly reported checkout as unavailable).
  await page.route("**/auth/v1/user**", async route => {
    await new Promise(r => setTimeout(r, 3_000));
    await route.continue();
  });

  await page.goto("/pricing", { waitUntil: "networkidle" });

  const cta = page.getByRole("button", { name: /^(Start Pro|Loading…)$/ }).first();
  await cta.waitFor({ state: "visible" });
  await cta.click(); // deliberately early — auth is still in flight

  // The intent must be parked and replayed once auth resolves, not discarded.
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/signup");

  const url = new URL(page.url());
  expect(url.searchParams.get("plan")).toBe("pro");
  expect(url.searchParams.get("next")).toContain("checkout");

  // A pending auth state must never be misreported as a broken checkout.
  expect(await page.getByText(/temporarily unavailable/i).count()).toBe(0);
  expect(await checkoutCalls(page)).toHaveLength(0);
});

// ── Scenario C: an existing user going signup → login keeps the intent ────────

test('signup\'s "Sign in" link forwards the purchase intent to login', async ({ page }) => {
  await stubPaddle(page);
  await page.goto("/pricing", { waitUntil: "networkidle" });
  await clickStartPro(page);
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/signup");

  await page.getByRole("link", { name: /sign in/i }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe("/login");

  const url = new URL(page.url());
  expect(url.pathname).toBe("/login");
  const next = url.searchParams.get("next");
  const nextUrl = new URL(next!, "http://localhost");
  expect(nextUrl.pathname).toBe("/pricing");
  expect(nextUrl.searchParams.get("checkout")).toBe("pro");
  expect(await checkoutCalls(page)).toHaveLength(0);
});

// ── Scenario D: a plain Log in has no intent and must not open checkout ───────

test('plain "Log in" from pricing carries no checkout intent', async ({ page }) => {
  await stubPaddle(page);
  await page.goto("/pricing", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /^log in$/i }).click();
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  const url = new URL(page.url());
  expect(url.searchParams.get("next")).toBe("/pricing");
  // No checkout param anywhere — a plain login must not resume a purchase.
  expect(url.searchParams.get("next")).not.toContain("checkout");
});

// ── Security: `next` must not become an open redirect ─────────────────────────

test("malicious next values fall back to /app/studio, never off-site", async ({ page }) => {
  for (const evil of ["//evil.com", "https://evil.com", "/\\evil.com"]) {
    await page.goto(`/login?next=${encodeURIComponent(evil)}`, { waitUntil: "domcontentloaded" });
    // The rejected value must not survive into the signup cross-link, which is
    // built from the sanitized `next`.
    const signupHref = await page.getByRole("link", { name: /start free trial/i }).getAttribute("href");
    expect(signupHref).toContain("next=%2Fapp%2Fstudio");
    expect(signupHref).not.toContain("evil.com");
  }
});

// ── Scenarios C + B end-to-end: signed-in resume opens checkout with a real id ─

test.describe("signed-in resume", () => {
  test.skip(
    !CREDS.email || !CREDS.password,
    "needs E2E_USER_EMAIL / E2E_USER_PASSWORD",
  );

  for (const [label, period, priceKey] of [
    ["monthly", "month", "month"],
    ["yearly", "year", "year"],
  ] as const) {
    test(`email login resumes Pro ${label} checkout with a real Supabase userId`, async ({ page }) => {
      await stubPaddle(page);

      const intent = `/pricing?checkout=pro&period=${period}`;
      await page.goto(`/login?next=${encodeURIComponent(intent)}`, { waitUntil: "domcontentloaded" });
      await loginViaForm(page);

      // Must land back on pricing, not /app/studio — the intent wins.
      await page.waitForURL(/\/pricing/, { timeout: 30_000 });

      // Auto-checkout fires once Paddle + auth are both ready.
      await expect
        .poll(async () => (await checkoutCalls(page)).length, { timeout: 20_000 })
        .toBe(1);

      const [call] = await checkoutCalls(page);

      // THE assertion this whole change exists for: a real user id reaches Paddle.
      expect(call.customData?.userId).toBeTruthy();
      expect(call.customData!.userId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Period fidelity: the yearly intent must not silently become monthly.
      const pro = PRICING_TIERS.find(t => t.id === "pro")!;
      expect(call.items[0].priceId).toBe(pro.paddlePriceIds![priceKey]);

      // URL is scrubbed so a refresh does not re-open the overlay.
      await expect.poll(async () => new URL(page.url()).search, { timeout: 10_000 }).toBe("");

      // And a reload really does not fire it again.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3_000);
      expect(await checkoutCalls(page)).toHaveLength(0); // fresh page → fresh recorder
      expect(new URL(page.url()).search).toBe("");
    });
  }

  test("signed-in user with no intent lands on pricing without a checkout", async ({ page }) => {
    await stubPaddle(page);
    await page.goto(`/login?next=${encodeURIComponent("/pricing")}`, { waitUntil: "domcontentloaded" });
    await loginViaForm(page);
    await page.waitForURL(/\/pricing/, { timeout: 30_000 });
    await page.waitForTimeout(4_000); // give any stray auto-checkout a chance to fire
    expect(await checkoutCalls(page)).toHaveLength(0);
  });
});
