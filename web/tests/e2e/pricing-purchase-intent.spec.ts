import { test, expect, type Page } from "@playwright/test";
import {
  BILLING_DISABLED_SKIP_REASON,
  isBillingEnabled,
  proCtaLocator,
} from "./helpers/billingMode";
import { interceptCreemCheckout, UUID_RE } from "./helpers/creemCheckout";

/**
 * Purchase-intent preservation across auth.
 *
 * ── BILLING SWITCH (CREEM_MODE) ──────────────────────────────────────────────
 * Every assertion below about a paid CTA presupposes that checkout is TURNED ON.
 * The server reads `CREEM_MODE` (web/src/lib/server/creem/billingMode.ts); the
 * legal values are `disabled` | `test` | `live`, and anything unset/unrecognized
 * resolves to `disabled` — the safe default.
 *
 * With `disabled`, /pricing server-renders every paid tier as a *disabled*
 * "Coming soon" button and `handlePlanCta` returns immediately (no signup route,
 * no checkout call). That is correct product behaviour, not a bug — so the
 * checkout-dependent cases here SKIP rather than pretend to pass. They are
 * gated on a runtime probe (`helpers/billingMode.ts`) instead of on env vars,
 * because the dev server's env is not visible to the test process.
 *
 * To run the full paid coverage locally, set `CREEM_MODE=test` in web/.env.local
 * (sandbox billing; `live` is rejected outside production by
 * assertBillingModeUsable) and restart the dev server.
 *
 * The intent/redirect-safety cases ("plain Log in", "malicious next") do NOT
 * touch checkout and always run.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── HOW CHECKOUT IS OBSERVED (Creem, full-page redirect) ─────────────────────
 * The bug this guards against: an anonymous visitor could start checkout
 * directly, so the billing webhook received no userId and the resulting
 * subscription could not be linked back to a Supabase user.
 *
 * Under Paddle that was an overlay (`Paddle.Checkout.open({ customData })`) and
 * these tests stubbed the SDK to capture its argument. Creem is a HOSTED page:
 * `pricing-client.tsx` POSTs `{ plan, interval }` to
 * `/api/billing/creem/checkout` and then does `window.location.assign(url)` —
 * a real navigation, with no client-side call object to inspect.
 *
 * So "checkout opened" is now observed at OUR OWN API seam: helpers/creemCheckout
 * intercepts that POST, records `{ plan, interval }` plus the
 * `Authorization: Bearer <supabase JWT>` it carries, and answers with a
 * same-origin fake checkout URL so the redirect stays inside the test.
 * "Checkout never opened" is therefore `requests.length === 0`, and this holds
 * even for the anonymous cases: if the client ever tried to start a checkout,
 * the interceptor would see it whether or not the user was logged in.
 *
 * LESSON LEARNED: assertions about *how a third-party SDK is invoked* die with
 * the SDK. All three signed-in cases here had to be rewritten from scratch when
 * billing moved Paddle → Creem, and they failed loudly ("Execution context was
 * destroyed") rather than usefully. Assert instead that OUR SERVER RECEIVES THE
 * RIGHT PARAMETERS — that boundary is ours, so the test survives the next
 * provider swap.
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

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000";

/**
 * Click the Pro plan's CTA.
 *
 * The button's label flips to "Loading…" while a click is parked waiting for
 * auth, so matching on the literal "Start Pro" text is racy. Wait for the page
 * to settle into its resolved state (button enabled, showing its real label)
 * before clicking.
 */
