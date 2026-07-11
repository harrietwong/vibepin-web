/**
 * Shopify Admin GraphQL client (server-only, WP3).
 *
 * One thin fetch wrapper around POST https://{shop}/admin/api/{version}/graphql.json
 * with the X-Shopify-Access-Token header and a 15s timeout. Callers pass query +
 * (validated) variables — user input NEVER goes into the query string; the cursor
 * and page size travel as GraphQL variables (§ hard constraint).
 *
 * Errors are typed so the sync engine can react per §3.4 / §3.8:
 *   401 / 403                       → ShopifyAuthError    (caller sets reauth_required)
 *   429 | errors[].extensions.code
 *        === "THROTTLED"            → ShopifyThrottledError (caller backs off ≤2s / retries)
 *   anything else (5xx, network,
 *        GraphQL userErrors)        → ShopifyUpstreamError (caller → error state, cursor kept)
 *
 * The access token is never logged or echoed into an error message.
 */

import { getShopifyApiVersion } from "./config";

const ADMIN_TIMEOUT_MS = 15_000;

/** Shopify's leaky-bucket state (extensions.cost.throttleStatus). */
export type ThrottleStatus = {
  currentlyAvailable: number | null;
  restoreRate: number | null;
};

export type AdminGraphqlResult<T> = {
  data: T;
  /** null when Shopify omitted extensions.cost (e.g. some error envelopes). */
  cost: ThrottleStatus | null;
};

// ── Typed errors ──────────────────────────────────────────────────────────────

/** Token rejected (401/403) — the connection must be flagged reauth_required. */
export class ShopifyAuthError extends Error {
  code = "shopify_auth" as const;
  status?: number;
  constructor(message = "Shopify rejected the access token", status?: number) {
    super(message);
    this.name = "ShopifyAuthError";
    this.status = status;
  }
}

/** Rate limited (HTTP 429 or a THROTTLED GraphQL error). Carries the cost snapshot. */
export class ShopifyThrottledError extends Error {
  code = "shopify_throttled" as const;
  cost: ThrottleStatus | null;
  constructor(message = "Shopify Admin API throttled", cost: ThrottleStatus | null = null) {
    super(message);
    this.name = "ShopifyThrottledError";
    this.cost = cost;
  }
}

/** Any other upstream failure: 5xx, network/abort, invalid JSON, non-throttle GraphQL errors. */
export class ShopifyUpstreamError extends Error {
  code = "shopify_upstream" as const;
  status?: number;
  constructor(message = "Shopify Admin API request failed", status?: number) {
    super(message);
    this.name = "ShopifyUpstreamError";
    this.status = status;
  }
}

// ── Response shape helpers ────────────────────────────────────────────────────

type GraphqlEnvelope = {
  data?: unknown;
  errors?: unknown;
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable?: unknown;
        restoreRate?: unknown;
      };
    };
  };
};

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractCost(envelope: GraphqlEnvelope | null): ThrottleStatus | null {
  const t = envelope?.extensions?.cost?.throttleStatus;
  if (!t) return null;
  return {
    currentlyAvailable: numberOrNull(t.currentlyAvailable),
    restoreRate: numberOrNull(t.restoreRate),
  };
}

/** True when a GraphQL errors[] array carries a THROTTLED extension code. */
function hasThrottledError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const code = (e as { extensions?: { code?: unknown } })?.extensions?.code;
    return code === "THROTTLED";
  });
}

/** Compact, token-free summary of GraphQL errors for the sync_error field. */
function summarizeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return "GraphQL error";
  const msgs = errors
    .map((e) => {
      const m = (e as { message?: unknown })?.message;
      return typeof m === "string" ? m : null;
    })
    .filter((m): m is string => Boolean(m));
  const joined = msgs.join("; ") || "GraphQL error";
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

/** Best-effort JSON parse of an error response body for its cost snapshot. */
async function safeCostFromBody(resp: Response): Promise<ThrottleStatus | null> {
  try {
    const json = (await resp.json()) as GraphqlEnvelope;
    return extractCost(json);
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute one Admin GraphQL operation. `variables` is JSON-serialised alongside
 * the query — pass the cursor / page size here, never interpolated into `query`.
 */
export async function adminGraphql<T>(
  shop: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<AdminGraphqlResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(`https://${shop}/admin/api/${getShopifyApiVersion()}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or the 15s abort — both are retriable upstream conditions.
    throw new ShopifyUpstreamError(`Admin GraphQL request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ShopifyAuthError(`Admin GraphQL HTTP ${resp.status}`, resp.status);
  }
  if (resp.status === 429) {
    throw new ShopifyThrottledError("Admin GraphQL throttled (HTTP 429)", await safeCostFromBody(resp));
  }
  if (!resp.ok) {
    throw new ShopifyUpstreamError(`Admin GraphQL HTTP ${resp.status}`, resp.status);
  }

  let json: GraphqlEnvelope;
  try {
    json = (await resp.json()) as GraphqlEnvelope;
  } catch {
    throw new ShopifyUpstreamError("Admin GraphQL returned invalid JSON");
  }

  const cost = extractCost(json);

  if (json.errors) {
    if (hasThrottledError(json.errors)) {
      throw new ShopifyThrottledError("Admin GraphQL throttled", cost);
    }
    throw new ShopifyUpstreamError(`Admin GraphQL errors: ${summarizeErrors(json.errors)}`);
  }

  return { data: json.data as T, cost };
}
