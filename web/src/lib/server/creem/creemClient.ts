/**
 * Minimal server-only fetch wrapper for the Creem API.
 *
 * Verified against the Creem SDK source (armitage-labs/creem_io) and docs.creem.io:
 *   - Base URL: production https://api.creem.io ; test mode https://test-api.creem.io.
 *     Our CREEM_API_KEY is a test-mode key (prefix `creem_test_`), so we route to
 *     the test base URL when the key is a test key. A production key uses the prod
 *     base URL. (Mismatching key/base is a Creem-side 401.)
 *   - Auth: the api key is sent in the `x-api-key` header (NOT Authorization Bearer).
 *   - Create checkout:  POST /v1/checkouts  (snake_case body) → response.checkout_url.
 *   - Customer portal:  POST /v1/customers/billing  { customer_id } → response.customer_portal_link.
 *
 * Server-only: reads process.env.CREEM_API_KEY. NEVER import into client code.
 */

const PROD_BASE_URL = "https://api.creem.io";
const TEST_BASE_URL = "https://test-api.creem.io";

/** Resolve the api key + the base URL that matches its mode. Throws when unset. */
function creemConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = (process.env.CREEM_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("CREEM_API_KEY is not set — cannot call the Creem API.");
  }
  // Test-mode keys are prefixed `creem_test_`. Anything else is treated as live.
  const baseUrl = apiKey.startsWith("creem_test_") ? TEST_BASE_URL : PROD_BASE_URL;
  return { apiKey, baseUrl };
}

/** Low-level POST helper. Throws a descriptive error on a non-2xx response. */
async function creemPost<T>(path: string, body: unknown): Promise<T> {
  const { apiKey, baseUrl } = creemConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    // Never cache a billing mutation.
    cache: "no-store",
  });
  if (!res.ok) {
    // Read the body for server-side logging only — never surfaced to the client.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Creem POST ${path} failed: ${res.status} ${detail.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export type CreateCheckoutInput = {
  /** Idempotency key for this checkout attempt (crypto.randomUUID()). */
  requestId: string;
  /** Creem product id (prod_…) to charge. */
  productId: string;
  /** Prefills + links the Creem customer to this buyer. */
  customerEmail: string;
  /** Where Creem redirects after a completed payment. */
  successUrl: string;
  /** Opaque metadata echoed on webhook events (we carry { userId }). */
  metadata: Record<string, string>;
};

/**
 * Create a hosted Creem checkout session. Returns the hosted checkout URL the
 * buyer is redirected to. Throws on any upstream failure (caller maps to 502).
 */
export async function createCheckoutSession(
  input: CreateCheckoutInput,
): Promise<{ checkoutUrl: string }> {
  const data = await creemPost<{ checkout_url?: string; checkoutUrl?: string }>(
    "/v1/checkouts",
    {
      request_id: input.requestId,
      product_id: input.productId,
      customer: { email: input.customerEmail },
      success_url: input.successUrl,
      metadata: input.metadata,
    },
  );
  // Raw API is snake_case (checkout_url); accept the camelCase alias defensively.
  const url = data.checkout_url ?? data.checkoutUrl ?? null;
  if (!url) {
    throw new Error("Creem checkout response had no checkout_url.");
  }
  return { checkoutUrl: url };
}

// ── Customer portal ────────────────────────────────────────────────────────────

/**
 * Mint a Creem customer portal link for a customer id (resolved server-side —
 * never from the request). Returns the portal URL. Throws on upstream failure.
 */
export async function createCustomerPortal(
  customerId: string,
): Promise<{ portalUrl: string }> {
  const data = await creemPost<{ customer_portal_link?: string; customerPortalLink?: string }>(
    "/v1/customers/billing",
    { customer_id: customerId },
  );
  const url = data.customer_portal_link ?? data.customerPortalLink ?? null;
  if (!url) {
    throw new Error("Creem portal response had no customer_portal_link.");
  }
  return { portalUrl: url };
}