async function clickStartPro(page: Page) {
  const cta = proCtaLocator(page);
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

/**
 * Every case inside this block clicks a PAID tier CTA. When CREEM_MODE resolves
 * to "disabled" that button is server-rendered as a disabled "Coming soon" and
 * there is no signup route / checkout call to assert — so the whole group skips
 * with an explicit reason instead of failing or being weakened.
 */
test.describe("paid checkout intent (requires CREEM_MODE=test|live)", () => {
  test.beforeEach(async ({ browser }) => {
    test.skip(!(await isBillingEnabled(browser)), BILLING_DISABLED_SKIP_REASON);
  });

  // ── Scenario A + B: anonymous CTA carries plan + period to signup ──────────────

  for (const [label, yearly, expectedPeriod] of [
    ["monthly", false, "month"],
    ["yearly", true, "year"],
  ] as const) {
    test(`anonymous "Start Pro" (${label}) routes to signup with intent, never opens checkout`, async ({ page }) => {
      const checkout = await interceptCreemCheckout(page, BASE_URL);
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

      // The whole point: an anonymous visitor must never reach the checkout API.
      expect(checkout.requests).toHaveLength(0);
    });
  }

  // ── Race: a click that lands before auth resolves must be parked, not dropped ─

  test("clicking Start Pro before auth resolves still reaches signup", async ({ page }) => {
    const checkout = await interceptCreemCheckout(page, BASE_URL);

    // Stall the session lookup so the click is guaranteed to land while
    // `authReady` is still false — the exact window where the CTA used to be
    // swallowed (or wrongly reported checkout as unavailable).
    await page.route("**/auth/v1/user**", async route => {
      await new Promise(r => setTimeout(r, 3_000));
      await route.continue();
    });

    await page.goto("/pricing", { waitUntil: "networkidle" });

    const cta = proCtaLocator(page);
    await cta.waitFor({ state: "visible" });
    await cta.click(); // deliberately early — auth is still in flight

    // The intent must be parked and replayed once auth resolves, not discarded.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/signup");

    const url = new URL(page.url());
    expect(url.searchParams.get("plan")).toBe("pro");
    expect(url.searchParams.get("next")).toContain("checkout");

    // A pending auth state must never be misreported as a broken checkout.
    expect(await page.getByText(/temporarily unavailable/i).count()).toBe(0);
    expect(checkout.requests).toHaveLength(0);
  });

  // ── Scenario C: an existing user going signup → login keeps the intent ────────

  test('signup\'s "Sign in" link forwards the purchase intent to login', async ({ page }) => {
    const checkout = await interceptCreemCheckout(page, BASE_URL);
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
    expect(checkout.requests).toHaveLength(0);
  });

}); // end: paid checkout intent

// ── Scenario D: a plain Log in has no intent and must not open checkout ───────
// Billing-agnostic: asserts only the `next` the nav's Log in link carries.

test('plain "Log in" from pricing carries no checkout intent', async ({ page }) => {
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

// ── Scenarios C + B end-to-end: signed-in resume starts checkout for real ─────

test.describe("signed-in resume", () => {
  test.skip(
    !CREDS.email || !CREDS.password,
    "needs E2E_USER_EMAIL / E2E_USER_PASSWORD",
  );

  // Resuming an intent means STARTING checkout — meaningless with billing off,
  // where /pricing?checkout=pro deliberately shows "coming soon" and scrubs the
  // URL without ever calling the checkout endpoint.
  test.beforeEach(async ({ browser }) => {
    test.skip(!(await isBillingEnabled(browser)), BILLING_DISABLED_SKIP_REASON);
  });

  for (const [label, period] of [
    ["monthly", "month"],
    ["yearly", "year"],
  ] as const) {
    test(`email login resumes Pro ${label} checkout with a real Supabase userId`, async ({ page }) => {
      const checkout = await interceptCreemCheckout(page, BASE_URL);

      const intent = `/pricing?checkout=pro&period=${period}`;
      await page.goto(`/login?next=${encodeURIComponent(intent)}`, { waitUntil: "domcontentloaded" });
      await loginViaForm(page);

      // Must land back on pricing, not /app/studio — the intent wins.
      await page.waitForURL(/\/pricing/, { timeout: 30_000 });

      // Auto-checkout fires once auth resolves: exactly one POST to our endpoint.
      await expect.poll(() => checkout.requests.length, { timeout: 30_000 }).toBe(1);

      const [call] = checkout.requests;

      // Plan fidelity + period fidelity: a yearly intent must not silently
      // become monthly. The server maps (plan, interval) to the Creem product id
      // from its own env allowlist, so these two fields fully determine what the
      // buyer is charged for.
      //
      // KNOWN FAILING (yearly case) — this is a REAL product bug, deliberately
      // left red rather than weakened. In pricing-client.tsx the auto-resume
      // effect does:
      //     setYearly(period === "year");   // React state — applied next render
      //     void launchCheckout(plan.id);   // same tick
      // but `launchCheckout` is a useCallback over [yearly], so the instance
      // invoked here still closes over the PREVIOUS `yearly` (false). It computes
      // `interval = "month"` and a `?period=year` purchase intent is checked out
      // monthly. Every other assertion on the yearly path passes; only the
      // interval is wrong. Fix belongs in the product (e.g. pass the interval
      // into launchCheckout explicitly instead of reading it from state), which
      // is out of scope for this test-only change.
      expect(call.body.plan).toBe("pro");
      expect(call.body.interval).toBe(period);

      // THE assertion this whole flow exists for: a REAL Supabase user id is
      // attached to the checkout.
      //
      // Under Creem the userId is NOT in the request body — the route handler
      // (src/app/api/billing/creem/checkout/route.ts) derives it server-side via
      // getUserIdFromBearerOrCookies() and puts it in Creem's metadata.userId.
      // The closest thing a browser test can observe is the credential the client
      // sends, which is precisely what the server resolves: the bearer is the
      // Supabase access token, and the server's auth.getUser(token).user.id is
      // that JWT's `sub`. So asserting the bearer's `sub` is a UUID asserts the
      // exact value that will reach the billing webhook — not a proxy for it.
      expect(call.authorization).toMatch(/^Bearer .+/);
      expect(call.bearerUserId).toBeTruthy();
      expect(call.bearerUserId!).toMatch(UUID_RE);

      // Checkout is a full-page redirect to the hosted page (here: our
      // same-origin stand-in). Landing there proves the flow actually launched
      // rather than dying after the API call.
      await page.waitForURL(u => u.toString().startsWith(checkout.fakeCheckoutUrl), {
        timeout: 20_000,
      });

      // Coming BACK to /pricing (as a buyer who abandons checkout does) must not
      // re-fire: the resume URL was scrubbed before the redirect, so the plain
      // /pricing has no intent left to replay.
      await page.goto("/pricing", { waitUntil: "networkidle" });
      await page.waitForTimeout(4_000);
      expect(checkout.requests).toHaveLength(1);
      expect(new URL(page.url()).search).toBe("");
    });
  }

});

// A purely negative assertion — "no intent ⇒ no checkout" must hold with billing
// on OR off, so this one is deliberately NOT gated on the billing posture.
test.describe("signed-in, no intent", () => {
  test.skip(
    !CREDS.email || !CREDS.password,
    "needs E2E_USER_EMAIL / E2E_USER_PASSWORD",
  );

  test("signed-in user with no intent lands on pricing without a checkout", async ({ page }) => {
    const checkout = await interceptCreemCheckout(page, BASE_URL);
    await page.goto(`/login?next=${encodeURIComponent("/pricing")}`, { waitUntil: "domcontentloaded" });
    await loginViaForm(page);
    await page.waitForURL(/\/pricing/, { timeout: 30_000 });
    await page.waitForTimeout(4_000); // give any stray auto-checkout a chance to fire
    expect(checkout.requests).toHaveLength(0);
  });
});
