import type { Page, Route } from "@playwright/test";

/**
 * Test double for the Creem checkout launch.
 *
 * ── WHY THIS EXISTS (and what replaced what) ─────────────────────────────────
 * Checkout used to be Paddle: `paddle.Checkout.open({ items, customData })`
 * opened an in-page OVERLAY and the page never navigated, so the old tests
 * stubbed `window.Paddle.Checkout.open` and asserted on the recorded argument
 * object (above all `customData.userId`).
 *
 * Creem works completely differently (src/app/pricing/pricing-client.tsx):
 *
 *   const url = await startCreemCheckout(plan, interval);  // POST our own API
 *   window.location.assign(url);                           // FULL-PAGE redirect
 *
 * There is no `window.Paddle`, no overlay, and no client-side call object to
 * record. Everything we care about crosses one seam we own: the POST to
 * `/api/billing/creem/checkout` with `{ plan, interval }` and an
 * `Authorization: Bearer <supabase access token>` header. So we intercept THAT
 * request, assert on it, and fulfil it with a harmless same-origin URL so the
 * subsequent `location.assign` lands somewhere controlled instead of on the real
 * hosted Creem page (which would be slow, flaky and would create real sessions).
 *
 * LESSON LEARNED — the reason all three signed-in cases had to be rewritten:
 * they asserted on *how a third-party SDK was called*. When the payment provider
 * changed, every one of those assertions became meaningless (they failed with
 * "Execution context was destroyed" because the page now navigates). Asserting
 * that OUR OWN SERVER RECEIVES THE RIGHT PARAMETERS is provider-agnostic: it
 * survives Paddle → Creem → whatever comes next, because the invariant being
 * protected ("the buyer's plan/interval and identity reach the billing backend
 * intact, exactly once") lives at our API boundary, not inside a vendor SDK.
 */

/** The one endpoint the pricing page calls to start a Creem checkout. */
export const CHECKOUT_API_GLOB = "**/api/billing/creem/checkout";

/** Same-origin landing page we redirect to instead of the real Creem host. */
export const FAKE_CHECKOUT_PATH = "/__fake-creem-checkout";

export type CheckoutRequest = {
  /** Parsed JSON body: what the client asked the server to charge for. */
  body: { plan?: string; interval?: string };
  /** Raw Authorization header, if any — `Bearer <supabase JWT>` when signed in. */
  authorization: string | null;
  /**
   * `sub` claim decoded from the bearer JWT (the Supabase user id), or null when
   * no/undecodable bearer was sent. This is exactly the value the route handler
   * resolves the request to: `getUserIdFromBearerOrCookies` verifies this same
   * token via `auth.getUser(token)` and uses `user.id`, which is the JWT `sub`.
   * Asserting on it is therefore an assertion about the userId the server will
   * put into Creem's `metadata.userId`.
   */
  bearerUserId: string | null;
};

/** Decode a JWT payload without verifying it (test-side inspection only). */
function decodeJwtSub(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const sub = (JSON.parse(payload) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

export type CheckoutInterceptor = {
  /** Every checkout POST observed, in order. Length is the "exactly once" check. */
  requests: CheckoutRequest[];
  /** Absolute URL the app is told to redirect to (same-origin, controlled). */
  fakeCheckoutUrl: string;
};

/**
 * Intercept the checkout API and the fake redirect target.
 *
 * The checkout POST is answered locally (never forwarded), so no real Creem
 * session is created and the test is independent of Creem's availability. The
 * returned URL is same-origin and is itself intercepted with a tiny HTML stub so
 * the redirect resolves instantly and deterministically.
 */
export async function interceptCreemCheckout(
  page: Page,
  baseUrl: string,
): Promise<CheckoutInterceptor> {
  const state: CheckoutInterceptor = {
    requests: [],
    fakeCheckoutUrl: new URL(FAKE_CHECKOUT_PATH, baseUrl).toString(),
  };

  await page.route(CHECKOUT_API_GLOB, async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    let body: { plan?: string; interval?: string } = {};
    try {
      body = JSON.parse(request.postData() ?? "{}");
    } catch {
      /* leave empty — the assertions will report the mismatch */
    }
    const authorization = (await request.headerValue("authorization")) ?? null;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : null;
    state.requests.push({
      body,
      authorization,
      bearerUserId: token ? decodeJwtSub(token) : null,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: state.fakeCheckoutUrl }),
    });
  });

  await page.route(`**${FAKE_CHECKOUT_PATH}**`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>fake checkout</title><body>fake creem checkout</body>",
    });
  });

  return state;
}

/** Supabase user ids are UUIDs — the shape the billing webhook must be able to link. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
